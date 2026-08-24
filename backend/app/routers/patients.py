"""Patient upload, listing, viewing, editing, and deletion.

PHI (first_name/last_name/date_of_birth/gender) is stored encrypted (see
app.core.encryption) and only patient_code stays plaintext. A caller sees
only Patient rows they uploaded (uploaded_by == current_user.id) unless
they hold "patient.view_all" (admin only, per the seed permissions), in
which case they see every manager's rows.
"""

from dataclasses import asdict
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from sqlalchemy.orm import Session

from app.core.deps import require_permission
from app.core.encryption import decrypt_field, encrypt_field
from app.core.limiter import limiter
from app.database import get_db
from app.models import AuditLog, Patient, PatientUpload, User
from app.schemas import PatientListResponse, PatientRead, PatientUpdate, PatientUploadResult
from app.services.patient_import import PatientImportError, parse_patient_upload

router = APIRouter(prefix="/patients", tags=["patients"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024

_UPDATE_FIELD_TO_COLUMN = {
    "first_name": "first_name_enc",
    "last_name": "last_name_enc",
    "date_of_birth": "date_of_birth_enc",
    "gender": "gender_enc",
}


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
    )


@router.post("/upload", response_model=PatientUploadResult, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")
def upload_patients(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("patient.edit")),
) -> PatientUploadResult:
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

    try:
        result = parse_patient_upload(
            filename=file.filename, content=content, existing_patient_codes=existing_codes
        )
    except PatientImportError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc

    upload = PatientUpload(
        manager_id=current_user.id,
        original_filename=file.filename,
        status="completed",
        total_rows=result.total_rows,
        accepted_rows=len(result.accepted),
        rejected_rows=len(result.rejected),
        error_detail=[asdict(row) for row in result.rejected] or None,
    )
    db.add(upload)
    db.flush()

    # bulk_save_objects issues one batched INSERT instead of the row-by-row
    # add()s this used to do, which mattered once uploads hit the thousands
    # of rows. Per-field encrypt_field() calls stay row-by-row on purpose --
    # each needs its own random nonce.
    db.bulk_save_objects(
        [
            Patient(
                patient_code=row["patient_code"],
                first_name_enc=encrypt_field(row["first_name"]),
                last_name_enc=encrypt_field(row["last_name"]),
                date_of_birth_enc=encrypt_field(row["date_of_birth"]),
                gender_enc=encrypt_field(row["gender"]),
                uploaded_by=current_user.id,
                upload_id=upload.id,
            )
            for row in result.accepted
        ]
    )

    db.add(
        AuditLog(
            user_id=current_user.id,
            event_type="patient_upload",
            event_detail={
                "upload_id": str(upload.id),
                "filename": file.filename,
                "total_rows": result.total_rows,
                "accepted_rows": len(result.accepted),
                "rejected_rows": len(result.rejected),
            },
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    )
    db.commit()

    return PatientUploadResult(accepted=len(result.accepted), rejected=result.rejected, upload_id=upload.id)


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

    # Encrypted fields aren't filterable/sortable in SQL, so decrypt every
    # visible row first and do filter/sort/pagination in Python. Each
    # per-column filter narrows independently (AND, not OR) -- e.g.
    # patient_code=P-00&first_name=ada only matches rows satisfying both.
    patients = [_decrypt_patient(patient) for patient in query.all()]

    if patient_code:
        needle = patient_code.strip().lower()
        patients = [patient for patient in patients if needle in patient.patient_code.lower()]

    if first_name:
        needle = first_name.strip().lower()
        patients = [patient for patient in patients if needle in patient.first_name.lower()]

    if last_name:
        needle = last_name.strip().lower()
        patients = [patient for patient in patients if needle in patient.last_name.lower()]

    if gender:
        wanted = {value.strip().lower() for value in gender}
        patients = [patient for patient in patients if patient.gender.lower() in wanted]

    # date_of_birth is stored/returned as "YYYY-MM-DD" -- that format sorts
    # lexicographically identically to chronologically, so plain string
    # comparison is enough for an inclusive range filter.
    if date_of_birth_from:
        patients = [patient for patient in patients if patient.date_of_birth >= date_of_birth_from]

    if date_of_birth_to:
        patients = [patient for patient in patients if patient.date_of_birth <= date_of_birth_to]

    patients.sort(key=lambda patient: getattr(patient, sort_by).lower(), reverse=sort_dir == "desc")

    total = len(patients)
    start = (page - 1) * page_size
    page_items = patients[start : start + page_size]

    return PatientListResponse(items=page_items, total=total)


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
            continue
        setattr(patient, _UPDATE_FIELD_TO_COLUMN[field_name], encrypt_field(value))
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
