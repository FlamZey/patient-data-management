import re
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.core.text import is_blank, strip_invisible
from app.services.patient_import import (
    AlcoholUse,
    BloodType,
    CareDepartment,
    EmergencyContactRelationship,
    Gender,
    MaritalStatus,
    RaceEthnicity,
    SmokingStatus,
    validate_city,
    validate_date_of_birth,
    validate_diastolic_bp,
    validate_email_field,
    validate_emergency_contact_name,
    validate_emergency_contact_phone,
    validate_first_name,
    validate_height_in,
    validate_insurance_provider,
    validate_last_name,
    validate_last_visit_date,
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
    validate_systolic_bp,
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


class RoleSummary(BaseModel):
    """A role without its permission list -- what the /roles lookup returns.
    Dropdowns only need id and name; shipping every role's grants to any
    caller would disclose the whole authorization model. A caller's own
    permissions still come back in full from /auth/me (see RoleRead)."""

    id: int
    name: str
    display_name: str
    parent_role_id: int | None = None
    description: str | None = None
    is_active: bool

    model_config = ConfigDict(from_attributes=True)


class RoleRead(RoleSummary):
    """A role with its granted permissions -- embedded in UserRead so the
    frontend can gate UI on actual permission codes, not a role name."""

    permissions: list[PermissionRead] = []


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


def _validate_required_text(value: str, field_label: str) -> str:
    """Rejects a value that renders as nothing, and returns it normalised.
    Previously enforced only client-side (frontend/lib/text.ts's isBlank);
    this is the same rule applied to the user path."""
    if is_blank(value):
        raise ValueError(f"{field_label} must not be blank.")
    return strip_invisible(value)


def _reject_if_over_72_bytes(value: str) -> str:
    """bcrypt truncates silently past 72 bytes; reject instead. Counts bytes,
    not characters, since multi-byte UTF-8 can hit the limit early."""
    if len(value.encode("utf-8")) > 72:
        raise ValueError("Password must be at most 72 bytes long.")
    return value


def _validate_password_strength(value: str) -> str:
    if len(value) < 8:
        raise ValueError("Password must be at least 8 characters long.")
    _reject_if_over_72_bytes(value)
    if not re.search(r"[A-Za-z]", value):
        raise ValueError("Password must contain at least one letter.")
    if not re.search(r"\d", value):
        raise ValueError("Password must contain at least one number.")
    if not re.search(r"[^A-Za-z0-9]", value):
        raise ValueError("Password must contain at least one special character.")
    return value


class UserCreate(BaseModel):
    # max_length mirrors the users table's column sizes (models.py), so an oversized value fails cleanly (422) here
    # instead of raising an unhandled psycopg2.DataError (500) at db.flush().
    email: EmailStr = Field(max_length=255)
    username: str = Field(max_length=100)
    # No max_length here: only password_hash is stored (models.py), so there's no column size to mirror --
    # length is instead bounded by _validate_password_strength's 72-byte bcrypt check below.
    password: str
    first_name: str = Field(max_length=100)
    last_name: str = Field(max_length=100)
    role_id: int
    location_id: int
    team_id: int | None = None

    @field_validator("first_name", "last_name", "username")
    @classmethod
    def validate_required_text(cls, value: str, info) -> str:
        return _validate_required_text(value, info.field_name.replace("_", " ").title())

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
    last_login_at: datetime | None = None
    password_changed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    role: RoleRead
    location: LocationRead
    team: TeamRead | None = None

    model_config = ConfigDict(from_attributes=True)


class UserUpdate(BaseModel):
    """Fields an administrator may change on *another* user's account.

    role_id and status are declared here because admins legitimately change
    them, but a schema can't tell who's asking -- whether the caller may
    actually set them is decided per request in
    app.core.authz.authorize_user_update (see PRIVILEGED_USER_FIELDS).
    Presence in this schema is not permission to set the field.
    """

    # Password intentionally omitted. max_length mirrors the users table's column sizes -- see UserCreate.
    email: EmailStr | None = Field(default=None, max_length=255)
    username: str | None = Field(default=None, max_length=100)
    first_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    status: Literal["active", "suspended", "locked", "pending"] | None = None
    role_id: int | None = None
    location_id: int | None = None
    team_id: int | None = None

    @field_validator("first_name", "last_name", "username")
    @classmethod
    def validate_required_text(cls, value: str | None, info) -> str | None:
        # None means "not being changed", not "set to blank" -- only the latter is a problem.
        if value is None:
            return None
        return _validate_required_text(value, info.field_name.replace("_", " ").title())


class UserListResponse(BaseModel):
    items: list[UserRead]
    total: int


class AuditLogActor(BaseModel):
    """The user who performed an audited event.

    A narrow projection of UserRead: identity only (no role, permissions,
    status, or failed-login counters), so the audit view doesn't double as an
    unpermissioned copy of the user directory. None when the actor is
    unknown -- e.g. a sign-in attempt against an email with no account.
    """

    id: UUID
    email: EmailStr
    username: str
    first_name: str
    last_name: str

    model_config = ConfigDict(from_attributes=True)


class AuditLogRead(BaseModel):
    """One audit event, as returned by GET /audit-logs.

    event_detail is free-form JSONB whose shape varies per event_type, so
    it's typed as an opaque mapping rather than a union of known shapes. It
    never contains PHI (write sites record identifiers, field names and
    counts only), and this schema does nothing to interpret it, so no event
    type can leak values through a special-cased renderer.
    """

    id: int
    event_type: str
    event_detail: dict[str, Any] | None = None
    ip_address: str | None = None
    user_agent: str | None = None
    created_at: datetime
    actor: AuditLogActor | None = None

    model_config = ConfigDict(from_attributes=True)


class AuditLogListResponse(BaseModel):
    """A page of audit events.

    `event_types` is the catalog of known values (app.core.audit_events), so
    the client's filter can offer a closed option set without a SELECT
    DISTINCT over an ever-growing table.
    """

    items: list[AuditLogRead]
    total: int
    event_types: list[str]


class SelfProfileUpdate(BaseModel):
    """What a user may change about their own account -- a smaller surface
    than UserUpdate, since email/username/role/location/team/status either
    affect login/authorization or are admin-controlled."""

    # max_length mirrors the users table's column sizes -- see UserCreate.
    first_name: str = Field(max_length=100)
    last_name: str = Field(max_length=100)

    @field_validator("first_name", "last_name")
    @classmethod
    def validate_required_text(cls, value: str, info) -> str:
        return _validate_required_text(value, info.field_name.replace("_", " ").title())


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("current_password")
    @classmethod
    def validate_current_password_length(cls, value: str) -> str:
        return _reject_if_over_72_bytes(value)

    @field_validator("new_password")
    @classmethod
    def validate_password_strength(cls, value: str) -> str:
        return _validate_password_strength(value)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str

    @field_validator("password")
    @classmethod
    def validate_password_length(cls, value: str) -> str:
        return _reject_if_over_72_bytes(value)


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
    care_department: str | None = None
    registration_date: str | None = None
    last_visit_date: str | None = None
    preferred_pharmacy: str | None = None
    blood_type: str | None = None
    height_in: int | None = None
    weight_lbs: int | None = None
    systolic_bp: int | None = None
    diastolic_bp: int | None = None
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
    # gender and the other enum-typed fields below (emergency_contact_relationship, race_ethnicity, marital_status,
    # care_department, blood_type, smoking_status, alcohol_use) have no @field_validator -- pydantic already rejects
    # any value outside the enum, so a custom validator would just duplicate that check.
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
    care_department: CareDepartment | None = None
    registration_date: str | None = None
    last_visit_date: str | None = None
    preferred_pharmacy: str | None = None
    blood_type: BloodType | None = None
    height_in: int | None = None
    weight_lbs: int | None = None
    systolic_bp: int | None = None
    diastolic_bp: int | None = None
    allergies: list[str] | None = None
    current_medications: list[str] | None = None
    chronic_conditions: list[str] | None = None
    immunization_history: list[str] | None = None
    smoking_status: SmokingStatus | None = None
    alcohol_use: AlcoholUse | None = None

    # Mirrors the bulk-upload path's own name validation (_validate_name in patient_import.py), so a manual edit
    # can't blank a name or slip a formula-injection payload (leading =/+/-/@) through the way it once could.
    @field_validator("first_name")
    @classmethod
    def validate_first_name_value(cls, value: str | None) -> str | None:
        return validate_first_name(value)

    @field_validator("last_name")
    @classmethod
    def validate_last_name_value(cls, value: str | None) -> str | None:
        return validate_last_name(value)

    # Unlike its neighbors below, validate_date_of_birth isn't wrapped by
    # patient_import._as_public_date_validator, so it doesn't handle None
    # itself -- this validator has to guard for it explicitly.
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

    @field_validator("last_visit_date")
    @classmethod
    def validate_last_visit_date_value(cls, value: str | None) -> str | None:
        return validate_last_visit_date(value)

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

    @field_validator("systolic_bp")
    @classmethod
    def validate_systolic_bp_value(cls, value: int | None) -> int | None:
        return validate_systolic_bp(value)

    @field_validator("diastolic_bp")
    @classmethod
    def validate_diastolic_bp_value(cls, value: int | None) -> int | None:
        return validate_diastolic_bp(value)

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
