import json
from io import BytesIO

import openpyxl
import pytest

from app.core.encryption import decrypt_field, encrypt_field
from app.core.limiter import limiter
from app.models import AuditLog, Patient
from app.routers.patients import _maybe_encrypt
from app.services.patient_import import OPTIONAL_FIELD_NAMES

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


def _parse_ndjson(resp) -> list[dict]:
    """/patients/upload streams newline-delimited JSON (progress lines, then
    one final "done" line) rather than a single JSON body. TestClient fully
    drains the stream before returning, so resp.text already has the whole
    thing -- just split and parse each line."""
    return [json.loads(line) for line in resp.text.strip().split("\n") if line]


def _upload_done_event(resp) -> dict:
    lines = _parse_ndjson(resp)
    assert lines[-1]["type"] == "done"
    return lines[-1]


def _make_patient(
    db_session,
    *,
    uploaded_by,
    patient_code="P-001",
    first_name="Ada",
    last_name="Lovelace",
    date_of_birth="1990-01-15",
    gender="Female",
    **optional_fields,
) -> Patient:
    """optional_fields are plain values (not pre-encrypted/serialized) keyed by
    the same snake_case names as OPTIONAL_FIELD_NAMES, e.g. height_in=68 or
    allergies=["Penicillin"] -- serialized/encrypted the same way the real
    upload/update paths do, via app.routers.patients._maybe_encrypt. Any field
    not passed defaults to None, same as an upload row that left it blank."""
    patient = Patient(
        patient_code=patient_code,
        first_name_enc=encrypt_field(first_name),
        last_name_enc=encrypt_field(last_name),
        date_of_birth_enc=encrypt_field(date_of_birth),
        gender_enc=encrypt_field(gender),
        uploaded_by=uploaded_by,
        **{
            f"{field_name}_enc": _maybe_encrypt(field_name, optional_fields.get(field_name))
            for field_name in OPTIONAL_FIELD_NAMES
        },
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
        done = _upload_done_event(resp)
        assert done["accepted"] == 1
        assert done["rejected"] == []

        patient = db_session.query(Patient).filter(Patient.patient_code == "P-001").one()
        assert patient.uploaded_by == manager.id
        assert patient.first_name_enc != "Ada"
        assert decrypt_field(patient.first_name_enc) == "Ada"

    def test_streams_progress_events_for_both_phases(self, client, manager_headers):
        rows = [VALID_ROWS[0]] + [
            [f"P-{i:03d}", "Ada", "Lovelace", "1990-01-15", "Female"] for i in range(10)
        ]
        resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file(rows))
        assert resp.status_code == 201, resp.text

        lines = _parse_ndjson(resp)
        done = lines[-1]
        assert done["type"] == "done"
        assert done["accepted"] == 10
        assert done["rejected"] == []

        progress_lines = [line for line in lines if line["type"] == "progress"]
        assert progress_lines, "expected at least one progress line before the done event"
        assert {line["phase"] for line in progress_lines} <= {"validating", "saving"}

        # processed counts within each phase are non-decreasing, and each
        # phase's last line reaches that phase's own total.
        for phase in ("validating", "saving"):
            phase_lines = [line for line in progress_lines if line["phase"] == phase]
            assert phase_lines, f"expected at least one {phase!r} progress line"
            processed_values = [line["processed"] for line in phase_lines]
            assert processed_values == sorted(processed_values)
            assert phase_lines[-1]["processed"] == phase_lines[-1]["total"] == 10

    def test_accepts_optional_fields_and_round_trips_each_kind(self, client, db_session, manager, manager_headers):
        header = VALID_ROWS[0] + ["State", "Email", "Height (in)", "Allergies"]
        row = VALID_ROWS[1] + ["IL", "ada@example.com", "68", "Penicillin, Peanuts"]
        resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file([header, row]))
        assert resp.status_code == 201, resp.text

        patient = db_session.query(Patient).filter(Patient.patient_code == "P-001").one()
        assert patient.state_enc != "IL"
        assert decrypt_field(patient.state_enc) == "IL"
        assert decrypt_field(patient.email_enc) == "ada@example.com"
        assert int(decrypt_field(patient.height_in_enc)) == 68
        assert json.loads(decrypt_field(patient.allergies_enc)) == ["Penicillin", "Peanuts"]

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
        header = VALID_ROWS[0] + ["Email", "Street Address"]
        row = VALID_ROWS[1] + ["ada@example.com", "123 Main St"]
        client.post("/patients/upload", headers=manager_headers, files=_upload_file([header, row]))

        log = db_session.query(AuditLog).filter(AuditLog.event_type == "patient_upload").one()
        assert log.user_id == manager.id
        detail_json = json.dumps(log.event_detail)
        assert "Ada" not in detail_json
        assert "ada@example.com" not in detail_json
        assert "123 Main St" not in detail_json
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


class TestUpdatePatientOptionalFields:
    def test_updates_text_field(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"city": "Springfield"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["city"] == "Springfield"

        db_session.refresh(patient)
        assert decrypt_field(patient.city_enc) == "Springfield"

    def test_updates_int_field_round_trip(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"height_in": 70})
        assert resp.status_code == 200, resp.text
        assert resp.json()["height_in"] == 70

        db_session.refresh(patient)
        assert decrypt_field(patient.height_in_enc) == "70"

    def test_updates_multi_value_field_round_trip(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)

        resp = client.patch(
            f"/patients/{patient.id}", headers=manager_headers, json={"allergies": ["Penicillin", "Peanuts"]}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["allergies"] == ["Penicillin", "Peanuts"]

        db_session.refresh(patient)
        assert json.loads(decrypt_field(patient.allergies_enc)) == ["Penicillin", "Peanuts"]

    def test_invalid_enum_value_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"blood_type": "Z+"})
        assert resp.status_code == 422

    def test_invalid_email_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"email": "not-an-email"})
        assert resp.status_code == 422

    def test_explicit_null_clears_an_optional_field(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id, email="ada@example.com")

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"email": None})
        assert resp.status_code == 200, resp.text
        assert resp.json()["email"] is None

        db_session.refresh(patient)
        assert patient.email_enc is None

    def test_empty_list_clears_a_multi_value_field(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id, allergies=["Penicillin"])

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"allergies": []})
        assert resp.status_code == 200, resp.text
        assert resp.json()["allergies"] is None

        db_session.refresh(patient)
        assert patient.allergies_enc is None

    def test_explicit_null_for_a_required_field_is_a_no_op(self, client, db_session, manager, manager_headers):
        # first_name/last_name/date_of_birth/gender are NOT NULL columns --
        # an explicit null for one of those must be ignored, not error and
        # not clear it (mirrors patient_code's existing immutability test).
        patient = _make_patient(db_session, uploaded_by=manager.id, first_name="Ada")

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"first_name": None})
        assert resp.status_code == 200, resp.text
        assert resp.json()["first_name"] == "Ada"

        db_session.refresh(patient)
        assert decrypt_field(patient.first_name_enc) == "Ada"


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
