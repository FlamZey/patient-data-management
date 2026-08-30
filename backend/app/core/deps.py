"""FastAPI dependencies for authenticating requests and checking permissions.

Authentication (who the caller is) and permission authorization (what they may
do) are separate dependencies here; resource-level rules (which rows they may
touch) live in app.core.authz, since those need the request body or the target
row and so can't be expressed as a dependency.
"""

import uuid

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.authz import granted_permissions
from app.core.security import decode_access_token
from app.database import get_db
from app.models import User

bearer_scheme = HTTPBearer(auto_error=False)

CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    if credentials is None:
        raise CREDENTIALS_ERROR

    try:
        payload = decode_access_token(credentials.credentials)
        user_id = uuid.UUID(payload["sub"])
    except (jwt.InvalidTokenError, ValueError, KeyError):
        raise CREDENTIALS_ERROR

    user = db.query(User).filter(User.id == user_id).one_or_none()
    if user is None:
        raise CREDENTIALS_ERROR

    if user.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User account is not active")

    return user


def require_permission(*codes: str):
    """Dependency factory requiring ALL of the given codes.

    Use as Depends(require_permission("patient.view")), or with several codes
    for an action that genuinely needs more than one. Returns the current
    user, so an endpoint that also needs the caller can take this as its
    `current_user` dependency instead of depending on both.
    """
    if not codes:
        raise ValueError("require_permission needs at least one permission code")

    def check_permission(current_user: User = Depends(get_current_user)) -> User:
        missing = [code for code in codes if code not in granted_permissions(current_user)]
        if missing:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing required permission: {', '.join(missing)}",
            )
        return current_user

    return check_permission


def require_any_permission(*codes: str):
    """Dependency factory requiring AT LEAST ONE of the given codes.

    For endpoints whose sub-actions are separately permissioned -- PATCH
    /users/{id} is the case this exists for: holding any of user.edit /
    role.assign / user.suspend is enough to reach the endpoint, and
    authz.authorize_user_update then decides which body fields that
    particular caller may actually change.
    """
    if not codes:
        raise ValueError("require_any_permission needs at least one permission code")

    def check_permission(current_user: User = Depends(get_current_user)) -> User:
        if not granted_permissions(current_user) & set(codes):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing required permission: one of {', '.join(codes)}",
            )
        return current_user

    return check_permission
