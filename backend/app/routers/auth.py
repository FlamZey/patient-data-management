"""Login, token refresh, logout, and the current-user endpoint."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.deps import get_current_user
from app.core.limiter import limiter
from app.core.security import (
    create_access_token,
    generate_refresh_token,
    hash_refresh_token,
    verify_password,
)
from app.database import get_db
from app.models import AuditLog, RefreshToken, User
from app.schemas import LoginRequest, TokenResponse, UserRead

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE_NAME = "refresh_token"
REFRESH_COOKIE_PATH = "/auth"


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


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
def login(request: Request, payload: LoginRequest, response: Response, db: Session = Depends(get_db)) -> TokenResponse:
    now = datetime.now(timezone.utc)
    user = db.query(User).filter(User.email == payload.email).one_or_none()

    if user is not None and user.locked_until is not None and user.locked_until > now:
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Account locked. Try again later.")

    if user is None or not verify_password(payload.password, user.password_hash):
        just_locked = False
        if user is not None:
            user.failed_login_count += 1
            if user.failed_login_count >= 5:
                user.locked_until = now + timedelta(minutes=15)
                just_locked = True
        db.add(
            AuditLog(
                user_id=user.id if user is not None else None,
                event_type="login_failure",
                event_detail={"email": payload.email},
                ip_address=request.client.host if request.client else None,
                user_agent=request.headers.get("user-agent"),
            )
        )
        db.commit()
        if just_locked:
            raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Account locked. Try again later.")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")

    # Credentials are correct at this point, so it's safe to reveal account
    # state -- an unauthenticated guesser never reaches this branch.
    user.failed_login_count = 0

    if user.status != "active":
        db.add(
            AuditLog(
                user_id=user.id,
                event_type="login_failure",
                event_detail={"reason": "account_not_active", "status": user.status},
                ip_address=request.client.host if request.client else None,
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
            ip_address=request.client.host if request.client else None,
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
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.commit()

    _set_refresh_cookie(response, raw_refresh_token)
    return TokenResponse(access_token=access_token, expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60)


@router.post("/refresh", response_model=TokenResponse)
def refresh(request: Request, response: Response, db: Session = Depends(get_db)) -> TokenResponse:
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
    return current_user
