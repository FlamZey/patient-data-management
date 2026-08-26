"""Patient upload, listing, viewing, editing, and deletion.

PHI (first_name/last_name/date_of_birth/gender) is stored encrypted (see
app.core.encryption) and only patient_code stays plaintext. A caller sees
only Patient rows they uploaded (uploaded_by == current_user.id) unless
they hold "patient.view_all" (admin only, per the seed permissions), in
which case they see every manager's rows.
"""

import json
from collections import Counter
from dataclasses import asdict
from datetime import date
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import asc, desc, func
from sqlalchemy.orm import Session, load_only

from app.core.deps import require_permission
from app.core.encryption import DecryptionError, decrypt_field, encrypt_field
from app.core.limiter import limiter
from app.database import get_db
from app.models import AuditLog, Patient, PatientUpload, User
from app.schemas import PatientListResponse, PatientRead, PatientUpdate
from app.services.patient_import import (
    INT_FIELDS,
    MULTI_VALUE_FIELDS,
    OPTIONAL_FIELD_NAMES,
    PatientImportError,
    PatientImportResult,
    parse_patient_upload_streaming,
)

router = APIRouter(prefix="/patients", tags=["patients"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024

# Rows are encrypted+inserted in chunks (rather than one bulk_save_objects
# call for the whole file) specifically so that phase can report progress
# too -- profiling this session showed encryption, not validation, is the
# dominant cost for a large upload. Small enough to still batch into few
# INSERTs (20 for a 10,000-row file), nowhere near the one-INSERT-per-row
# cost that batching was originally introduced to avoid.
UPLOAD_WRITE_CHUNK_SIZE = 500

_UPDATE_FIELD_TO_COLUMN = {
    "first_name": "first_name_enc",
    "last_name": "last_name_enc",
    "date_of_birth": "date_of_birth_enc",
    "gender": "gender_enc",
    **{field_name: f"{field_name}_enc" for field_name in OPTIONAL_FIELD_NAMES},
}


def _serialize_for_encryption(field_name: str, value: Any) -> str:
    if field_name in INT_FIELDS:
        return str(value)
    if field_name in MULTI_VALUE_FIELDS:
        return json.dumps(value)
    return value


def _deserialize_after_decryption(field_name: str, token: str | None) -> Any:
    if token is None:
        return None
    plaintext = decrypt_field(token)
    if field_name in INT_FIELDS:
        return int(plaintext)
    if field_name in MULTI_VALUE_FIELDS:
        return json.loads(plaintext)
    return plaintext


def _maybe_encrypt(field_name: str, value: Any) -> str | None:
    return encrypt_field(_serialize_for_encryption(field_name, value)) if value is not None else None


def _can_view_all(user: User) -> bool:
    return "patient.view_all" in {permission.code for permission in user.role.permissions}


def _get_patient_or_404(db: Session, patient_id: UUID, current_user: User) -> Patient:
    query = db.query(Patient).filter(Patient.id == patient_id)
    if not _can_view_all(current_user):
        query = query.filter(Patient.uploaded_by == current_user.id)
    patient = query.one_or_none()
    if patient is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Patient not found")
    return patient


def _decrypt_patient(patient: Patient) -> PatientRead:
    optional_fields = {
        field_name: _deserialize_after_decryption(field_name, getattr(patient, f"{field_name}_enc"))
        for field_name in OPTIONAL_FIELD_NAMES
    }
    return PatientRead(
        id=patient.id,
        patient_code=patient.patient_code,
        first_name=decrypt_field(patient.first_name_enc),
        last_name=decrypt_field(patient.last_name_enc),
        date_of_birth=decrypt_field(patient.date_of_birth_enc),
        gender=decrypt_field(patient.gender_enc),
        uploaded_by=patient.uploaded_by,
        created_at=patient.created_at,
        updated_at=patient.updated_at,
        **optional_fields,
    )


# The 4 fields list_patients' slow path ever filters or sorts on. Used to
# decrypt just those for every candidate row instead of all 31 -- the other
# 27 optional fields are display-only there and would be wasted work for
# whatever gets filtered out or lands on a different page (see list_patients).
def _decrypt_core_fields(patient: Patient) -> dict[str, str]:
    return {
        "patient_code": patient.patient_code,  # already plaintext, no decryption needed
        "first_name": decrypt_field(patient.first_name_enc),
        "last_name": decrypt_field(patient.last_name_enc),
        "date_of_birth": decrypt_field(patient.date_of_birth_enc),
        "gender": decrypt_field(patient.gender_enc),
    }


def _progress_line(phase: str, processed: int, total: int) -> str:
    return json.dumps({"type": "progress", "phase": phase, "processed": processed, "total": total}) + "\n"


@router.post("/upload", status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
def upload_patients(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("patient.edit")),
) -> StreamingResponse:
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="A filename is required")

    content = file.file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="File exceeds the 10MB upload limit",
        )

    existing_codes = {
        code
        for (code,) in db.query(Patient.patient_code).filter(Patient.uploaded_by == current_user.id)
    }
    filename = file.filename

    # Reading/header-validation happens on this first next() call, which
    # runs synchronously here -- before any streaming begins -- even though
    # it's textually the first lines of a generator function, because a
    # generator's body doesn't execute at all until first iterated. That's
    # what lets a whole-file failure (bad extension, missing/extra columns)
    # still raise PatientImportError here and become a clean 422, same as
    # before this endpoint streamed anything: once the first chunk of a
    # StreamingResponse is sent, the status code can no longer change, so
    # this check has to happen before that point, not inside the stream.
    parsed_rows = parse_patient_upload_streaming(
        filename=filename, content=content, existing_patient_codes=existing_codes
    )
    try:
        first_item = next(parsed_rows)
    except PatientImportError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc

    def generate():
        item = first_item
        while not isinstance(item, PatientImportResult):
            processed, total = item
            yield _progress_line("validating", processed, total)
            item = next(parsed_rows)
        result = item

        upload = PatientUpload(
            manager_id=current_user.id,
            original_filename=filename,
            status="completed",
            total_rows=result.total_rows,
            accepted_rows=len(result.accepted),
            rejected_rows=len(result.rejected),
            error_detail=[asdict(row) for row in result.rejected] or None,
        )
        db.add(upload)
        db.flush()  # realizes upload.id (a Python-side uuid4 default) so every chunk below can reference it

        # Chunked instead of one bulk_save_objects call for the whole file,
        # so this phase -- encryption, the dominant cost for a large upload
        # -- reports progress too, not just row validation above. Every
        # optional field is still passed explicitly per row (value or None
        # via _maybe_encrypt), never omitted as a kwarg -- omitting kwargs
        # conditionally would give each Patient() instance in a chunk a
        # different populated-column set, fragmenting that chunk's single
        # INSERT into several. Each yield below hands control back to
        # Starlette's iterate_in_threadpool, which may resume this generator
        # on a different worker thread next call -- safe only because calls
        # are strictly sequential, never concurrent, so `db` (not
        # thread-safe for concurrent use) is never touched by two threads
        # at once.
        accepted_rows = result.accepted
        write_total = len(accepted_rows)
        for start in range(0, write_total, UPLOAD_WRITE_CHUNK_SIZE):
            chunk = accepted_rows[start : start + UPLOAD_WRITE_CHUNK_SIZE]
            db.bulk_save_objects(
                [
                    Patient(
                        patient_code=row["patient_code"],
                        first_name_enc=encrypt_field(row["first_name"]),
                        last_name_enc=encrypt_field(row["last_name"]),
                        date_of_birth_enc=encrypt_field(row["date_of_birth"]),
                        gender_enc=encrypt_field(row["gender"]),
                        **{
                            f"{field_name}_enc": _maybe_encrypt(field_name, row[field_name])
                            for field_name in OPTIONAL_FIELD_NAMES
                        },
                        uploaded_by=current_user.id,
                        upload_id=upload.id,
                    )
                    for row in chunk
                ]
            )
            yield _progress_line("saving", min(start + UPLOAD_WRITE_CHUNK_SIZE, write_total), write_total)

        db.add(
            AuditLog(
                user_id=current_user.id,
                event_type="patient_upload",
                event_detail={
                    "upload_id": str(upload.id),
                    "filename": filename,
                    "total_rows": result.total_rows,
                    "accepted_rows": len(result.accepted),
                    "rejected_rows": len(result.rejected),
                },
                ip_address=request.client.host if request.client else None,
                user_agent=request.headers.get("user-agent"),
            )
        )
        db.commit()

        yield json.dumps(
            {
                "type": "done",
                "accepted": len(result.accepted),
                "rejected": [asdict(row) for row in result.rejected],
                "upload_id": str(upload.id),
            }
        ) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson", status_code=status.HTTP_201_CREATED)


@router.get("", response_model=PatientListResponse)
def list_patients(
    patient_code: str | None = None,
    first_name: str | None = None,
    last_name: str | None = None,
    gender: list[str] | None = Query(None),
    date_of_birth_from: str | None = None,
    date_of_birth_to: str | None = None,
    sort_by: Literal["patient_code", "first_name", "last_name", "date_of_birth"] = "patient_code",
    sort_dir: Literal["asc", "desc"] = "asc",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("patient.view")),
) -> PatientListResponse:
    query = db.query(Patient)
    if not _can_view_all(current_user):
        query = query.filter(Patient.uploaded_by == current_user.id)

    # patient_code is the one field stored unencrypted (see the Patient
    # docstring), so it can always be filtered in SQL -- this narrows what
    # gets decrypted below even on requests that also need a PHI filter.
    if patient_code:
        query = query.filter(Patient.patient_code.ilike(f"{patient_code.strip()}%"))

    # Every other filterable/sortable field is encrypted, so it can only be
    # matched/ordered after decryption. When none of them are requested and
    # the sort is on the one plaintext column, the whole request can be
    # resolved in SQL -- sort and paginate there, and decrypt only the page
    # actually being returned instead of every row the caller can see.
    phi_filter_requested = bool(first_name or last_name or gender or date_of_birth_from or date_of_birth_to)

    if sort_by == "patient_code" and not phi_filter_requested:
        total = query.count()
        order_fn = asc if sort_dir == "asc" else desc
        start = (page - 1) * page_size
        page_rows = (
            query.order_by(order_fn(func.lower(Patient.patient_code)))
            .offset(start)
            .limit(page_size)
            .all()
        )
        return PatientListResponse(items=[_decrypt_patient(patient) for patient in page_rows], total=total)

    # Otherwise decrypt whatever SQL was able to narrow down above (uploader
    # scope, plus the patient_code filter if one was given) and finish
    # filtering/sorting/pagination here, same as before. Each PHI filter
    # narrows independently (AND, not OR) -- e.g. first_name=ada&gender=F
    # only matches rows satisfying both.
    #
    # Only _decrypt_core_fields (4 fields) runs on every candidate row here --
    # filtering/sorting never look at the other 27 optional fields, so paying
    # for those on rows that get filtered out or fall on a different page
    # would be wasted decryption. _decrypt_patient (all 31 fields) only runs
    # on the page actually being returned, below.
    candidates = [(patient, _decrypt_core_fields(patient)) for patient in query.all()]

    if first_name:
        needle = first_name.strip().lower()
        candidates = [c for c in candidates if c[1]["first_name"].lower().startswith(needle)]

    if last_name:
        needle = last_name.strip().lower()
        candidates = [c for c in candidates if c[1]["last_name"].lower().startswith(needle)]

    if gender:
        wanted = {value.strip().lower() for value in gender}
        candidates = [c for c in candidates if c[1]["gender"].lower() in wanted]

    # date_of_birth is stored/returned as "YYYY-MM-DD" -- that format sorts
    # lexicographically identically to chronologically, so plain string
    # comparison is enough for an inclusive range filter.
    if date_of_birth_from:
        candidates = [c for c in candidates if c[1]["date_of_birth"] >= date_of_birth_from]

    if date_of_birth_to:
        candidates = [c for c in candidates if c[1]["date_of_birth"] <= date_of_birth_to]

    candidates.sort(key=lambda c: c[1][sort_by].lower(), reverse=sort_dir == "desc")

    total = len(candidates)
    start = (page - 1) * page_size
    page_candidates = candidates[start : start + page_size]

    return PatientListResponse(
        items=[_decrypt_patient(patient) for patient, _ in page_candidates], total=total
    )


# --- analytics dataset -------------------------------------------------------
# GET /patients/analytics-dataset returns a DE-IDENTIFIED projection for the
# analytics dashboard, deliberately much narrower than PatientRead. Every
# direct identifier is absent: no patient id, no patient_code, no name,
# address, phone, email, policy number, or PCP name -- and no exact dates
# (date of birth becomes an integer age, registration/last-visit dates are
# truncated to year-month). Those columns are never even decrypted here,
# except the three needed for the server-side quality checks below, which
# emit aggregate counts only and never the underlying values.
#
# Occupation is excluded for a different reason: it's free text with
# thousands of distinct values, useless as a chart/segmentation category
# and a meaningful chunk of the payload. Allergies and immunization history
# are excluded simply because nothing in the dashboard charts them yet.

ANALYTICS_CATEGORICAL_FIELDS: tuple[str, ...] = (
    "gender",
    "state",
    "race_ethnicity",
    "marital_status",
    "insurance_provider",
    "preferred_pharmacy",
    "blood_type",
    "smoking_status",
    "alcohol_use",
    "care_department",
)
ANALYTICS_NUMERIC_FIELDS: tuple[str, ...] = ("height_in", "weight_lbs", "systolic_bp", "diastolic_bp")
ANALYTICS_MULTI_VALUE_FIELDS: tuple[str, ...] = ("chronic_conditions", "current_medications")
# Emitted truncated to "YYYY-MM" rather than the full date -- month precision
# is all the trend charts need, and a full date is far more re-identifying.
ANALYTICS_MONTH_FIELDS: tuple[str, ...] = ("registration_date", "last_visit_date")

# Decrypted for the duplicate-identity and date-before-birth quality checks
# only. date_of_birth additionally becomes the emitted `age`; the two name
# fields never leave this module in any form.
_ANALYTICS_IDENTITY_FIELDS: tuple[str, ...] = ("first_name", "last_name", "date_of_birth")

_ANALYTICS_DECRYPTED_FIELDS: tuple[str, ...] = (
    *_ANALYTICS_IDENTITY_FIELDS,
    *ANALYTICS_CATEGORICAL_FIELDS,
    *ANALYTICS_NUMERIC_FIELDS,
    *ANALYTICS_MULTI_VALUE_FIELDS,
    *ANALYTICS_MONTH_FIELDS,
)

# Only the columns above are SELECTed. Patient has 35 encrypted columns and
# this projection reads 21 of them -- load_only keeps Postgres from shipping
# (and SQLAlchemy from holding) the ~14 wide Text columns this endpoint would
# immediately throw away, which is the single cheapest win available here
# given every one of those columns holds a base64 AES-GCM blob.
_ANALYTICS_LOAD_COLUMNS = tuple(
    getattr(Patient, f"{field_name}_enc") for field_name in _ANALYTICS_DECRYPTED_FIELDS
)

# Rows are streamed from the DB and decrypted in batches this size, with a
# progress line after each -- decryption of the whole table is the dominant
# cost (same finding as the upload path, ~21 AES-GCM opens per row), so the
# client gets a real progress bar instead of a silent multi-second wait.
ANALYTICS_BATCH_SIZE = 500


class _DictionaryEncoder:
    """Assigns each distinct string an integer code, so a categorical column
    ships as one small value list plus an int-per-row code list instead of
    repeating the same strings thousands of times. On a 10,000-row export
    that's the difference between a multi-megabyte payload and a small one."""

    def __init__(self) -> None:
        self.values: list[str] = []
        self._codes: dict[str, int] = {}

    def code(self, value: str | None) -> int | None:
        if value is None:
            return None
        code = self._codes.get(value)
        if code is None:
            code = len(self.values)
            self._codes[value] = code
            self.values.append(value)
        return code


def _age_on(date_of_birth: str, today: date) -> int | None:
    """date_of_birth is stored as an ISO "YYYY-MM-DD" string (see
    patient_import._validate_date_of_birth). Returns None rather than raising
    if a legacy row somehow holds an unparseable value -- that row still
    counts toward the dataset, just with no age."""
    try:
        born = date.fromisoformat(date_of_birth)
    except ValueError:
        return None
    return today.year - born.year - ((today.month, today.day) < (born.month, born.day))


@router.get("/analytics-dataset")
@limiter.limit("10/minute")
def get_analytics_dataset(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("patient.view")),
) -> StreamingResponse:
    """Streams the de-identified analytics projection as newline-delimited
    JSON: progress lines while rows are decrypted, then one final "done" line
    carrying the columnar dataset. Same NDJSON+progress shape as
    /patients/upload, for the same reason -- the work is slow enough that a
    silent wait would look like a hang.

    Scoped exactly like list_patients: a caller sees only rows they uploaded
    unless they hold "patient.view_all"."""
    query = db.query(Patient).options(load_only(*_ANALYTICS_LOAD_COLUMNS))
    if not _can_view_all(current_user):
        query = query.filter(Patient.uploaded_by == current_user.id)

    total = query.count()

    def generate():
        today = date.today()
        categorical: dict[str, _DictionaryEncoder] = {name: _DictionaryEncoder() for name in ANALYTICS_CATEGORICAL_FIELDS}
        multi_value: dict[str, _DictionaryEncoder] = {name: _DictionaryEncoder() for name in ANALYTICS_MULTI_VALUE_FIELDS}

        columns: dict[str, list] = {name: [] for name in ANALYTICS_CATEGORICAL_FIELDS}
        columns.update({name: [] for name in ANALYTICS_NUMERIC_FIELDS})
        columns.update({name: [] for name in ANALYTICS_MULTI_VALUE_FIELDS})
        columns["age"] = []
        columns["registration_month"] = []
        columns["last_visit_month"] = []

        # Identity counts for the duplicate check. Keyed on casefolded
        # name + exact DOB and never emitted -- only the tallies below are.
        identity_counts: Counter[tuple[str, str, str]] = Counter()
        dates_before_birth = 0
        last_visit_before_registration = 0
        unreadable_rows = 0
        processed = 0
        emitted = 0

        # yield_per streams rows from the DB in batches instead of
        # materializing every ORM object up front -- the whole point of this
        # endpoint is to sweep the entire table, so loading it all at once is
        # exactly the case worth avoiding.
        for patient in query.yield_per(ANALYTICS_BATCH_SIZE):
            processed += 1
            try:
                values = {
                    field_name: _deserialize_after_decryption(
                        field_name, getattr(patient, f"{field_name}_enc")
                    )
                    for field_name in _ANALYTICS_DECRYPTED_FIELDS
                }
            except DecryptionError:
                # One corrupt row shouldn't take down the whole dashboard --
                # skip it and report the count, which is itself a data-quality
                # signal worth surfacing rather than swallowing.
                unreadable_rows += 1
                if processed % ANALYTICS_BATCH_SIZE == 0 or processed == total:
                    yield _progress_line("decrypting", processed, total)
                continue

            date_of_birth = values["date_of_birth"]
            identity_counts[
                (values["first_name"].casefold(), values["last_name"].casefold(), date_of_birth)
            ] += 1

            registration_date = values["registration_date"]
            last_visit_date = values["last_visit_date"]
            # Both stored as "YYYY-MM-DD", which compares lexicographically
            # the same as chronologically (same reasoning as list_patients'
            # date_of_birth range filter).
            if (registration_date is not None and registration_date < date_of_birth) or (
                last_visit_date is not None and last_visit_date < date_of_birth
            ):
                dates_before_birth += 1
            if registration_date is not None and last_visit_date is not None and last_visit_date < registration_date:
                last_visit_before_registration += 1

            for field_name in ANALYTICS_CATEGORICAL_FIELDS:
                columns[field_name].append(categorical[field_name].code(values[field_name]))
            for field_name in ANALYTICS_NUMERIC_FIELDS:
                columns[field_name].append(values[field_name])
            for field_name in ANALYTICS_MULTI_VALUE_FIELDS:
                items = values[field_name] or []
                columns[field_name].append([multi_value[field_name].code(item) for item in items])

            columns["age"].append(_age_on(date_of_birth, today))
            columns["registration_month"].append(registration_date[:7] if registration_date else None)
            columns["last_visit_month"].append(last_visit_date[:7] if last_visit_date else None)
            emitted += 1

            if processed % ANALYTICS_BATCH_SIZE == 0 or processed == total:
                yield _progress_line("decrypting", processed, total)

        duplicate_groups = [count for count in identity_counts.values() if count > 1]

        db.add(
            AuditLog(
                user_id=current_user.id,
                event_type="patient_analytics_view",
                # Row counts only -- this log must never contain PHI, same
                # rule as the patient_edit event above.
                event_detail={"row_count": emitted, "unreadable_rows": unreadable_rows},
                ip_address=request.client.host if request.client else None,
                user_agent=request.headers.get("user-agent"),
            )
        )
        db.commit()

        yield json.dumps(
            {
                "type": "done",
                "total": emitted,
                "categories": {name: encoder.values for name, encoder in categorical.items()},
                "multi_value_categories": {name: encoder.values for name, encoder in multi_value.items()},
                "columns": columns,
                "quality": {
                    "duplicate_identity_groups": len(duplicate_groups),
                    "duplicate_identity_rows": sum(duplicate_groups),
                    "dates_before_birth": dates_before_birth,
                    "last_visit_before_registration": last_visit_before_registration,
                    "unreadable_rows": unreadable_rows,
                },
            }
        ) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


@router.get("/{patient_id}", response_model=PatientRead)
def get_patient(
    patient_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("patient.view")),
) -> PatientRead:
    patient = _get_patient_or_404(db, patient_id, current_user)

    db.add(
        AuditLog(
            user_id=current_user.id,
            event_type="patient_view",
            event_detail={"patient_id": str(patient.id)},
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.commit()

    return _decrypt_patient(patient)


@router.patch("/{patient_id}", response_model=PatientRead)
def update_patient(
    patient_id: UUID,
    payload: PatientUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("patient.edit")),
) -> PatientRead:
    patient = _get_patient_or_404(db, patient_id, current_user)

    changed_fields = []
    for field_name, value in payload.model_dump(exclude_unset=True).items():
        if value is None:
            # first_name/last_name/date_of_birth/gender can't be null (the
            # DB columns are NOT NULL) -- an explicit null for one of those
            # is a no-op, same as omitting the field. Every optional field
            # can be nulled out, though: an explicit null (or, for a
            # multi-value field, [] -- validate_multi_value already turns
            # that into None) clears it to a real NULL, same as _maybe_encrypt
            # does on the upload path.
            if field_name not in OPTIONAL_FIELD_NAMES:
                continue
            setattr(patient, _UPDATE_FIELD_TO_COLUMN[field_name], None)
            changed_fields.append(field_name)
            continue
        setattr(patient, _UPDATE_FIELD_TO_COLUMN[field_name], encrypt_field(_serialize_for_encryption(field_name, value)))
        changed_fields.append(field_name)

    if changed_fields:
        patient.updated_by = current_user.id
        db.add(
            AuditLog(
                user_id=current_user.id,
                event_type="patient_edit",
                # Field names only -- never old/new values, this log must never contain PHI.
                event_detail={"patient_id": str(patient.id), "changed_fields": changed_fields},
                ip_address=request.client.host if request.client else None,
                user_agent=request.headers.get("user-agent"),
            )
        )
        db.commit()
        db.refresh(patient)

    return _decrypt_patient(patient)


@router.delete("/{patient_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_patient(
    patient_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("patient.delete")),
) -> None:
    patient = _get_patient_or_404(db, patient_id, current_user)

    db.add(
        AuditLog(
            user_id=current_user.id,
            event_type="patient_delete",
            event_detail={"patient_id": str(patient.id)},
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.delete(patient)
    db.commit()
