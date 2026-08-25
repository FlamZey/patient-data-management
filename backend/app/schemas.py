import re
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, field_validator

from app.services.patient_import import (
    AlcoholUse,
    BloodType,
    EmergencyContactRelationship,
    Gender,
    MaritalStatus,
    RaceEthnicity,
    SmokingStatus,
    validate_city,
    validate_date_of_birth,
    validate_email_field,
    validate_emergency_contact_name,
    validate_emergency_contact_phone,
    validate_height_in,
    validate_insurance_provider,
    validate_multi_value,
    validate_occupation,
    validate_pcp_name,
    validate_phone,
    validate_policy_number,
    validate_preferred_language,
    validate_preferred_pharmacy,
    validate_registration_date,
    validate_state,
    validate_street_address,
    validate_weight_lbs,
    validate_zip_code,
)


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

    street_address: str | None = None
    city: str | None = None
    state: str | None = None
    zip_code: str | None = None
    phone: str | None = None
    email: str | None = None
    emergency_contact_name: str | None = None
    emergency_contact_relationship: str | None = None
    emergency_contact_phone: str | None = None
    preferred_language: str | None = None
    race_ethnicity: str | None = None
    marital_status: str | None = None
    occupation: str | None = None
    insurance_provider: str | None = None
    policy_number: str | None = None
    pcp_name: str | None = None
    registration_date: str | None = None
    preferred_pharmacy: str | None = None
    blood_type: str | None = None
    height_in: int | None = None
    weight_lbs: int | None = None
    allergies: list[str] | None = None
    current_medications: list[str] | None = None
    chronic_conditions: list[str] | None = None
    immunization_history: list[str] | None = None
    smoking_status: str | None = None
    alcohol_use: str | None = None

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

    street_address: str | None = None
    city: str | None = None
    state: str | None = None
    zip_code: str | None = None
    phone: str | None = None
    email: str | None = None
    emergency_contact_name: str | None = None
    emergency_contact_relationship: EmergencyContactRelationship | None = None
    emergency_contact_phone: str | None = None
    preferred_language: str | None = None
    race_ethnicity: RaceEthnicity | None = None
    marital_status: MaritalStatus | None = None
    occupation: str | None = None
    insurance_provider: str | None = None
    policy_number: str | None = None
    pcp_name: str | None = None
    registration_date: str | None = None
    preferred_pharmacy: str | None = None
    blood_type: BloodType | None = None
    height_in: int | None = None
    weight_lbs: int | None = None
    allergies: list[str] | None = None
    current_medications: list[str] | None = None
    chronic_conditions: list[str] | None = None
    immunization_history: list[str] | None = None
    smoking_status: SmokingStatus | None = None
    alcohol_use: AlcoholUse | None = None

    @field_validator("date_of_birth")
    @classmethod
    def validate_date_of_birth_value(cls, value: str | None) -> str | None:
        return validate_date_of_birth(value) if value is not None else None

    @field_validator("street_address")
    @classmethod
    def validate_street_address_value(cls, value: str | None) -> str | None:
        return validate_street_address(value)

    @field_validator("city")
    @classmethod
    def validate_city_value(cls, value: str | None) -> str | None:
        return validate_city(value)

    @field_validator("state")
    @classmethod
    def validate_state_value(cls, value: str | None) -> str | None:
        return validate_state(value)

    @field_validator("zip_code")
    @classmethod
    def validate_zip_code_value(cls, value: str | None) -> str | None:
        return validate_zip_code(value)

    @field_validator("phone")
    @classmethod
    def validate_phone_value(cls, value: str | None) -> str | None:
        return validate_phone(value)

    @field_validator("email")
    @classmethod
    def validate_email_value(cls, value: str | None) -> str | None:
        return validate_email_field(value)

    @field_validator("emergency_contact_name")
    @classmethod
    def validate_emergency_contact_name_value(cls, value: str | None) -> str | None:
        return validate_emergency_contact_name(value)

    @field_validator("emergency_contact_phone")
    @classmethod
    def validate_emergency_contact_phone_value(cls, value: str | None) -> str | None:
        return validate_emergency_contact_phone(value)

    @field_validator("preferred_language")
    @classmethod
    def validate_preferred_language_value(cls, value: str | None) -> str | None:
        return validate_preferred_language(value)

    @field_validator("occupation")
    @classmethod
    def validate_occupation_value(cls, value: str | None) -> str | None:
        return validate_occupation(value)

    @field_validator("insurance_provider")
    @classmethod
    def validate_insurance_provider_value(cls, value: str | None) -> str | None:
        return validate_insurance_provider(value)

    @field_validator("policy_number")
    @classmethod
    def validate_policy_number_value(cls, value: str | None) -> str | None:
        return validate_policy_number(value)

    @field_validator("pcp_name")
    @classmethod
    def validate_pcp_name_value(cls, value: str | None) -> str | None:
        return validate_pcp_name(value)

    @field_validator("registration_date")
    @classmethod
    def validate_registration_date_value(cls, value: str | None) -> str | None:
        return validate_registration_date(value)

    @field_validator("preferred_pharmacy")
    @classmethod
    def validate_preferred_pharmacy_value(cls, value: str | None) -> str | None:
        return validate_preferred_pharmacy(value)

    @field_validator("height_in")
    @classmethod
    def validate_height_in_value(cls, value: int | None) -> int | None:
        return validate_height_in(value)

    @field_validator("weight_lbs")
    @classmethod
    def validate_weight_lbs_value(cls, value: int | None) -> int | None:
        return validate_weight_lbs(value)

    @field_validator("allergies")
    @classmethod
    def validate_allergies_value(cls, value: list[str] | None) -> list[str] | None:
        return validate_multi_value(value, "Allergies")

    @field_validator("current_medications")
    @classmethod
    def validate_current_medications_value(cls, value: list[str] | None) -> list[str] | None:
        return validate_multi_value(value, "Current Medications")

    @field_validator("chronic_conditions")
    @classmethod
    def validate_chronic_conditions_value(cls, value: list[str] | None) -> list[str] | None:
        return validate_multi_value(value, "Chronic Conditions (ICD-10)")

    @field_validator("immunization_history")
    @classmethod
    def validate_immunization_history_value(cls, value: list[str] | None) -> list[str] | None:
        return validate_multi_value(value, "Immunization History")


class PatientListResponse(BaseModel):
    items: list[PatientRead]
    total: int
