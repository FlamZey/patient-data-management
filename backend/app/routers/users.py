"""User management: list/get/create/update/soft-delete."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import asc, desc, false, func, or_
from sqlalchemy.orm import Session, contains_eager

from app.core.deps import require_permission
from app.core.limiter import limiter
from app.core.security import hash_password
from app.database import get_db
from app.models import AuditLog, Location, Role, Team, User
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


@router.get("", response_model=UserListResponse, dependencies=[Depends(require_permission("user.view"))])
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
    # Joined (not just filtered in Python) since none of these columns are
    # encrypted -- unlike patients, there's no reason not to let SQL do the
    # filtering, sorting, and pagination directly.
    query = (
        db.query(User)
        .join(Role, User.role_id == Role.id)
        .join(Location, User.location_id == Location.id)
        .outerjoin(Team, User.team_id == Team.id)
    )

    if name:
        needle = f"%{name.strip()}%"
        query = query.filter(func.concat(User.first_name, " ", User.last_name).ilike(needle))

    if email:
        query = query.filter(User.email.ilike(f"%{email.strip()}%"))

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


@router.get("/{user_id}", response_model=UserRead, dependencies=[Depends(require_permission("user.view"))])
def get_user(user_id: UUID, db: Session = Depends(get_db)) -> User:
    return _get_user_or_404(db, user_id)


@router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED)
@limiter.limit("10/minute")
def create_user(
    payload: UserCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("user.create")),
) -> User:
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
    db.flush()

    db.add(
        AuditLog(
            user_id=current_user.id,
            event_type="user_created",
            event_detail={"created_user_id": str(user.id), "email": user.email},
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserRead, dependencies=[Depends(require_permission("user.edit"))])
def update_user(user_id: UUID, payload: UserUpdate, db: Session = Depends(get_db)) -> User:
    user = _get_user_or_404(db, user_id)

    updates = payload.model_dump(exclude_unset=True)
    _raise_if_taken(
        db,
        email=updates.get("email"),
        username=updates.get("username"),
        exclude_id=user.id,
    )

    for field, value in updates.items():
        setattr(user, field, value)

    db.commit()
    db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("user.delete")),
) -> None:
    user = _get_user_or_404(db, user_id)
    user.status = "suspended"

    db.add(
        AuditLog(
            user_id=current_user.id,
            event_type="user_deleted",
            event_detail={"deleted_user_id": str(user.id)},
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.commit()
