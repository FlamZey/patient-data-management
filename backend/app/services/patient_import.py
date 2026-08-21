"""Parses and validates an uploaded patient spreadsheet before anything is
encrypted or written to the DB. Pure Python in and out (raw bytes + filename
in, a plain dataclass result out) -- no FastAPI or DB imports, so this is
independently unit-testable and reusable regardless of how the file arrives.
"""

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime
from io import BytesIO
from typing import Any, Iterable, Literal, get_args

import openpyxl
import xlrd

REQUIRED_COLUMNS = ["Patient ID", "First Name", "Last Name", "Date of Birth", "Gender"]

# The Literal is the single source of truth for allowed values -- ALLOWED_GENDERS
# is derived from it for runtime membership checks, and schemas.PatientUpdate
# imports the Literal itself for its own type annotation, so the two never drift.
Gender = Literal["Male", "Female", "Other", "Prefer not to say"]
ALLOWED_GENDERS: tuple[str, ...] = get_args(Gender)

MAX_AGE_YEARS = 130

_PATIENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]+$")
_FORMULA_TRIGGER_CHARS = ("=", "+", "-", "@")
_DATE_STRING_FORMATS = ("%Y-%m-%d", "%m/%d/%Y")


class PatientImportError(Exception):
    """Raised when the whole file must be rejected before any row is
    processed: an unsupported extension, an unreadable workbook, or a header
    row that doesn't have exactly the required columns."""


@dataclass
class RejectedRow:
    row: int
    field: str
    reason: str


@dataclass
class PatientImportResult:
    total_rows: int
    accepted: list[dict] = field(default_factory=list)
    rejected: list[RejectedRow] = field(default_factory=list)


def parse_patient_upload(
    *, filename: str, content: bytes, existing_patient_codes: Iterable[str] = ()
) -> PatientImportResult:
    """existing_patient_codes are the Patient.patient_code values already
    owned by the uploading manager -- passed in rather than queried here so
    this module stays DB-free. Raises PatientImportError for whole-file
    failures; per-row failures are collected in the returned result instead."""
    rows = _read_workbook(filename, content)
    if not rows:
        raise PatientImportError("The file is empty.")

    header_row, *data_rows = rows
    column_index = _validate_header(header_row)

    indexed_rows = [
        (row_number, row)
        for row_number, row in enumerate(data_rows, start=2)
        if _row_has_any_value(row)
    ]

    def cell(row: list, name: str) -> Any:
        idx = column_index[name]
        return row[idx] if idx < len(row) else None

    code_counts: Counter[str] = Counter()
    for _, row in indexed_rows:
        cleaned = _clean_str(cell(row, "Patient ID"))
        if cleaned:
            code_counts[cleaned] += 1

    existing_codes = set(existing_patient_codes)
    accepted: list[dict] = []
    rejected: list[RejectedRow] = []
    today = date.today()

    for row_number, row in indexed_rows:
        errors: dict[str, str] = {}

        patient_id, error = _validate_patient_id(
            cell(row, "Patient ID"), code_counts=code_counts, existing_codes=existing_codes
        )
        if error:
            errors["Patient ID"] = error

        first_name, error = _validate_name(cell(row, "First Name"), "First Name")
        if error:
            errors["First Name"] = error

        last_name, error = _validate_name(cell(row, "Last Name"), "Last Name")
        if error:
            errors["Last Name"] = error

        date_of_birth, error = _validate_date_of_birth(cell(row, "Date of Birth"), today=today)
        if error:
            errors["Date of Birth"] = error

        gender, error = _validate_gender(cell(row, "Gender"))
        if error:
            errors["Gender"] = error

        if errors:
            rejected.extend(
                RejectedRow(row=row_number, field=field_name, reason=reason)
                for field_name, reason in errors.items()
            )
            continue

        existing_codes.add(patient_id)
        accepted.append(
            {
                "patient_code": patient_id,
                "first_name": first_name,
                "last_name": last_name,
                "date_of_birth": date_of_birth,
                "gender": gender,
            }
        )

    return PatientImportResult(total_rows=len(indexed_rows), accepted=accepted, rejected=rejected)


def _read_workbook(filename: str, content: bytes) -> list[list]:
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if extension == "xlsx":
        return _read_xlsx(content)
    if extension == "xls":
        return _read_xls(content)
    raise PatientImportError(f"Unsupported file type for '{filename}'. Only .xlsx and .xls files are accepted.")


def _read_xlsx(content: bytes) -> list[list]:
    # data_only=False (the default) is deliberate: a formula cell then reads
    # back as its raw "=..." text instead of Excel's last-cached computed
    # value, so a formula-injection payload can't hide behind a result that
    # looks benign -- our guard needs to see the literal leading character.
    try:
        workbook = openpyxl.load_workbook(BytesIO(content), read_only=True)
    except Exception as exc:
        raise PatientImportError(f"Could not read .xlsx file: {exc}") from exc
    sheet = workbook.worksheets[0]
    return [list(row) for row in sheet.iter_rows(values_only=True)]


def _read_xls(content: bytes) -> list[list]:
    try:
        workbook = xlrd.open_workbook(file_contents=content)
    except Exception as exc:
        raise PatientImportError(f"Could not read .xls file: {exc}") from exc
    sheet = workbook.sheet_by_index(0)
    rows = []
    for r in range(sheet.nrows):
        row = []
        for c in range(sheet.ncols):
            xls_cell = sheet.cell(r, c)
            if xls_cell.ctype == xlrd.XL_CELL_DATE:
                row.append(xlrd.xldate_as_datetime(xls_cell.value, workbook.datemode))
            elif xls_cell.ctype == xlrd.XL_CELL_EMPTY:
                row.append(None)
            else:
                row.append(xls_cell.value)
        rows.append(row)
    return rows


def _validate_header(header_row: list) -> dict[str, int]:
    column_index: dict[str, int] = {}
    for idx, raw_name in enumerate(header_row):
        name = _clean_str(raw_name)
        if name:
            column_index[name] = idx

    required = set(REQUIRED_COLUMNS)
    present = set(column_index)
    missing = required - present
    unexpected = present - required
    if missing or unexpected:
        parts = []
        if missing:
            parts.append(f"missing: {', '.join(sorted(missing))}")
        if unexpected:
            parts.append(f"unexpected: {', '.join(sorted(unexpected))}")
        raise PatientImportError(f"Header row does not match the required columns ({'; '.join(parts)}).")

    return column_index


def _row_has_any_value(row: list) -> bool:
    return any(_clean_str(value) for value in row)


def _clean_str(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, float) and raw.is_integer():
        return str(int(raw))
    return str(raw).strip()


def _check_formula_injection(raw: Any) -> str | None:
    if isinstance(raw, str) and raw.strip().startswith(_FORMULA_TRIGGER_CHARS):
        return "Value starts with a spreadsheet formula character and is not allowed."
    return None


def _validate_patient_id(
    raw: Any, *, code_counts: Counter, existing_codes: set[str]
) -> tuple[str | None, str | None]:
    value = _clean_str(raw)
    if not value:
        return None, "Patient ID is required."
    formula_error = _check_formula_injection(raw)
    if formula_error:
        return None, formula_error
    if not _PATIENT_ID_PATTERN.match(value):
        return None, "Patient ID must contain only letters, digits, and hyphens."
    if code_counts[value] > 1:
        return None, "Duplicate Patient ID within this file."
    if value in existing_codes:
        return None, "Patient ID already exists for this manager."
    return value, None


def _validate_name(raw: Any, field_label: str) -> tuple[str | None, str | None]:
    value = _clean_str(raw)
    if not value:
        return None, f"{field_label} is required."
    formula_error = _check_formula_injection(raw)
    if formula_error:
        return None, formula_error
    return value, None


def _validate_gender(raw: Any) -> tuple[str | None, str | None]:
    value = _clean_str(raw)
    if not value:
        return None, "Gender is required."
    formula_error = _check_formula_injection(raw)
    if formula_error:
        return None, formula_error
    if value not in ALLOWED_GENDERS:
        return None, f"Gender must be one of: {', '.join(ALLOWED_GENDERS)}."
    return value, None


def _validate_date_of_birth(raw: Any, *, today: date) -> tuple[str | None, str | None]:
    if raw is None or (isinstance(raw, str) and not raw.strip()):
        return None, "Date of Birth is required."
    formula_error = _check_formula_injection(raw)
    if formula_error:
        return None, formula_error
    parsed = _parse_date(raw)
    if parsed is None:
        return None, "Date of Birth must be a valid date (YYYY-MM-DD or MM/DD/YYYY)."
    if parsed > today:
        return None, "Date of Birth cannot be in the future."
    if parsed < _years_before(today, MAX_AGE_YEARS):
        return None, f"Date of Birth cannot be more than {MAX_AGE_YEARS} years in the past."
    return parsed.isoformat(), None


def validate_date_of_birth(raw: Any) -> str:
    """Validates a Date of Birth value with the same rules as the upload
    flow (Excel date cell, or ISO/US date string; rejects future dates or
    those more than MAX_AGE_YEARS in the past). Returns the ISO date string
    on success, raises ValueError otherwise -- shared with PatientUpdate in
    schemas.py so manual edits enforce the same rule as bulk upload."""
    value, error = _validate_date_of_birth(raw, today=date.today())
    if error:
        raise ValueError(error)
    return value


def _parse_date(raw: Any) -> date | None:
    if isinstance(raw, datetime):
        return raw.date()
    if isinstance(raw, date):
        return raw
    if isinstance(raw, str):
        text = raw.strip()
        for fmt in _DATE_STRING_FORMATS:
            try:
                return datetime.strptime(text, fmt).date()
            except ValueError:
                continue
    return None


def _years_before(base: date, years: int) -> date:
    try:
        return base.replace(year=base.year - years)
    except ValueError:
        # base is Feb 29 and base.year - years isn't a leap year.
        return base.replace(month=2, day=28, year=base.year - years)
