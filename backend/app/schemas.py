import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, field_validator


class RoleRead(BaseModel):
    id: int
    name: str
    display_name: str
    parent_role_id: int | None = None
    description: str | None = None
    is_active: bool

    model_config = ConfigDict(from_attributes=True)


class LocationRead(BaseModel):
    id: int
    code: str
    name: str
    is_active: bool

    model_config = ConfigDict(from_attributes=True)


class TeamRead(BaseModel):
    id: int
    code: str
    name: str
    description: str | None = None
    is_active: bool

    model_config = ConfigDict(from_attributes=True)


class PermissionRead(BaseModel):
    id: int
    code: str
    resource: str
    action: str
    description: str | None = None

    model_config = ConfigDict(from_attributes=True)


class UserCreate(BaseModel):
    email: EmailStr
    username: str
    password: str
    first_name: str
    last_name: str
    role_id: int
    location_id: int
    team_id: int | None = None

    @field_validator("password")
    @classmethod
    def validate_password_strength(cls, value: str) -> str:
        if len(value) < 8:
            raise ValueError("Password must be at least 8 characters long.")
        if not re.search(r"[A-Za-z]", value):
            raise ValueError("Password must contain at least one letter.")
        if not re.search(r"\d", value):
            raise ValueError("Password must contain at least one number.")
        return value


class UserRead(BaseModel):
    id: UUID
    email: EmailStr
    username: str
    first_name: str
    last_name: str
    status: str
    failed_login_count: int
    locked_until: datetime | None = None
    last_login_at: datetime | None = None
    password_changed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    role: RoleRead
    location: LocationRead
    team: TeamRead | None = None

    model_config = ConfigDict(from_attributes=True)


class UserUpdate(BaseModel):
    # Password intentionally omitted here.
    email: EmailStr | None = None
    username: str | None = None
    first_name: str | None = None
    last_name: str | None = None
    status: Literal["active", "suspended", "locked", "pending"] | None = None
    role_id: int | None = None
    location_id: int | None = None
    team_id: int | None = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
