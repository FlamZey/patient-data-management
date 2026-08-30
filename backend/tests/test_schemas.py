"""Validator tests for PatientUpdate.

These validators exist for a specific reason, recorded in schemas.py: the
manual-edit path originally had none, so a PATCH could blank out a patient's
name or slip a spreadsheet-formula payload (leading =, +, -, @) into a field
that the bulk-upload path would have rejected. They mirror the upload path's
rules onto the edit path.

test_patients.py exercises a couple of them through the endpoint, but most were
never asserted at all -- so the injection guard on the edit path was, in
practice, unverified for the majority of fields. Testing the schema directly
covers every field cheaply, without a request per case.
"""

import pytest
from pydantic import ValidationError

from app.schemas import PatientUpdate, SelfProfileUpdate, UserCreate, UserUpdate

# Leading characters Excel and Sheets treat as the start of a formula. A cell
# beginning with one of these can execute when the exported file is opened,
# which is why they're refused at the boundary rather than escaped later.
FORMULA_PAYLOADS = ["=cmd|'/c calc'!A1", "+1+1", "-2+3", "@SUM(A1)"]

# Every free-text field on PatientUpdate that runs through the shared
# optional-text validation.
TEXT_FIELDS = [
    "street_address",
    "city",
    "preferred_language",
    "occupation",
    "insurance_provider",
    "policy_number",
    "pcp_name",
    "preferred_pharmacy",
    "emergency_contact_name",
]

INT_FIELDS_OUT_OF_RANGE = [
    ("height_in", 11),      # below MIN_HEIGHT_IN (12)
    ("height_in", 109),     # above MAX_HEIGHT_IN (108)
    ("weight_lbs", 0),
    ("systolic_bp", 59),    # below MIN_SYSTOLIC_BP (60)
    ("systolic_bp", 251),   # above MAX_SYSTOLIC_BP (250)
    ("diastolic_bp", 0),
]

MULTI_VALUE_FIELDS = ["allergies", "current_medications", "chronic_conditions", "immunization_history"]


class TestFormulaInjection:
    @pytest.mark.parametrize("field", TEXT_FIELDS)
    @pytest.mark.parametrize("payload", FORMULA_PAYLOADS)
    # A formula-leading value is refused on every free-text field.
    def test_text_field_rejects_formula_payload(self, field, payload):
        with pytest.raises(ValidationError):
            PatientUpdate(**{field: payload})

    @pytest.mark.parametrize("field", ["first_name", "last_name"])
    @pytest.mark.parametrize("payload", FORMULA_PAYLOADS)
    # Names are refused too -- they're the fields the edit form always sends.
    def test_name_rejects_formula_payload(self, field, payload):
        with pytest.raises(ValidationError):
            PatientUpdate(**{field: payload})

    @pytest.mark.parametrize("field", TEXT_FIELDS)
    # An ordinary value in the same field is accepted, so the tests above
    # can't be passing because the field rejects everything.
    def test_text_field_accepts_an_ordinary_value(self, field):
        # No space in the value: policy_number additionally requires letters,
        # digits and hyphens only, so this is the one string valid for every
        # field in the list.
        assert getattr(PatientUpdate(**{field: "Ordinary-Value123"}), field) == "Ordinary-Value123"


class TestNames:
    @pytest.mark.parametrize("blank", ["", "   ", "\t", "​", "﻿"])
    @pytest.mark.parametrize("field", ["first_name", "last_name"])
    # A name can't be blanked out through the edit path. The last two params
    # are U+200B and U+FEFF -- invisible in this source, and the reason
    # app.core.text exists: str.strip() leaves them, so a name made of nothing
    # but one of them used to pass here while the UI refused it.
    def test_blank_name_is_rejected(self, field, blank):
        with pytest.raises(ValidationError):
            PatientUpdate(**{field: blank})

    # A real name passes and is returned trimmed.
    def test_valid_name_is_accepted(self):
        assert PatientUpdate(first_name="  Ada  ").first_name == "Ada"

    # An explicit null is allowed -- the router treats it as "leave unchanged"
    # for the non-nullable columns rather than as a blanking attempt.
    def test_explicit_null_is_allowed(self):
        assert PatientUpdate(first_name=None).first_name is None


class TestNumericRanges:
    @pytest.mark.parametrize(("field", "value"), INT_FIELDS_OUT_OF_RANGE)
    # Physiologically impossible values are refused.
    def test_out_of_range_is_rejected(self, field, value):
        with pytest.raises(ValidationError):
            PatientUpdate(**{field: value})

    @pytest.mark.parametrize(
        ("field", "value"),
        [("height_in", 70), ("weight_lbs", 180), ("systolic_bp", 120), ("diastolic_bp", 80)],
    )
    # Ordinary values pass.
    def test_in_range_is_accepted(self, field, value):
        assert getattr(PatientUpdate(**{field: value}), field) == value

    # A boolean is not silently coerced to 1/0.
    def test_boolean_is_not_treated_as_a_number(self):
        with pytest.raises(ValidationError):
            PatientUpdate(systolic_bp=True)


class TestDates:
    @pytest.mark.parametrize("value", ["not-a-date", "2026-13-01", "01/32/2020"])
    # A malformed date is refused.
    def test_malformed_date_of_birth_is_rejected(self, value):
        with pytest.raises(ValidationError):
            PatientUpdate(date_of_birth=value)

    # An ISO date passes.
    def test_iso_date_of_birth_is_accepted(self):
        assert PatientUpdate(date_of_birth="1990-01-15").date_of_birth == "1990-01-15"

    @pytest.mark.parametrize("field", ["registration_date", "last_visit_date"])
    # The optional dates validate too.
    def test_malformed_optional_date_is_rejected(self, field):
        with pytest.raises(ValidationError):
            PatientUpdate(**{field: "nonsense"})


class TestMultiValueFields:
    @pytest.mark.parametrize("field", MULTI_VALUE_FIELDS)
    # A list of ordinary items passes through.
    def test_items_are_accepted(self, field):
        assert getattr(PatientUpdate(**{field: ["Penicillin", "Latex"]}), field) == ["Penicillin", "Latex"]

    @pytest.mark.parametrize("field", MULTI_VALUE_FIELDS)
    # An empty list clears the field rather than storing [].
    def test_empty_list_becomes_null(self, field):
        assert getattr(PatientUpdate(**{field: []}), field) is None

    @pytest.mark.parametrize("field", MULTI_VALUE_FIELDS)
    # A formula payload inside one item is refused, not just at the top level.
    def test_formula_inside_an_item_is_rejected(self, field):
        with pytest.raises(ValidationError):
            PatientUpdate(**{field: ["Penicillin", "=cmd|'/c calc'!A1"]})


class TestEnumFields:
    @pytest.mark.parametrize(
        ("field", "value"),
        [("gender", "Martian"), ("blood_type", "Z+"), ("smoking_status", "sometimes")],
    )
    # A value outside the closed set is refused.
    def test_unknown_enum_value_is_rejected(self, field, value):
        with pytest.raises(ValidationError):
            PatientUpdate(**{field: value})

    # A member of the set passes.
    def test_known_enum_value_is_accepted(self):
        assert PatientUpdate(gender="Female").gender == "Female"


class TestImmutableFields:
    # patient_code is absent from the schema, so a PATCH can never change it.
    def test_patient_code_is_not_settable(self):
        """Immutable once uploaded -- it's the only plaintext lookup/dedupe key,
        so letting an edit rewrite it would break row identity."""
        assert "patient_code" not in PatientUpdate.model_fields
        assert "patient_code" not in PatientUpdate(patient_code="P-999").model_dump(exclude_unset=True)


class TestPasswordStrength:
    @pytest.mark.parametrize("password", ["short1!", "nodigits!", "nospecial1", "12345678!"])
    # Weak passwords are refused at the schema, before any hashing happens.
    def test_weak_password_is_rejected(self, password):
        with pytest.raises(ValidationError):
            UserCreate(
                email="a@example.com", username="a", password=password,
                first_name="A", last_name="B", role_id=1, location_id=1,
            )

    # A password meeting every rule passes.
    def test_strong_password_is_accepted(self):
        user = UserCreate(
            email="a@example.com", username="a", password="ValidPass123!",
            first_name="A", last_name="B", role_id=1, location_id=1,
        )
        assert user.password == "ValidPass123!"


class TestUserNameFields:
    """User names and usernames previously had only a max_length, so "", "   "
    and a lone zero-width character were all accepted by the API while the UI
    refused them -- validation that lived only on the client. These pin the
    server-side rule."""

    def _create(self, **overrides):
        payload = {
            "email": "a@example.com",
            "username": "someone",
            "password": "ValidPass123!",
            "first_name": "Ada",
            "last_name": "Lovelace",
            "role_id": 1,
            "location_id": 1,
        }
        payload.update(overrides)
        return UserCreate(**payload)

    @pytest.mark.parametrize("field", ["first_name", "last_name", "username"])
    @pytest.mark.parametrize("blank", ["", "   ", "\t", "\u200b", "\ufeff"])
    # A blank or invisible value is refused on create.
    def test_blank_is_rejected_on_create(self, field, blank):
        with pytest.raises(ValidationError):
            self._create(**{field: blank})

    # Ordinary values pass and come back trimmed.
    def test_valid_values_are_accepted_and_trimmed(self):
        user = self._create(first_name="  Ada  ")
        assert user.first_name == "Ada"

    # An invisible character embedded in a real name is stripped rather than
    # stored, so two names that look identical compare equal.
    def test_embedded_invisible_character_is_stripped(self):
        assert self._create(first_name="Ad\u200ba").first_name == "Ada"

    @pytest.mark.parametrize("field", ["first_name", "last_name", "username"])
    # The same rule applies to an admin editing someone else.
    def test_blank_is_rejected_on_update(self, field):
        with pytest.raises(ValidationError):
            UserUpdate(**{field: "   "})

    @pytest.mark.parametrize("field", ["first_name", "last_name", "username"])
    # None still means "not being changed", which is not the same as blank.
    def test_none_is_still_allowed_on_update(self, field):
        assert getattr(UserUpdate(**{field: None}), field) is None

    @pytest.mark.parametrize("blank", ["", "   ", "\u200b"])
    # And to a user editing their own profile.
    def test_blank_is_rejected_on_self_update(self, blank):
        with pytest.raises(ValidationError):
            SelfProfileUpdate(first_name=blank, last_name="Lovelace")

    # A valid self-update passes.
    def test_valid_self_update_is_accepted(self):
        assert SelfProfileUpdate(first_name="Ada", last_name="Lovelace").first_name == "Ada"
