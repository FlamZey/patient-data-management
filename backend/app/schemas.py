import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, field_validator

from app.services.patient_import import Gender, RejectedRow, validate_date_of_birth


class PermissionRead(BaseModel):
    id: int
    code: str
    resource: str
    action: str
    description: str | None = None

    model_config = ConfigDict(from_attributes=True)


class RoleRead(BaseModel):
    id: int
    name: str
    display_name: str
    parent_role_id: int | None = None
    description: str | None = None
    is_active: bool
    permissions: list[PermissionRead] = []

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


def _validate_password_strength(value: str) -> str:
    if len(value) < 8:
        raise ValueError("Password must be at least 8 characters long.")
    if not re.search(r"[A-Za-z]", value):
        raise ValueError("Password must contain at least one letter.")
    if not re.search(r"\d", value):
        raise ValueError("Password must contain at least one number.")
    if not re.search(r"[^A-Za-z0-9]", value):
        raise ValueError("Password must contain at least one special character.")
    return value


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
        return _validate_password_strength(value)


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


class UserListResponse(BaseModel):
    items: list[UserRead]
    total: int


class SelfProfileUpdate(BaseModel):
    """What a user may change about their own account -- deliberately a
    much smaller surface than UserUpdate (no email/username/role/location/
    team/status), since those either affect login/authorization or are
    admin-controlled."""

    first_name: str
    last_name: str


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_password_strength(cls, value: str) -> str:
        return _validate_password_strength(value)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class PatientRead(BaseModel):
    """The decrypted view returned to the client -- PHI fields are stored
    encrypted (see app.core.encryption) but always come back plaintext here."""

    id: UUID
    patient_code: str
    first_name: str
    last_name: str
    date_of_birth: str
    gender: str
    uploaded_by: UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PatientUpdate(BaseModel):
    # patient_code is deliberately absent -- it's immutable once uploaded.
    first_name: str | None = None
    last_name: str | None = None
    date_of_birth: str | None = None
    gender: Gender | None = None

    @field_validator("date_of_birth")
    @classmethod
    def validate_date_of_birth_value(cls, value: str | None) -> str | None:
        return validate_date_of_birth(value) if value is not None else None


class PatientListResponse(BaseModel):
    items: list[PatientRead]
    total: int


class PatientUploadResult(BaseModel):
    accepted: int
    rejected: list[RejectedRow]
    upload_id: UUID
