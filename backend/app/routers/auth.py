"""Login, token refresh, logout, and the current-user endpoint."""

import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.limiter import limiter
from app.core.security import (
    create_access_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    verify_password,
)
from app.database import get_db
from app.models import AuditLog, LoginLockout, RefreshToken, User
from app.schemas import LoginRequest, PasswordChangeRequest, SelfProfileUpdate, TokenResponse, UserRead

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE_NAME = "refresh_token"
REFRESH_COOKIE_PATH = "/auth"

# Compared against when no account matches the submitted email, so an unknown
# address still pays bcrypt's cost -- see the note in login(). Hashed from a
# random value at import rather than stored as a literal: nothing may ever
# verify against it, and a real-looking bcrypt string in source reads (to a
# human and to a secret scanner) like a checked-in credential.
_ABSENT_USER_PASSWORD_HASH = hash_password(secrets.token_urlsafe(32))


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        path=REFRESH_COOKIE_PATH,
    )


def _record_login_failure(
    db: Session, user: User, ip: str | None, lockout: LoginLockout | None, now: datetime
) -> bool:
    """Increments this (user, ip) pair's failure count, locking it at 5.
    Returns True if this call is what just crossed the threshold.

    `lockout` is the row login() already looked up (None on the first-ever
    failure for this pair). Creating it here can race a concurrent request
    for the same pair -- both miss the earlier SELECT and both INSERT, only
    one wins the unique constraint -- so the loser rolls back and re-queries
    to find the winner's row instead of surfacing a raw 500.
    """
    if lockout is None:
        lockout = LoginLockout(user_id=user.id, ip_address=ip, failed_login_count=0)
        db.add(lockout)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            lockout = (
                db.query(LoginLockout)
                .filter(LoginLockout.user_id == user.id, LoginLockout.ip_address == ip)
                .one()
            )

    # Incremented in SQL (UPDATE ... SET x = x + 1), not as a Python
    # read-modify-write on the ORM object: `lockout.failed_login_count += 1`
    # silently loses updates under concurrency (two requests read the same
    # snapshot, both compute N+1, second commit overwrites the first). The
    # row lock on an UPDATE expression serializes concurrent writers instead.
    new_count = db.execute(
        update(LoginLockout)
        .where(LoginLockout.id == lockout.id)
        .values(failed_login_count=LoginLockout.failed_login_count + 1)
        .returning(LoginLockout.failed_login_count)
    ).scalar_one()

    just_locked = new_count >= 5
    if just_locked:
        db.execute(update(LoginLockout).where(LoginLockout.id == lockout.id).values(locked_until=now + timedelta(minutes=15)))
    return just_locked


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
def login(request: Request, payload: LoginRequest, response: Response, db: Session = Depends(get_db)) -> TokenResponse:
    """Authenticate with email+password; sets the refresh cookie and returns an access token."""
    now = datetime.now(timezone.utc)
    ip = request.client.host if request.client else None
    user = db.query(User).filter(User.email == payload.email).one_or_none()

    # Lockout is scoped to this (account, source IP) pair -- see LoginLockout's
    # own docstring for why. Looked up once and reused below (failure branch
    # reuses/creates it, success branch resets it).
    lockout = (
        db.query(LoginLockout).filter(LoginLockout.user_id == user.id, LoginLockout.ip_address == ip).one_or_none()
        if user is not None
        else None
    )
    if lockout is not None and lockout.locked_until is not None and lockout.locked_until > now:
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Account locked. Try again later.")

    # Verified unconditionally, against a throwaway hash when no account
    # matched, so response time doesn't disclose whether the email exists --
    # short-circuiting on `user is None` skipped bcrypt and answered ~40x
    # faster for unknown addresses, which timing alone would reveal.
    password_ok = verify_password(
        payload.password, user.password_hash if user is not None else _ABSENT_USER_PASSWORD_HASH
    )

    if user is None or not password_ok:
        just_locked = False
        if user is not None:
            just_locked = _record_login_failure(db, user, ip, lockout, now)
        db.add(
            AuditLog(
                user_id=user.id if user is not None else None,
                event_type="login_failure",
                event_detail={"email": payload.email},
                ip_address=ip,
                user_agent=request.headers.get("user-agent"),
            )
        )
        db.commit()
        if just_locked:
            raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Account locked. Try again later.")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")

    # Only this (account, IP) pair's lockout is cleared on success -- a
    # different IP's accumulated failures against the same account are left
    # alone, so one successful login can't reset an attacker's own counter.
    if lockout is not None:
        lockout.failed_login_count = 0
        lockout.locked_until = None

    if user.status != "active":
        db.add(
            AuditLog(
                user_id=user.id,
                event_type="login_failure",
                event_detail={"reason": "account_not_active", "status": user.status},
                ip_address=ip,
                user_agent=request.headers.get("user-agent"),
            )
        )
        db.commit()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User account is not active")

    user.last_login_at = now
    db.add(
        AuditLog(
            user_id=user.id,
            event_type="login_success",
            ip_address=ip,
            user_agent=request.headers.get("user-agent"),
        )
    )

    access_token = create_access_token(user.id)
    raw_refresh_token = generate_refresh_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_refresh_token(raw_refresh_token),
            expires_at=now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
            ip_address=ip,
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.commit()

    _set_refresh_cookie(response, raw_refresh_token)
    return TokenResponse(access_token=access_token, expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60)


@router.post("/refresh", response_model=TokenResponse)
def refresh(request: Request, response: Response, db: Session = Depends(get_db)) -> TokenResponse:
    """Rotate the refresh cookie and mint a new access token."""
    raw_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if raw_token is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing refresh token")

    now = datetime.now(timezone.utc)
    old_token = (
        db.query(RefreshToken)
        .filter(RefreshToken.token_hash == hash_refresh_token(raw_token))
        .one_or_none()
    )
    if old_token is None or old_token.revoked_at is not None or old_token.expires_at <= now:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    # Account state must be rechecked here, not just when the resulting
    # access token is used -- otherwise a suspended/deleted account can keep
    # rotating its cookie and minting fresh access tokens forever.
    token_user = db.query(User).filter(User.id == old_token.user_id).one_or_none()
    if token_user is None or token_user.status != "active":
        old_token.revoked_at = now
        db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    raw_new_token = generate_refresh_token()
    new_token = RefreshToken(
        user_id=old_token.user_id,
        token_hash=hash_refresh_token(raw_new_token),
        expires_at=now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    db.add(new_token)
    db.flush()

    old_token.revoked_at = now
    old_token.replaced_by = new_token.id
    db.commit()

    _set_refresh_cookie(response, raw_new_token)
    access_token = create_access_token(old_token.user_id)
    return TokenResponse(access_token=access_token, expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> None:
    """Revoke the current refresh token and clear its cookie."""
    raw_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if raw_token is not None:
        token_row = (
            db.query(RefreshToken)
            .filter(RefreshToken.token_hash == hash_refresh_token(raw_token))
            .one_or_none()
        )
        if token_row is not None and token_row.revoked_at is None:
            token_row.revoked_at = datetime.now(timezone.utc)
            db.commit()

    response.delete_cookie(REFRESH_COOKIE_NAME, path=REFRESH_COOKIE_PATH)


@router.get("/me", response_model=UserRead)
def get_me(current_user: User = Depends(get_current_user)) -> User:
    """Return the caller's own account."""
    return current_user


@router.patch("/me", response_model=UserRead)
def update_me(
    payload: SelfProfileUpdate,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """Update the caller's own name."""
    current_user.first_name = payload.first_name
    current_user.last_name = payload.last_name
    db.add(
        AuditLog(
            user_id=current_user.id,
            event_type="profile_updated",
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT)
def change_my_password(
    payload: PasswordChangeRequest,
    request: Request,
    response: Response,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Change the caller's own password; revokes every other session."""
    if not verify_password(payload.current_password, current_user.password_hash):
        # 403, not 401 -- the session is valid, only current_password is
        # wrong. A 401 here would trip the frontend's generic "session
        # expired" handling (lib/api.ts's request()), which force-logs-out
        # on a second 401 -- wrong outcome for a simple wrong-password entry.
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Current password is incorrect")

    if verify_password(payload.new_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password must be different from your current password",
        )

    now = datetime.now(timezone.utc)
    current_user.password_hash = hash_password(payload.new_password)
    current_user.password_changed_at = now

    # An attacker who stole a refresh token loses it the moment the real
    # user notices and changes their password.
    active_tokens = (
        db.query(RefreshToken)
        .filter(RefreshToken.user_id == current_user.id, RefreshToken.revoked_at.is_(None))
        .all()
    )
    for token in active_tokens:
        token.revoked_at = now

    db.add(
        AuditLog(
            user_id=current_user.id,
            event_type="password_changed",
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.commit()

    response.delete_cookie(REFRESH_COOKIE_NAME, path=REFRESH_COOKIE_PATH)
