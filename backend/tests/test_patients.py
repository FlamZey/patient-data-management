import json
from io import BytesIO

import openpyxl
import pytest

from app.core.encryption import decrypt_field, encrypt_field
from app.core.limiter import limiter
from app.models import AuditLog, Patient

VALID_ROWS = [
    ["Patient ID", "First Name", "Last Name", "Date of Birth", "Gender"],
    ["P-001", "Ada", "Lovelace", "1990-01-15", "Female"],
]


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """/patients/upload is rate-limited via the shared app.core.limiter, whose
    in-memory counter persists for the whole pytest process -- reset it before
    every test so an earlier test's upload calls never push a later test over
    the limit."""
    limiter.reset()
    yield


def _workbook_bytes(rows: list[list]) -> bytes:
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    for row in rows:
        sheet.append(row)
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def _upload_file(rows: list[list] = VALID_ROWS, filename: str = "patients.xlsx"):
    return {
        "file": (
            filename,
            _workbook_bytes(rows),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
    }


def _make_patient(
    db_session,
    *,
    uploaded_by,
    patient_code="P-001",
    first_name="Ada",
    last_name="Lovelace",
    date_of_birth="1990-01-15",
    gender="Female",
) -> Patient:
    patient = Patient(
        patient_code=patient_code,
        first_name_enc=encrypt_field(first_name),
        last_name_enc=encrypt_field(last_name),
        date_of_birth_enc=encrypt_field(date_of_birth),
        gender_enc=encrypt_field(gender),
        uploaded_by=uploaded_by,
    )
    db_session.add(patient)
    db_session.commit()
    db_session.refresh(patient)
    return patient


@pytest.fixture
def outsider(location, make_role, make_user):
    """An active user with no granted permissions -- for asserting that a
    specific permission gate is enforced, not just 'must be authenticated'."""
    return make_user(make_role("no-access"), location, email="outsider@example.com")


@pytest.fixture
def outsider_headers(outsider, auth_headers):
    return auth_headers(outsider)


@pytest.fixture
def manager(location, make_role, make_user):
    role = make_role("manager", ["patient.view", "patient.edit", "patient.delete"])
    return make_user(role, location, email="manager@example.com")


@pytest.fixture
def manager_headers(manager, auth_headers):
    return auth_headers(manager)


@pytest.fixture
def other_manager(location, make_role, make_user):
    role = make_role("other-manager", ["patient.view", "patient.edit"])
    return make_user(role, location, email="other-manager@example.com")


@pytest.fixture
def other_manager_headers(other_manager, auth_headers):
    return auth_headers(other_manager)


@pytest.fixture
def view_all_headers(location, make_role, make_user, auth_headers):
    role = make_role("patient-admin", ["patient.view", "patient.view_all"])
    admin = make_user(role, location, email="patient-admin@example.com")
    return auth_headers(admin)


class TestUploadPatients:
    def test_no_permission_gets_403(self, client, outsider_headers):
        resp = client.post("/patients/upload", headers=outsider_headers, files=_upload_file())
        assert resp.status_code == 403

    def test_accepts_valid_file_and_encrypts_fields(self, client, db_session, manager, manager_headers):
        resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file())
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["accepted"] == 1
        assert body["rejected"] == []

        patient = db_session.query(Patient).filter(Patient.patient_code == "P-001").one()
        assert patient.uploaded_by == manager.id
        assert patient.first_name_enc != "Ada"
        assert decrypt_field(patient.first_name_enc) == "Ada"

    def test_rejects_file_over_10mb(self, client, manager_headers):
        oversized = {"file": ("big.xlsx", b"0" * (10 * 1024 * 1024 + 1), "application/octet-stream")}
        resp = client.post("/patients/upload", headers=manager_headers, files=oversized)
        assert resp.status_code == 413

    def test_rejects_unsupported_extension(self, client, manager_headers):
        resp = client.post(
            "/patients/upload",
            headers=manager_headers,
            files={"file": ("patients.csv", b"whatever", "text/csv")},
        )
        assert resp.status_code == 422
        assert "Unsupported file type" in resp.json()["detail"]

    def test_invalid_header_returns_422(self, client, manager_headers):
        rows = [["Patient ID", "First Name", "Last Name", "Date of Birth"]]  # Gender omitted
        resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file(rows))
        assert resp.status_code == 422
        assert "Gender" in resp.json()["detail"]

    def test_writes_audit_log_without_phi(self, client, db_session, manager, manager_headers):
        client.post("/patients/upload", headers=manager_headers, files=_upload_file())

        log = db_session.query(AuditLog).filter(AuditLog.event_type == "patient_upload").one()
        assert log.user_id == manager.id
        assert "Ada" not in json.dumps(log.event_detail)
        assert set(log.event_detail.keys()) == {
            "upload_id",
            "filename",
            "total_rows",
            "accepted_rows",
            "rejected_rows",
        }


class TestListPatients:
    def test_no_permission_gets_403(self, client, outsider_headers):
        resp = client.get("/patients", headers=outsider_headers)
        assert resp.status_code == 403

    def test_scoped_to_own_uploads_by_default(
        self, client, db_session, manager, manager_headers, other_manager
    ):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001")
        _make_patient(db_session, uploaded_by=other_manager.id, patient_code="P-002")

        resp = client.get("/patients", headers=manager_headers)
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["uploaded_by"] == str(manager.id)

    def test_view_all_permission_sees_everyone(
        self, client, db_session, manager, other_manager, view_all_headers
    ):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001")
        _make_patient(db_session, uploaded_by=other_manager.id, patient_code="P-002")

        resp = client.get("/patients", headers=view_all_headers)
        assert resp.json()["total"] == 2

    def test_first_name_filter_is_case_insensitive(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", first_name="Ada", last_name="Lovelace")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", first_name="Grace", last_name="Hopper")

        resp = client.get("/patients", headers=manager_headers, params={"first_name": "GRACE"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["last_name"] == "Hopper"

    def test_patient_code_filter(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="Q-002")

        resp = client.get("/patients", headers=manager_headers, params={"patient_code": "p-00"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-001"

    def test_last_name_filter(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", last_name="Lovelace")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", last_name="Hopper")

        resp = client.get("/patients", headers=manager_headers, params={"last_name": "hop"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-002"

    def test_column_filters_combine_with_and_not_or(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", first_name="Ada", last_name="Lovelace")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", first_name="Ada", last_name="Hopper")

        resp = client.get(
            "/patients", headers=manager_headers, params={"first_name": "Ada", "last_name": "Hopper"}
        )
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-002"

    def test_gender_filter(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", gender="Female")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", gender="Male")

        resp = client.get("/patients", headers=manager_headers, params={"gender": "Male"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-002"

    def test_gender_filter_accepts_multiple_values(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", gender="Female")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", gender="Male")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-003", gender="Other")

        resp = client.get(
            "/patients",
            headers=manager_headers,
            params={"gender": ["Female", "Other"]},
        )
        body = resp.json()
        assert body["total"] == 2
        assert {item["patient_code"] for item in body["items"]} == {"P-001", "P-003"}

    def test_date_of_birth_from_filter(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", date_of_birth="1980-06-01")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", date_of_birth="2000-06-01")

        resp = client.get(
            "/patients", headers=manager_headers, params={"date_of_birth_from": "1990-01-01"}
        )
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-002"

    def test_date_of_birth_to_filter(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", date_of_birth="1980-06-01")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", date_of_birth="2000-06-01")

        resp = client.get(
            "/patients", headers=manager_headers, params={"date_of_birth_to": "1990-01-01"}
        )
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-001"

    def test_date_of_birth_range_is_inclusive(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", date_of_birth="1990-01-15")

        resp = client.get(
            "/patients",
            headers=manager_headers,
            params={"date_of_birth_from": "1990-01-15", "date_of_birth_to": "1990-01-15"},
        )
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-001"

    def test_sort_and_pagination(self, client, db_session, manager, manager_headers):
        for code in ("P-003", "P-001", "P-002"):
            _make_patient(db_session, uploaded_by=manager.id, patient_code=code)

        resp = client.get(
            "/patients", headers=manager_headers, params={"sort_by": "patient_code", "sort_dir": "asc"}
        )
        assert [item["patient_code"] for item in resp.json()["items"]] == ["P-001", "P-002", "P-003"]

        page_resp = client.get("/patients", headers=manager_headers, params={"page": 2, "page_size": 2})
        page_body = page_resp.json()
        assert page_body["total"] == 3
        assert len(page_body["items"]) == 1


class TestGetPatient:
    def test_no_permission_gets_403(self, client, outsider_headers, db_session, manager):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.get(f"/patients/{patient.id}", headers=outsider_headers)
        assert resp.status_code == 403

    def test_out_of_scope_returns_404(self, client, db_session, manager_headers, other_manager):
        patient = _make_patient(db_session, uploaded_by=other_manager.id)
        resp = client.get(f"/patients/{patient.id}", headers=manager_headers)
        assert resp.status_code == 404

    def test_returns_decrypted_patient_and_writes_audit_log(
        self, client, db_session, manager, manager_headers
    ):
        patient = _make_patient(db_session, uploaded_by=manager.id)

        resp = client.get(f"/patients/{patient.id}", headers=manager_headers)
        assert resp.status_code == 200
        body = resp.json()
        assert body["first_name"] == "Ada"
        assert body["last_name"] == "Lovelace"
        assert body["date_of_birth"] == "1990-01-15"
        assert body["gender"] == "Female"

        log = db_session.query(AuditLog).filter(AuditLog.event_type == "patient_view").one()
        assert log.user_id == manager.id
        assert log.event_detail == {"patient_id": str(patient.id)}


class TestUpdatePatient:
    def test_no_permission_gets_403(self, client, outsider_headers, db_session, manager):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=outsider_headers, json={"last_name": "Byron"})
        assert resp.status_code == 403

    def test_out_of_scope_returns_404(self, client, db_session, manager_headers, other_manager):
        patient = _make_patient(db_session, uploaded_by=other_manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"last_name": "Byron"})
        assert resp.status_code == 404

    def test_updates_only_provided_fields_and_sets_updated_by(
        self, client, db_session, manager, manager_headers
    ):
        patient = _make_patient(db_session, uploaded_by=manager.id)

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"last_name": "Byron"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["last_name"] == "Byron"
        assert body["first_name"] == "Ada"

        db_session.refresh(patient)
        assert patient.updated_by == manager.id
        assert decrypt_field(patient.last_name_enc) == "Byron"

    def test_patient_code_is_immutable(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001")

        resp = client.patch(
            f"/patients/{patient.id}",
            headers=manager_headers,
            json={"patient_code": "HACKED", "first_name": "Augusta"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["patient_code"] == "P-001"
        assert body["first_name"] == "Augusta"

    def test_invalid_gender_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"gender": "Unknown"})
        assert resp.status_code == 422

    def test_audit_log_records_changed_field_names_only(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)

        client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"first_name": "Augusta"})

        log = db_session.query(AuditLog).filter(AuditLog.event_type == "patient_edit").one()
        assert log.event_detail["changed_fields"] == ["first_name"]
        assert "Augusta" not in json.dumps(log.event_detail)


class TestDeletePatient:
    def test_no_permission_gets_403(self, client, outsider_headers, db_session, manager):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.delete(f"/patients/{patient.id}", headers=outsider_headers)
        assert resp.status_code == 403

    def test_out_of_scope_returns_404(self, client, db_session, manager_headers, other_manager):
        patient = _make_patient(db_session, uploaded_by=other_manager.id)
        resp = client.delete(f"/patients/{patient.id}", headers=manager_headers)
        assert resp.status_code == 404

    def test_hard_deletes_and_writes_audit_log(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        patient_id = patient.id

        resp = client.delete(f"/patients/{patient_id}", headers=manager_headers)
        assert resp.status_code == 204

        assert db_session.query(Patient).filter(Patient.id == patient_id).one_or_none() is None
        log = db_session.query(AuditLog).filter(AuditLog.event_type == "patient_delete").one()
        assert log.event_detail == {"patient_id": str(patient_id)}
