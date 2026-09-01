from datetime import date, timedelta
from io import BytesIO

import openpyxl
import pytest
import xlrd

from app.services import patient_import
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


# Fully valid file is all accepted.
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


# Missing required column raises before row processing.
def test_missing_required_column_raises_before_row_processing():
    rows = [
        ["Patient ID", "First Name", "Last Name", "Date of Birth"],  # Gender omitted
        ["P-001", "Ada", "Lovelace", "1990-01-15"],
    ]
    with pytest.raises(PatientImportError, match="Gender"):
        _parse(rows)


# Unexpected column raises before row processing.
def test_unexpected_column_raises_before_row_processing():
    rows = [
        [*REQUIRED_COLUMNS, "Notes"],
        ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "vip"],
    ]
    with pytest.raises(PatientImportError, match="Notes"):
        _parse(rows)


# A file over the row cap is rejected before any row is validated -- the cap
# exists to bound the cost of *reading* an oversized file, so it has to raise
# from inside that read, not from a count taken afterward. MAX_UPLOAD_ROWS is
# patched down to keep this fast rather than generating 50,000+ real rows.
def test_file_over_row_cap_raises_before_row_processing(monkeypatch):
    monkeypatch.setattr(patient_import, "MAX_UPLOAD_ROWS", 2)
    rows = [
        REQUIRED_COLUMNS,
        ["P-001", "Ada", "Lovelace", "1990-01-15", "Female"],
        ["P-002", "Grace", "Hopper", "1975-06-01", "Other"],
        ["P-003", "Alan", "Turing", "1912-06-23", "Male"],  # the 3rd data row, over the cap of 2
    ]
    with pytest.raises(PatientImportError, match="2-row limit"):
        _parse(rows)


# A file at exactly the row cap is unaffected -- the cap is on data rows, not
# on the header, so it shouldn't cost a caller their last legitimate row.
def test_file_at_row_cap_is_accepted(monkeypatch):
    monkeypatch.setattr(patient_import, "MAX_UPLOAD_ROWS", 2)
    rows = [
        REQUIRED_COLUMNS,
        ["P-001", "Ada", "Lovelace", "1990-01-15", "Female"],
        ["P-002", "Grace", "Hopper", "1975-06-01", "Other"],
    ]
    result = _parse(rows)
    assert result.total_rows == 2
    assert len(result.accepted) == 2


# Blank required field rejects row.
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


# Bad date format rejects row.
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


# Future date rejects row.
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


# Invalid gender rejects row.
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


# Duplicate patient id within file rejects both rows.
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


# Existing patient code for manager rejects row.
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


# Formula injection in name field rejects row.
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


# Unsupported extension raises.
def test_unsupported_extension_raises():
    with pytest.raises(PatientImportError, match="Unsupported file type"):
        parse_patient_upload(filename="patients.csv", content=b"whatever")


# --- .xls (legacy format) --------------------------------------------------
# xlrd can only read .xls, not write one, and this repo has no writer for it
# (no xlwt, no checked-in .xls fixture) -- so unlike the .xlsx tests above,
# these can't round-trip a real file through openpyxl. What actually needs
# covering is _read_xls's own row-cap check, not xlrd's file format (which
# has its own upstream tests), so xlrd.open_workbook is stubbed with a
# minimal fake sheet -- the same kind of isolation this module already
# gets from FastAPI and the DB in the tests above it.
class _FakeXlsCell:
    def __init__(self, value):
        self.value = value
        self.ctype = xlrd.XL_CELL_TEXT  # only DATE/EMPTY are special-cased by _read_xls; anything else reads as-is


class _FakeXlsSheet:
    def __init__(self, rows: list[list]):
        self._rows = rows
        self.nrows = len(rows)
        self.ncols = len(rows[0]) if rows else 0

    def cell(self, row_index: int, col_index: int) -> _FakeXlsCell:
        return _FakeXlsCell(self._rows[row_index][col_index])


class _FakeXlsWorkbook:
    def __init__(self, rows: list[list]):
        self._sheet = _FakeXlsSheet(rows)
        self.datemode = 0

    def sheet_by_index(self, index: int) -> _FakeXlsSheet:
        return self._sheet


def _stub_xls_reader(monkeypatch, rows: list[list]) -> None:
    monkeypatch.setattr(xlrd, "open_workbook", lambda file_contents: _FakeXlsWorkbook(rows))


# A .xls file over the row cap is rejected before any row is validated, same
# as .xlsx -- checked against sheet.nrows up front rather than while
# iterating, since xlrd (unlike openpyxl's read_only mode) has already
# parsed the whole file into memory by the time _read_xls gets it.
def test_xls_file_over_row_cap_raises_before_row_processing(monkeypatch):
    monkeypatch.setattr(patient_import, "MAX_UPLOAD_ROWS", 2)
    rows = [
        REQUIRED_COLUMNS,
        ["P-001", "Ada", "Lovelace", "1990-01-15", "Female"],
        ["P-002", "Grace", "Hopper", "1975-06-01", "Other"],
        ["P-003", "Alan", "Turing", "1912-06-23", "Male"],  # the 3rd data row, over the cap of 2
    ]
    _stub_xls_reader(monkeypatch, rows)

    with pytest.raises(PatientImportError, match="2-row limit"):
        parse_patient_upload(filename="patients.xls", content=b"irrelevant -- xlrd.open_workbook is stubbed")


# A .xls file at exactly the row cap is accepted, and parses like any other
# -- exercises the rest of _read_xls (the date/empty-cell handling in its
# per-cell loop) too, not just the cap check above.
def test_xls_file_at_row_cap_is_accepted(monkeypatch):
    monkeypatch.setattr(patient_import, "MAX_UPLOAD_ROWS", 2)
    rows = [
        REQUIRED_COLUMNS,
        ["P-001", "Ada", "Lovelace", "1990-01-15", "Female"],
        ["P-002", "Grace", "Hopper", "1975-06-01", "Other"],
    ]
    _stub_xls_reader(monkeypatch, rows)

    result = parse_patient_upload(filename="patients.xls", content=b"irrelevant -- xlrd.open_workbook is stubbed")

    assert result.total_rows == 2
    assert len(result.accepted) == 2
    assert result.accepted[0]["patient_code"] == "P-001"


class TestOptionalFields:
    # All optional columns present and valid are parsed.
    def test_all_optional_columns_present_and_valid_are_parsed(self):
        header = REQUIRED_COLUMNS + OPTIONAL_COLUMNS
        row = [
            "P-001", "Ada", "Lovelace", "1990-01-15", "Female",
            "123 Main St", "Springfield", "IL", "62704", "217-555-0100", "ada@example.com",
            "Charles Babbage", "Spouse", "217-555-0101",
            "English", "White", "Married", "Mathematician",
            "Blue Cross Blue Shield", "POL123456", "Dr. Hopper",
            "Cardiology", "2020-05-01", "2024-11-03", "CVS Pharmacy", "O+",
            "68", "150", "128", "82",
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
        assert accepted["care_department"] == "Cardiology"
        assert accepted["registration_date"] == "2020-05-01"
        assert accepted["last_visit_date"] == "2024-11-03"
        assert accepted["blood_type"] == "O+"
        assert accepted["height_in"] == 68
        assert accepted["weight_lbs"] == 150
        assert accepted["systolic_bp"] == 128
        assert accepted["diastolic_bp"] == 82
        assert accepted["allergies"] == ["Penicillin", "Peanuts"]
        assert accepted["current_medications"] == ["Metformin", "Lisinopril"]
        assert accepted["chronic_conditions"] == ["I10 - Essential hypertension"]
        assert accepted["immunization_history"] == ["Influenza (2023-04-01)"]
        assert accepted["smoking_status"] == "Never smoker"
        assert accepted["alcohol_use"] == "Occasional"

    # Blank optional cells are accepted as none.
    def test_blank_optional_cells_are_accepted_as_none(self):
        header = REQUIRED_COLUMNS + ["Email", "Blood Type"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "", None]
        result = _parse([header, row])

        assert result.rejected == []
        assert result.accepted[0]["email"] is None
        assert result.accepted[0]["blood_type"] is None

    # Invalid email rejects row.
    def test_invalid_email_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Email"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "not-an-email"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Email"

    # Invalid state rejects row.
    def test_invalid_state_rejects_row(self):
        header = REQUIRED_COLUMNS + ["State"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "ZZ"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "State"

    # Invalid zip rejects row.
    def test_invalid_zip_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Zip"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "not-a-zip"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Zip"

    # Numeric zip keeps leading zero.
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

    # Invalid blood type rejects row.
    def test_invalid_blood_type_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Blood Type"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "Z+"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Blood Type"

    # Registration date in future rejects row.
    def test_registration_date_in_future_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Registration Date"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", date.today() + timedelta(days=1)]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Registration Date"
        assert "future" in result.rejected[0].reason.lower()

    # Phone with leading plus is accepted.
    def test_phone_with_leading_plus_is_accepted(self):
        # Regression test: Faker's phone_number() routinely emits "+1-..."
        # formats, and the generic formula-injection guard (which flags any
        # leading +/-/=/@) would otherwise reject every one of them.
        header = REQUIRED_COLUMNS + ["Phone"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "+1-217-555-0100"]
        result = _parse([header, row])

        assert result.rejected == []
        assert result.accepted[0]["phone"] == "+1-217-555-0100"

    # Multi value all blank cell is none.
    def test_multi_value_all_blank_cell_is_none(self):
        header = REQUIRED_COLUMNS + ["Allergies"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "  ,  ,"]
        result = _parse([header, row])

        assert result.rejected == []
        assert result.accepted[0]["allergies"] is None

    # Multi value formula injection token rejects row.
    def test_multi_value_formula_injection_token_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Allergies"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "Penicillin, =cmd|'/c calc'!A1"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Allergies"
        assert "formula" in result.rejected[0].reason.lower()

    # Height boundaries accepted.
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

    # Height out of range rejects row.
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

    # Bool height value is rejected not coerced.
    def test_bool_height_value_is_rejected_not_coerced(self):
        header = REQUIRED_COLUMNS + ["Height (in)"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", True]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Height (in)"

    # Invalid care department rejects row.
    def test_invalid_care_department_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Care Department"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "Dermatology"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Care Department"

    # Last visit date in future rejects row.
    def test_last_visit_date_in_future_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Last Visit Date"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", date.today() + timedelta(days=1)]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Last Visit Date"
        assert "future" in result.rejected[0].reason.lower()

    # Bp boundaries accepted.
    def test_bp_boundaries_accepted(self):
        header = REQUIRED_COLUMNS + ["Systolic BP", "Diastolic BP"]
        rows = [
            header,
            ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", 60, 30],
            ["P-002", "Grace", "Hopper", "1990-01-15", "Female", 250, 150],
        ]
        result = _parse(rows)

        assert result.rejected == []
        assert [row["systolic_bp"] for row in result.accepted] == [60, 250]
        assert [row["diastolic_bp"] for row in result.accepted] == [30, 150]

    # Bp out of range rejects row.
    def test_bp_out_of_range_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Systolic BP", "Diastolic BP"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", 59, 151]
        result = _parse([header, row])

        assert len(result.rejected) == 2
        assert {rejected.field for rejected in result.rejected} == {"Systolic BP", "Diastolic BP"}

    # Registration date before birth rejects row.
    def test_registration_date_before_birth_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Registration Date"]
        row = ["P-001", "Ada", "Lovelace", "2020-01-15", "Female", "2019-01-01"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Registration Date"
        assert "before Date of Birth" in result.rejected[0].reason

    # Last visit date before birth rejects row.
    def test_last_visit_date_before_birth_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Last Visit Date"]
        row = ["P-001", "Ada", "Lovelace", "2020-01-15", "Female", "2019-01-01"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Last Visit Date"
        assert "before Date of Birth" in result.rejected[0].reason

    # Last visit date before registration date rejects row.
    def test_last_visit_date_before_registration_date_rejects_row(self):
        header = REQUIRED_COLUMNS + ["Registration Date", "Last Visit Date"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "2022-06-01", "2022-01-01"]
        result = _parse([header, row])

        assert result.accepted == []
        assert result.rejected[0].field == "Last Visit Date"
        assert "before Registration Date" in result.rejected[0].reason

    # Last visit date on registration date itself is accepted.
    def test_last_visit_date_on_registration_date_itself_is_accepted(self):
        header = REQUIRED_COLUMNS + ["Registration Date", "Last Visit Date"]
        row = ["P-001", "Ada", "Lovelace", "1990-01-15", "Female", "2022-06-01", "2022-06-01"]
        result = _parse([header, row])

        assert result.rejected == []
        assert result.accepted[0]["last_visit_date"] == "2022-06-01"

    # Date on birth date itself is accepted.
    def test_date_on_birth_date_itself_is_accepted(self):
        # Boundary case: a registration date equal to (not before) Date of
        # Birth is legitimate -- e.g. a newborn registered on their birth date.
        header = REQUIRED_COLUMNS + ["Registration Date"]
        row = ["P-001", "Ada", "Lovelace", "2020-01-15", "Female", "2020-01-15"]
        result = _parse([header, row])

        assert result.rejected == []
        assert result.accepted[0]["registration_date"] == "2020-01-15"

    # Registration date before birth not flagged when birth date itself invalid.
    def test_registration_date_before_birth_not_flagged_when_birth_date_itself_invalid(self):
        # When Date of Birth already failed validation, there's nothing valid
        # to compare Registration Date against -- only the DOB error should
        # be reported, not a second, derived error on Registration Date.
        header = REQUIRED_COLUMNS + ["Registration Date"]
        row = ["P-001", "Ada", "Lovelace", "not-a-date", "Female", "2019-01-01"]
        result = _parse([header, row])

        assert result.accepted == []
        assert [rejected.field for rejected in result.rejected] == ["Date of Birth"]
