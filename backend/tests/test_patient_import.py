from datetime import date, timedelta
from io import BytesIO

import openpyxl
import pytest

from app.services.patient_import import (
    OPTIONAL_COLUMNS,
    OPTIONAL_FIELD_NAMES,
    REQUIRED_COLUMNS,
    PatientImportError,
    parse_patient_upload,
)


def _workbook_bytes(rows: list[list]) -> bytes:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    for row in rows:
        sheet.append(row)
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _parse(rows: list[list], **kwargs):
    return parse_patient_upload(filename="patients.xlsx", content=_workbook_bytes(rows), **kwargs)


def test_fully_valid_file_is_all_accepted():
    rows = [
        REQUIRED_COLUMNS,
        ["P-001", "Ada", "Lovelace", "1990-01-15", "Female"],
        ["P-002", "Grace", "Hopper", date(1975, 6, 1), "Other"],
        ["P-003", "Alan", "Turing", "06/23/1912", "Male"],
    ]
    result = _parse(rows)

    assert result.total_rows == 3
    assert result.rejected == []
    assert len(result.accepted) == 3
    first = result.accepted[0]
    assert first["patient_code"] == "P-001"
    assert first["first_name"] == "Ada"
    assert first["last_name"] == "Lovelace"
    assert first["date_of_birth"] == "1990-01-15"
    assert first["gender"] == "Female"
    # A header with none of OPTIONAL_COLUMNS still validates -- every optional
    # field defaults to None rather than being rejected or the key being omitted.
    assert all(first[name] is None for name in OPTIONAL_FIELD_NAMES)
    assert result.accepted[1]["date_of_birth"] == "1975-06-01"
    assert result.accepted[2]["date_of_birth"] == "1912-06-23"


def test_missing_required_column_raises_before_row_processing():
    rows = [
        ["Patient ID", "First Name", "Last Name", "Date of Birth"],  # Gender omitted
        ["P-001", "Ada", "Lovelace", "1990-01-15"],
    ]
    with pytest.raises(PatientImportError, match="Gender"):
        _parse(rows)


def test_unexpected_column_raises_before_row_processing():
    rows = [
        [*REQUIRED_COLUMNS, "Notes"],
        ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "vip"],
    ]
    with pytest.raises(PatientImportError, match="Notes"):
        _parse(rows)


def test_blank_required_field_rejects_row():
    rows = [
        REQUIRED_COLUMNS,
        ["P-001", "", "Lovelace", "1990-01-15", "Female"],
    ]
    result = _parse(rows)

    assert result.accepted == []
    assert len(result.rejected) == 1
    rejected = result.rejected[0]
    assert rejected.row == 2
    assert rejected.field == "First Name"
    assert "required" in rejected.reason.lower()


def test_bad_date_format_rejects_row():
    rows = [
        REQUIRED_COLUMNS,
        ["P-001", "Ada", "Lovelace", "15-01-1990", "Female"],
    ]
    result = _parse(rows)

    assert result.accepted == []
    assert len(result.rejected) == 1
    rejected = result.rejected[0]
    assert rejected.field == "Date of Birth"
    assert "valid date" in rejected.reason.lower()


def test_future_date_rejects_row():
    future_date = date.today() + timedelta(days=1)
    rows = [
        REQUIRED_COLUMNS,
        ["P-001", "Ada", "Lovelace", future_date, "Female"],
    ]
    result = _parse(rows)

    assert result.accepted == []
    assert len(result.rejected) == 1
    rejected = result.rejected[0]
    assert rejected.field == "Date of Birth"
    assert "future" in rejected.reason.lower()


def test_invalid_gender_rejects_row():
    rows = [
        REQUIRED_COLUMNS,
        ["P-001", "Ada", "Lovelace", "1990-01-15", "Unspecified"],
    ]
    result = _parse(rows)

    assert result.accepted == []
    assert len(result.rejected) == 1
    rejected = result.rejected[0]
    assert rejected.field == "Gender"
    assert "must be one of" in rejected.reason.lower()


def test_duplicate_patient_id_within_file_rejects_both_rows():
    rows = [
        REQUIRED_COLUMNS,
        ["DUP-1", "Ada", "Lovelace", "1990-01-15", "Female"],
        ["DUP-1", "Grace", "Hopper", "1985-03-12", "Female"],
    ]
    result = _parse(rows)

    assert result.accepted == []
    assert len(result.rejected) == 2
    assert {rejected.row for rejected in result.rejected} == {2, 3}
    for rejected in result.rejected:
        assert rejected.field == "Patient ID"
        assert "duplicate" in rejected.reason.lower()


def test_existing_patient_code_for_manager_rejects_row():
    rows = [
        REQUIRED_COLUMNS,
        ["EXIST-1", "Ada", "Lovelace", "1990-01-15", "Female"],
    ]
    result = _parse(rows, existing_patient_codes=["EXIST-1"])

    assert result.accepted == []
    assert len(result.rejected) == 1
    rejected = result.rejected[0]
    assert rejected.field == "Patient ID"
    assert "already exists" in rejected.reason.lower()


def test_formula_injection_in_name_field_rejects_row():
    rows = [
        REQUIRED_COLUMNS,
        ["P-001", "=cmd|'/c calc'!A1", "Lovelace", "1990-01-15", "Female"],
    ]
    result = _parse(rows)

    assert result.accepted == []
    assert len(result.rejected) == 1
    rejected = result.rejected[0]
    assert rejected.field == "First Name"
    assert "formula" in rejected.reason.lower()


def test_unsupported_extension_raises():
    with pytest.raises(PatientImportError, match="Unsupported file type"):
        parse_patient_upload(filename="patients.csv", content=b"whatever")


class TestOptionalFields:
    def test_all_optional_columns_present_and_valid_are_parsed(self):
        header = REQUIRED_COLUMNS + OPTIONAL_COLUMNS
        row = [
            "P-001", "Ada", "Lovelace", "1990-01-15", "Female",
            "123 Main St", "Springfield", "IL", "62704", "217-555-0100", "ada@example.com",
            "Charles Babbage", "Spouse", "217-555-0101",
            "English", "White", "Married", "Mathematician",
            "Blue Cross Blue Shield", "POL123456", "Dr. Hopper",
            "2020-05-01", "CVS Pharmacy", "O+",
            "68", "150",
            "Penicillin, Peanuts", "Metformin, Lisinopril",
            "I10 - Essential hypertension", "Influenza (2023-04-01)",
            "Never smoker", "Occasional",
        ]
        result = _parse([header, row])

        assert result.rejected == []
        assert len(result.accepted) == 1
        accepted = result.accepted[0]
        assert accepted["street_address"] == "123 Main St"
        assert accepted["city"] == "Springfield"
        assert accepted["state"] == "IL"
        assert accepted["zip_code"] == "62704"
        assert accepted["phone"] == "217-555-0100"
        assert accepted["email"] == "ada@example.com"
        assert accepted["emergency_contact_relationship"] == "Spouse"
        assert accepted["registration_date"] == "2020-05-01"
        assert accepted["blood_type"] == "O+"
        assert accepted["height_in"] == 68
        assert accepted["weight_lbs"] == 150
        assert accepted["allergies"] == ["Penicillin", "Peanuts"]
        assert accepted["current_medications"] == ["Metformin", "Lisinopril"]
        assert accepted["chronic_conditions"] == ["I10 - Essential hypertension"]
        assert accepted["immunization_history"] == ["Influenza (2023-04-01)"]
        assert accepted["smoking_status"] == "Never smoker"
        assert accepted["alcohol_use"] == "Occasional"

    def test_blank_optional_cells_are_accepted_as_none(self):
        header = REQUIRED_COLUMNS + ["Email", "Blood Type"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "", None]
        result = _parse([header, row])

        assert result.rejected == []
        assert result.accepted[0]["email"] is None
        assert result.accepted[0]["blood_type"] is None

    def test_invalid_email_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Email"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "not-an-email"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Email"

    def test_invalid_state_rejects_row(self):
        header = REQUIRED_COLUMNS + ["State"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "ZZ"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "State"

    def test_invalid_zip_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Zip"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "not-a-zip"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Zip"

    def test_numeric_zip_keeps_leading_zero(self):
        # Regression: a Zip cell entered/formatted as a number in Excel
        # (e.g. Massachusetts/Puerto Rico ZIPs starting with 0) reads back
        # via openpyxl as a float like 2134.0, which must not be treated as
        # the 4-digit string "2134".
        header = REQUIRED_COLUMNS + ["Zip"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", 2134.0]
        result = _parse([header, row])

        assert result.rejected == []
        assert result.accepted[0]["zip_code"] == "02134"

    def test_invalid_blood_type_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Blood Type"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "Z+"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Blood Type"

    def test_registration_date_in_future_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Registration Date"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", date.today() + timedelta(days=1)]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Registration Date"
        assert "future" in result.rejected[0].reason.lower()

    def test_phone_with_leading_plus_is_accepted(self):
        # Regression test: Faker's phone_number() routinely emits "+1-..."
        # formats, and the generic formula-injection guard (which flags any
        # leading +/-/=/@) would otherwise reject every one of them.
        header = REQUIRED_COLUMNS + ["Phone"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "+1-217-555-0100"]
        result = _parse([header, row])

        assert result.rejected == []
        assert result.accepted[0]["phone"] == "+1-217-555-0100"

    def test_multi_value_all_blank_cell_is_none(self):
        header = REQUIRED_COLUMNS + ["Allergies"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "  ,  ,"]
        result = _parse([header, row])

        assert result.rejected == []
        assert result.accepted[0]["allergies"] is None

    def test_multi_value_formula_injection_token_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Allergies"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "Penicillin, =cmd|'/c calc'!A1"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Allergies"
        assert "formula" in result.rejected[0].reason.lower()

    def test_height_boundaries_accepted(self):
        header = REQUIRED_COLUMNS + ["Height (in)"]
        rows = [
            header,
            ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", 12],
            ["P-002", "Grace", "Hopper", "1990-01-15", "Female", 108],
        ]
        result = _parse(rows)

        assert result.rejected == []
        assert [row["height_in"] for row in result.accepted] == [12, 108]

    def test_height_out_of_range_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Height (in)"]
        rows = [
            header,
            ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", 11],
            ["P-002", "Grace", "Hopper", "1990-01-15", "Female", 109],
        ]
        result = _parse(rows)

        assert len(result.rejected) == 2
        assert all(rejected.field == "Height (in)" for rejected in result.rejected)

    def test_bool_height_value_is_rejected_not_coerced(self):
        header = REQUIRED_COLUMNS + ["Height (in)"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", True]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Height (in)"
