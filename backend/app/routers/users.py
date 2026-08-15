"""User management: list/get/create/update/soft-delete."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.core.deps import require_permission
from app.core.security import hash_password
from app.database import get_db
from app.models import AuditLog, User
from app.schemas import UserCreate, UserRead, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


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


@router.get("", response_model=list[UserRead], dependencies=[Depends(require_permission("user.view"))])
def list_users(db: Session = Depends(get_db)) -> list[User]:
    return db.query(User).all()


@router.get("/{user_id}", response_model=UserRead, dependencies=[Depends(require_permission("user.view"))])
def get_user(user_id: UUID, db: Session = Depends(get_db)) -> User:
    return _get_user_or_404(db, user_id)


@router.post("", response_model=UserRead, status_code=status.HTTP_201_CREATED)
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
