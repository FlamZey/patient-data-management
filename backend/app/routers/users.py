"""User management: list/get/create/update/soft-delete.

Authorization is layered and lives in app.core, not here: a permission gate
per endpoint (require_permission / require_any_permission), per-field rules
for privileged fields like role_id/status (authz.authorize_user_*), and
role-hierarchy rules for who may act on whom (authz.assert_can_administer).
"""

from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import asc, desc, false, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, contains_eager

from app.core import authz
from app.core.deps import require_any_permission, require_permission
from app.core.limiter import limiter
from app.core.permissions import Permission
from app.core.security import hash_password
from app.core.text import escape_like
from app.database import get_db
from app.models import AuditLog, Location, RefreshToken, Role, Team, User
from app.schemas import UserCreate, UserListResponse, UserRead, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])

# Which column(s) to ORDER BY per sort_by value -- a tuple since "name" sorts
# on first_name then last_name together.
_SORT_COLUMNS: dict[str, tuple] = {
    "name": (User.first_name, User.last_name),
    "email": (User.email,),
    "role": (Role.display_name,),
    "location": (Location.name,),
    "team": (Team.name,),
    "status": (User.status,),
}


def _get_user_or_404(db: Session, user_id: UUID) -> User:
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def _raise_if_taken(db: Session, *, email: str | None, username: str | None, exclude_id: UUID | None = None) -> None:
    """Field-specific 409 if email/username is already in use. Called twice:
    once as a cheap pre-write check, and again after a caught IntegrityError
    to turn a lost create/update race into the same 409 instead of a 500."""
    if email is not None:
        query = db.query(User).filter(User.email == email)
        if exclude_id is not None:
            query = query.filter(User.id != exclude_id)
        if query.first() is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already in use")

    if username is not None:
        query = db.query(User).filter(User.username == username)
        if exclude_id is not None:
            query = query.filter(User.id != exclude_id)
        if query.first() is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already in use")


def _revoke_refresh_tokens(db: Session, user_id: UUID) -> None:
    """Cuts an account's existing sessions. An access token already stops
    working the moment status leaves "active" (get_current_user rechecks it
    every request), but the refresh cookie would otherwise keep minting new
    ones -- so suspending someone has to revoke these too."""
    now = datetime.now(timezone.utc)
    for token in (
        db.query(RefreshToken)
        .filter(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .all()
    ):
        token.revoked_at = now


def _audit(request: Request, *, actor: User, event_type: str, detail: dict) -> AuditLog:
    return AuditLog(
        user_id=actor.id,
        event_type=event_type,
        event_detail=detail,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )


@router.get("", response_model=UserListResponse, dependencies=[Depends(require_permission(Permission.USER_VIEW))])
def list_users(
    name: str | None = None,
    email: str | None = None,
    role: list[str] | None = Query(None),
    location: list[str] | None = Query(None),
    team: list[str] | None = Query(None),
    status_filter: list[str] | None = Query(None, alias="status"),
    sort_by: Literal["name", "email", "role", "location", "team", "status"] = "name",
    sort_dir: Literal["asc", "desc"] = "asc",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
    db: Session = Depends(get_db),
) -> UserListResponse:
    """List users with filtering, sorting, and pagination.

    None of these columns are encrypted (unlike patients), so filtering,
    sorting, and pagination all happen in SQL rather than Python.
    """
    query = (
        db.query(User)
        .join(Role, User.role_id == Role.id)
        .join(Location, User.location_id == Location.id)
        .outerjoin(Team, User.team_id == Team.id)
    )

    if name:
        needle = f"{escape_like(name.strip())}%"
        query = query.filter(or_(User.first_name.ilike(needle), User.last_name.ilike(needle)))

    if email:
        query = query.filter(User.email.ilike(f"{escape_like(email.strip())}%"))

    if role:
        query = query.filter(Role.display_name.in_(role))

    if location:
        query = query.filter(Location.name.in_(location))

    if team:
        # "Unassigned" is a synthetic option standing in for team_id IS NULL,
        # not a real Team row, so it's matched separately from real names.
        team_names = [value for value in team if value != "Unassigned"]
        conditions = []
        if team_names:
            conditions.append(Team.name.in_(team_names))
        if "Unassigned" in team:
            conditions.append(User.team_id.is_(None))
        query = query.filter(or_(*conditions)) if conditions else query.filter(false())

    if status_filter:
        query = query.filter(User.status.in_(status_filter))

    total = query.count()

    order_fn = asc if sort_dir == "asc" else desc
    query = query.order_by(*(order_fn(func.lower(column)) for column in _SORT_COLUMNS[sort_by]))

    start = (page - 1) * page_size
    # contains_eager reuses the joins above instead of issuing extra ones,
    # since those rows are already in the result set for filtering/sorting.
    items = (
        query.options(
            contains_eager(User.role).joinedload(Role.permissions),
            contains_eager(User.location),
            contains_eager(User.team),
        )
        .offset(start)
        .limit(page_size)
        .all()
    )

    return UserListResponse(items=items, total=total)


@router.get(
    "/{user_id}", response_model=UserRead, dependencies=[Depends(require_permission(Permission.USER_VIEW))]
)
def get_user(user_id: UUID, db: Session = Depends(get_db)) -> User:
    """Fetch one user by id."""
    return _get_user_or_404(db, user_id)


@router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED)
@limiter.limit("10/minute")
def create_user(
    payload: UserCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission(Permission.USER_CREATE)),
) -> User:
    """Create a user account."""
    fields = payload.model_dump()
    # Assigning a role at creation is a role assignment like any other, so it
    # needs role.assign and the seniority check too -- else user.create alone
    # would be a route to minting an admin.
    authz.authorize_user_create(db, actor=current_user, payload_fields=fields)

    _raise_if_taken(db, email=payload.email, username=payload.username)

    user = User(
        email=payload.email,
        username=payload.username,
        password_hash=hash_password(payload.password),
        first_name=payload.first_name,
        last_name=payload.last_name,
        role_id=payload.role_id,
        location_id=payload.location_id,
        team_id=payload.team_id,
        created_by=current_user.id,
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        # Lost a race against a concurrent create for the same email/username
        # (the check above only just missed it) -- retry it now for the
        # correct 409 instead of a raw 500.
        db.rollback()
        _raise_if_taken(db, email=payload.email, username=payload.username)
        raise

    db.add(
        _audit(
            request,
            actor=current_user,
            event_type="user_created",
            detail={"created_user_id": str(user.id), "email": user.email, "role_id": user.role_id},
        )
    )
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserRead)
def update_user(
    user_id: UUID,
    payload: UserUpdate,
    request: Request,
    db: Session = Depends(get_db),
    # Any one of these permissions reaches the endpoint; which fields this
    # caller may actually change is decided per-field below.
    current_user: User = Depends(require_any_permission(*authz.USER_UPDATE_PERMISSIONS)),
) -> User:
    """Patch a user account. Field-level rules (authz.authorize_user_update)
    decide which of the submitted fields this caller may actually change."""
    user = _get_user_or_404(db, user_id)

    updates = payload.model_dump(exclude_unset=True)
    authz.authorize_user_update(db, actor=current_user, target=user, updates=updates)

    _raise_if_taken(
        db,
        email=updates.get("email"),
        username=updates.get("username"),
        exclude_id=user.id,
    )

    previous_role_id = user.role_id
    previous_status = user.status

    for field, value in updates.items():
        setattr(user, field, value)

    # Privileged changes are logged individually -- "someone edited a user"
    # isn't a usable audit trail for a promotion or a suspension.
    if "role_id" in updates and user.role_id != previous_role_id:
        db.add(
            _audit(
                request,
                actor=current_user,
                event_type="role_change",
                detail={"user_id": str(user.id), "from_role_id": previous_role_id, "to_role_id": user.role_id},
            )
        )

    if "status" in updates and user.status != previous_status:
        db.add(
            _audit(
                request,
                actor=current_user,
                event_type="status_change",
                detail={"user_id": str(user.id), "from_status": previous_status, "to_status": user.status},
            )
        )
        if user.status != "active":
            _revoke_refresh_tokens(db, user.id)

    try:
        db.commit()
    except IntegrityError:
        # Same race as create_user's, lost against this commit instead of a
        # flush. Rollback also discards this request's field/audit changes,
        # which is correct: a request that loses the race shouldn't partially apply.
        db.rollback()
        _raise_if_taken(db, email=updates.get("email"), username=updates.get("username"), exclude_id=user_id)
        raise
    db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission(Permission.USER_DELETE)),
) -> None:
    """Soft-delete a user: suspends the account and revokes its sessions."""
    user = _get_user_or_404(db, user_id)
    authz.assert_can_deactivate(current_user, user)

    user.status = "suspended"
    _revoke_refresh_tokens(db, user.id)

    db.add(
        _audit(
            request,
            actor=current_user,
            event_type="user_deleted",
            detail={"deleted_user_id": str(user.id)},
        )
    )
    db.commit()
