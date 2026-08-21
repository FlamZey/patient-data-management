from datetime import date, timedelta
from io import BytesIO

import openpyxl
import pytest

from app.services.patient_import import (
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
    assert result.accepted[0] == {
        "patient_code": "P-001",
        "first_name": "Ada",
        "last_name": "Lovelace",
        "date_of_birth": "1990-01-15",
        "gender": "Female",
    }
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
