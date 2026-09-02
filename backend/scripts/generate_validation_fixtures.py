"""Generates sample/edge-case patient upload workbooks for docs/samples/,
plus a copy of the blank template into frontend/public/ so the upload UI
can link to a real downloadable file.

Run this after changing REQUIRED_COLUMNS/validation rules in
app.services.patient_import, so the samples stay representative:

    python -m scripts.generate_validation_fixtures
"""

from pathlib import Path

import openpyxl

from app.services.patient_import import OPTIONAL_COLUMNS, REQUIRED_COLUMNS

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLES_DIR = REPO_ROOT / "docs" / "samples"
TEMPLATE_PUBLIC_PATH = REPO_ROOT / "frontend" / "public" / "patient-upload-template.xlsx"

VALID_ROWS = [
    ["P-0001", "Ada", "Lovelace", "1990-01-15", "Female"],
    ["P-0002", "Alan", "Turing", "06/23/1912", "Male"],
    ["P-0003", "Grace", "Hopper", "1906-12-09", "Female"],
    ["P-0004", "Katherine", "Johnson", "08/26/1918", "Female"],
    ["P-0005", "Alonzo", "Church", "1903-06-14", "Male"],
    ["P-0006", "Radia", "Perlman", "1951-01-18", "Female"],
    ["P-0007", "Barbara", "Liskov", "11/07/1939", "Female"],
    ["P-0008", "Vint", "Cerf", "1943-06-23", "Male"],
    ["P-0009", "Margaret", "Hamilton", "08/17/1936", "Female"],
    ["P-0010", "Dennis", "Ritchie", "1941-09-09", "Male"],
    ["P-0011", "Frances", "Allen", "08/04/1932", "Female"],
    ["P-0012", "Edsger", "Dijkstra", "1930-05-11", "Male"],
    ["P-0013", "Adele", "Goldberg", "07/22/1945", "Other"],
    ["P-0014", "Donald", "Knuth", "1938-01-10", "Prefer not to say"],
    ["P-0015", "Shafi", "Goldwasser", "1958-11-14", "Female"],
]


def _write_workbook(path: Path, header: list[str], rows: list[list]) -> None:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    sheet.append(header)
    for row in rows:
        sheet.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    workbook.save(path)
    print(f"wrote {path.relative_to(REPO_ROOT)}")


def generate_valid_workbook() -> None:
    _write_workbook(SAMPLES_DIR / "valid_patients.xlsx", REQUIRED_COLUMNS, VALID_ROWS)


def generate_missing_column_workbook() -> None:
    # Gender omitted entirely -- fails the whole file before any row is read.
    header = [c for c in REQUIRED_COLUMNS if c != "Gender"]
    rows = [row[:-1] for row in VALID_ROWS[:5]]
    _write_workbook(SAMPLES_DIR / "missing_column.xlsx", header, rows)


def generate_bad_date_and_invalid_gender_workbook() -> None:
    rows = [
        ["P-1001", "Rex", "Morgan", "1990-01-15", "Female"],
        ["P-1002", "Sam", "Carter", "15-01-1990", "Male"],  # bad date format
        ["P-1003", "Jamie", "Fox", "1985-07-04", "Unspecified"],  # invalid gender
    ]
    _write_workbook(SAMPLES_DIR / "invalid_date_and_gender.xlsx", REQUIRED_COLUMNS, rows)


def generate_duplicate_patient_id_workbook() -> None:
    rows = [
        ["P-2001", "Chris", "Green", "1990-01-15", "Female"],
        ["P-2001", "Pat", "Brown", "1985-07-04", "Male"],  # same Patient ID as above
        ["P-2002", "Robin", "White", "1978-03-22", "Other"],
    ]
    _write_workbook(SAMPLES_DIR / "duplicate_patient_id.xlsx", REQUIRED_COLUMNS, rows)


def generate_template_workbook() -> None:
    # Optional columns are included so the downloadable template shows their
    # exact expected headers, with blank cells since none are required.
    rows = [["P-0001", "Jane", "Doe", "1990-01-15", "Female"] + [""] * len(OPTIONAL_COLUMNS)]
    _write_workbook(SAMPLES_DIR / "patient_upload_template.xlsx", REQUIRED_COLUMNS + OPTIONAL_COLUMNS, rows)
    TEMPLATE_PUBLIC_PATH.parent.mkdir(parents=True, exist_ok=True)
    TEMPLATE_PUBLIC_PATH.write_bytes((SAMPLES_DIR / "patient_upload_template.xlsx").read_bytes())
    print(f"wrote {TEMPLATE_PUBLIC_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    generate_valid_workbook()
    generate_missing_column_workbook()
    generate_bad_date_and_invalid_gender_workbook()
    generate_duplicate_patient_id_workbook()
    generate_template_workbook()
