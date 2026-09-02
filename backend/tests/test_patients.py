import json
import uuid
from datetime import date
from io import BytesIO

import openpyxl
import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.encryption import decrypt_field, encrypt_field
from app.core.limiter import limiter
from app.core.security import create_access_token
from app.models import AuditLog, Patient, PatientUpload
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
    # patient.create is what POST /patients/upload requires -- uploading a new batch is a create, not an edit.
    role = make_role("manager", ["patient.view", "patient.create", "patient.edit", "patient.delete"])
    return make_user(role, location, email="manager@example.com")


@pytest.fixture
def manager_headers(manager, auth_headers):
    return auth_headers(manager)


@pytest.fixture
def other_manager(location, make_role, make_user):
    role = make_role("other-manager", ["patient.view", "patient.create", "patient.edit"])
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
    # No permission returns 403.
    def test_no_permission_gets_403(self, client, outsider_headers):
        resp = client.post("/patients/upload", headers=outsider_headers, files=_upload_file())
        assert resp.status_code == 403

    # Accepts valid file and encrypts fields.
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

    # Streams progress events for both phases.
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

        # Processed counts within each phase are non-decreasing, and each phase's last line reaches its own total.
        for phase in ("validating", "saving"):
            phase_lines = [line for line in progress_lines if line["phase"] == phase]
            assert phase_lines, f"expected at least one {phase!r} progress line"
            processed_values = [line["processed"] for line in phase_lines]
            assert processed_values == sorted(processed_values)
            assert phase_lines[-1]["processed"] == phase_lines[-1]["total"] == 10

    # Accepts optional fields and round trips each kind.
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

    # Accepts new vitals and care fields and round trips.
    def test_accepts_new_vitals_and_care_fields_and_round_trips(
        self, client, db_session, manager, manager_headers
    ):
        header = VALID_ROWS[0] + ["Care Department", "Last Visit Date", "Systolic BP", "Diastolic BP"]
        row = VALID_ROWS[1] + ["Cardiology", "2024-11-03", "128", "82"]
        resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file([header, row]))
        assert resp.status_code == 201, resp.text

        patient = db_session.query(Patient).filter(Patient.patient_code == "P-001").one()
        assert decrypt_field(patient.care_department_enc) == "Cardiology"
        assert decrypt_field(patient.last_visit_date_enc) == "2024-11-03"
        assert int(decrypt_field(patient.systolic_bp_enc)) == 128
        assert int(decrypt_field(patient.diastolic_bp_enc)) == 82

    # Rejects file over 10mb.
    def test_rejects_file_over_10mb(self, client, manager_headers):
        oversized = {"file": ("big.xlsx", b"0" * (10 * 1024 * 1024 + 1), "application/octet-stream")}
        resp = client.post("/patients/upload", headers=manager_headers, files=oversized)
        assert resp.status_code == 413

    # Rejects unsupported extension.
    def test_rejects_unsupported_extension(self, client, manager_headers):
        resp = client.post(
            "/patients/upload",
            headers=manager_headers,
            files={"file": ("patients.csv", b"whatever", "text/csv")},
        )
        assert resp.status_code == 422
        assert "Unsupported file type" in resp.json()["detail"]

    # Invalid header returns 422.
    def test_invalid_header_returns_422(self, client, manager_headers):
        rows = [["Patient ID", "First Name", "Last Name", "Date of Birth"]]  # Gender omitted
        resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file(rows))
        assert resp.status_code == 422
        assert "Gender" in resp.json()["detail"]

    # Writes audit log without phi.
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

    # A Patient ID already used by a DIFFERENT uploader is reported cleanly, not a crash.
    def test_patient_id_taken_by_another_uploader_reports_cleanly(
        self, client, db_session, manager, manager_headers, other_manager
    ):
        """existing_codes (checked before streaming starts) only looks at
        codes the current uploader already owns, while the database
        constraint is global -- so this reproduces deterministically, no
        concurrency needed: the pre-check has nothing to object to, and the
        collision only surfaces once the chunk insert actually runs."""
        _make_patient(db_session, uploaded_by=other_manager.id, patient_code="P-001")

        resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file())
        assert resp.status_code == 201, resp.text  # the streamed status can't change after this point

        lines = _parse_ndjson(resp)
        assert lines[-1] == {
            "type": "error",
            "message": (
                "One or more Patient IDs in this file are already in use by "
                "another account. No rows from this file were saved."
            ),
        }

        # Nothing from this upload was kept -- not the rejected-but-still-theirs row, nor a PatientUpload for a run that never completed.
        assert db_session.query(Patient).filter(Patient.uploaded_by == manager.id).count() == 0
        assert db_session.query(PatientUpload).filter(PatientUpload.manager_id == manager.id).count() == 0

    # Any other DB failure during the write phase is also reported cleanly, not a silent crash.
    def test_generic_db_failure_during_save_reports_cleanly(
        self, client, db_session, manager, manager_headers, monkeypatch
    ):
        """Same root cause as the uploader collision above, just a different
        trigger. Session.commit is monkeypatched to fail once since a real
        mid-request DB outage can't be reproduced from here; this hits the
        same final commit the collision case never reaches."""

        def failing_commit(self, *args, **kwargs):
            raise SQLAlchemyError("simulated commit failure")

        monkeypatch.setattr(Session, "commit", failing_commit)

        resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file())
        assert resp.status_code == 201, resp.text  # the streamed status can't change after this point

        lines = _parse_ndjson(resp)
        assert lines[-1] == {
            "type": "error",
            "message": "Upload could not be saved. No rows were written.",
        }

        monkeypatch.undo()  # restore commit() before using db_session below
        assert db_session.query(Patient).filter(Patient.uploaded_by == manager.id).count() == 0
        assert db_session.query(PatientUpload).filter(PatientUpload.manager_id == manager.id).count() == 0


class TestListPatients:
    # No permission returns 403.
    def test_no_permission_gets_403(self, client, outsider_headers):
        resp = client.get("/patients", headers=outsider_headers)
        assert resp.status_code == 403

    # Scoped to own uploads by default.
    def test_scoped_to_own_uploads_by_default(
        self, client, db_session, manager, manager_headers, other_manager
    ):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001")
        _make_patient(db_session, uploaded_by=other_manager.id, patient_code="P-002")

        resp = client.get("/patients", headers=manager_headers)
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["uploaded_by"] == str(manager.id)

    # View all permission sees everyone.
    def test_view_all_permission_sees_everyone(
        self, client, db_session, manager, other_manager, view_all_headers
    ):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001")
        _make_patient(db_session, uploaded_by=other_manager.id, patient_code="P-002")

        resp = client.get("/patients", headers=view_all_headers)
        assert resp.json()["total"] == 2

    # First name filter is case insensitive.
    def test_first_name_filter_is_case_insensitive(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", first_name="Ada", last_name="Lovelace")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", first_name="Grace", last_name="Hopper")

        resp = client.get("/patients", headers=manager_headers, params={"first_name": "GRACE"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["last_name"] == "Hopper"

    # Patient code filter.
    def test_patient_code_filter(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="Q-002")

        resp = client.get("/patients", headers=manager_headers, params={"patient_code": "p-00"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-001"

    # Last name filter.
    def test_last_name_filter(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", last_name="Lovelace")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", last_name="Hopper")

        resp = client.get("/patients", headers=manager_headers, params={"last_name": "hop"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-002"

    # Column filters combine with and not or.
    def test_column_filters_combine_with_and_not_or(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", first_name="Ada", last_name="Lovelace")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", first_name="Ada", last_name="Hopper")

        resp = client.get(
            "/patients", headers=manager_headers, params={"first_name": "Ada", "last_name": "Hopper"}
        )
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-002"

    # Gender filter.
    def test_gender_filter(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", gender="Female")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", gender="Male")

        resp = client.get("/patients", headers=manager_headers, params={"gender": "Male"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-002"

    # Gender filter accepts multiple values.
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

    # Date of birth from filter.
    def test_date_of_birth_from_filter(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", date_of_birth="1980-06-01")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", date_of_birth="2000-06-01")

        resp = client.get(
            "/patients", headers=manager_headers, params={"date_of_birth_from": "1990-01-01"}
        )
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-002"

    # Date of birth to filter.
    def test_date_of_birth_to_filter(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001", date_of_birth="1980-06-01")
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-002", date_of_birth="2000-06-01")

        resp = client.get(
            "/patients", headers=manager_headers, params={"date_of_birth_to": "1990-01-01"}
        )
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["patient_code"] == "P-001"

    # Date of birth range is inclusive.
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

    # Sort and pagination.
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


class TestAnalyticsDataset:
    """GET /patients/analytics-dataset -- the de-identified projection the
    analytics dashboard reads. The identifier-exclusion tests here are the
    important ones: this endpoint's whole contract is that PHI never reaches
    the client, so a regression that leaks a name/address must fail loudly."""

    @staticmethod
    def _done(resp) -> dict:
        return _upload_done_event(resp)

    # No permission returns 403.
    def test_no_permission_gets_403(self, client, outsider_headers):
        resp = client.get("/patients/analytics-dataset", headers=outsider_headers)
        assert resp.status_code == 403

    # Returns deidentified columns only.
    def test_returns_deidentified_columns_only(self, client, db_session, manager, manager_headers):
        _make_patient(
            db_session,
            uploaded_by=manager.id,
            patient_code="P-DEID",
            first_name="Ada",
            last_name="Lovelace",
            date_of_birth="1990-01-15",
            gender="Female",
            street_address="123 Secret St",
            phone="217-555-0100",
            email="ada@example.com",
            policy_number="POL123456",
            pcp_name="Dr. Hopper",
            occupation="Mathematician",
        )
        resp = client.get("/patients/analytics-dataset", headers=manager_headers)
        assert resp.status_code == 200

        # The whole streamed body, not just the parsed columns -- an identifier leaking anywhere must fail this.
        body = resp.text
        for identifier in (
            "P-DEID",
            "Ada",
            "Lovelace",
            "123 Secret St",
            "217-555-0100",
            "ada@example.com",
            "POL123456",
            "Dr. Hopper",
            "Mathematician",
            "1990-01-15",
        ):
            assert identifier not in body, f"{identifier!r} leaked into the analytics payload"

        done = self._done(resp)
        assert done["total"] == 1
        assert set(done["columns"]) == {
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
            "height_in",
            "weight_lbs",
            "systolic_bp",
            "diastolic_bp",
            "chronic_conditions",
            "current_medications",
            "age",
            "registration_month",
            "last_visit_month",
        }

    # Dates are truncated to month and dob becomes age.
    def test_dates_are_truncated_to_month_and_dob_becomes_age(
        self, client, db_session, manager, manager_headers
    ):
        _make_patient(
            db_session,
            uploaded_by=manager.id,
            date_of_birth="1990-06-15",
            registration_date="2020-05-04",
            last_visit_date="2024-11-03",
        )
        done = self._done(client.get("/patients/analytics-dataset", headers=manager_headers))

        assert done["columns"]["registration_month"] == ["2020-05"]
        assert done["columns"]["last_visit_month"] == ["2024-11"]
        # Exact age depends on today's date; assert the derivation instead of a value that would rot.
        today = date.today()
        expected_age = today.year - 1990 - ((today.month, today.day) < (6, 15))
        assert done["columns"]["age"] == [expected_age]

    # Categoricals are dictionary encoded.
    def test_categoricals_are_dictionary_encoded(self, client, db_session, manager, manager_headers):
        for index, gender in enumerate(["Female", "Male", "Female"]):
            _make_patient(db_session, uploaded_by=manager.id, patient_code=f"P-{index}", gender=gender)

        done = self._done(client.get("/patients/analytics-dataset", headers=manager_headers))
        values = done["categories"]["gender"]
        codes = done["columns"]["gender"]

        assert sorted(values) == ["Female", "Male"]
        assert [values[code] for code in codes] == ["Female", "Male", "Female"]

    # Multi value fields are dictionary encoded.
    def test_multi_value_fields_are_dictionary_encoded(self, client, db_session, manager, manager_headers):
        _make_patient(
            db_session,
            uploaded_by=manager.id,
            patient_code="P-1",
            chronic_conditions=["I10 - Essential hypertension", "E11.9 - Type 2 diabetes mellitus"],
        )
        _make_patient(
            db_session,
            uploaded_by=manager.id,
            patient_code="P-2",
            chronic_conditions=["I10 - Essential hypertension"],
        )

        done = self._done(client.get("/patients/analytics-dataset", headers=manager_headers))
        values = done["multi_value_categories"]["chronic_conditions"]
        rows = done["columns"]["chronic_conditions"]

        assert [[values[code] for code in row] for row in rows] == [
            ["I10 - Essential hypertension", "E11.9 - Type 2 diabetes mellitus"],
            ["I10 - Essential hypertension"],
        ]

    # Missing optional fields are null not omitted.
    def test_missing_optional_fields_are_null_not_omitted(self, client, db_session, manager, manager_headers):
        # A row with no optional fields set still occupies one slot in every column, so columns stay row-aligned.
        _make_patient(db_session, uploaded_by=manager.id)
        done = self._done(client.get("/patients/analytics-dataset", headers=manager_headers))

        assert done["total"] == 1
        assert done["columns"]["blood_type"] == [None]
        assert done["columns"]["systolic_bp"] == [None]
        assert done["columns"]["registration_month"] == [None]
        assert done["columns"]["chronic_conditions"] == [[]]

    # Scoped to own uploads by default.
    def test_scoped_to_own_uploads_by_default(
        self, client, db_session, manager, manager_headers, other_manager
    ):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-MINE")
        _make_patient(db_session, uploaded_by=other_manager.id, patient_code="P-THEIRS")

        done = self._done(client.get("/patients/analytics-dataset", headers=manager_headers))
        assert done["total"] == 1

    # View all permission sees everyone.
    def test_view_all_permission_sees_everyone(
        self, client, db_session, manager, other_manager, view_all_headers
    ):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-MINE")
        _make_patient(db_session, uploaded_by=other_manager.id, patient_code="P-THEIRS")

        done = self._done(client.get("/patients/analytics-dataset", headers=view_all_headers))
        assert done["total"] == 2

    # Quality counts duplicate identities.
    def test_quality_counts_duplicate_identities(self, client, db_session, manager, manager_headers):
        # Same person uploaded twice under different Patient IDs, plus a casing variant -- all one identity group.
        for index, (first, last) in enumerate([("Ada", "Lovelace"), ("Ada", "Lovelace"), ("ADA", "lovelace")]):
            _make_patient(
                db_session,
                uploaded_by=manager.id,
                patient_code=f"P-DUP-{index}",
                first_name=first,
                last_name=last,
                date_of_birth="1990-01-15",
            )
        _make_patient(
            db_session, uploaded_by=manager.id, patient_code="P-UNIQ", first_name="Grace", last_name="Hopper"
        )

        done = self._done(client.get("/patients/analytics-dataset", headers=manager_headers))
        assert done["quality"]["duplicate_identity_groups"] == 1
        assert done["quality"]["duplicate_identity_rows"] == 3

    # Quality counts dates before birth.
    def test_quality_counts_dates_before_birth(self, client, db_session, manager, manager_headers):
        # Predates the cross-field upload validation, so it can only arrive via a legacy row -- what this check is for.
        _make_patient(
            db_session,
            uploaded_by=manager.id,
            patient_code="P-BAD",
            date_of_birth="2020-01-15",
            registration_date="2019-01-01",
        )
        _make_patient(
            db_session,
            uploaded_by=manager.id,
            patient_code="P-OK",
            date_of_birth="1990-01-15",
            registration_date="2019-01-01",
        )

        done = self._done(client.get("/patients/analytics-dataset", headers=manager_headers))
        assert done["quality"]["dates_before_birth"] == 1

    # Quality counts last visit before registration.
    def test_quality_counts_last_visit_before_registration(
        self, client, db_session, manager, manager_headers
    ):
        _make_patient(
            db_session,
            uploaded_by=manager.id,
            patient_code="P-BAD",
            date_of_birth="1990-01-15",
            registration_date="2022-06-01",
            last_visit_date="2022-01-01",
        )
        done = self._done(client.get("/patients/analytics-dataset", headers=manager_headers))
        assert done["quality"]["last_visit_before_registration"] == 1

    # Unreadable row is counted not fatal.
    def test_unreadable_row_is_counted_not_fatal(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-GOOD")
        corrupt = _make_patient(db_session, uploaded_by=manager.id, patient_code="P-CORRUPT")
        corrupt.blood_type_enc = "v1:not-a-real:token"
        db_session.commit()

        done = self._done(client.get("/patients/analytics-dataset", headers=manager_headers))
        # The good row still comes back; the corrupt one is reported, not fatal.
        assert done["total"] == 1
        assert done["quality"]["unreadable_rows"] == 1

    # Streams progress before done.
    def test_streams_progress_before_done(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id)
        lines = _parse_ndjson(client.get("/patients/analytics-dataset", headers=manager_headers))

        progress_lines = [line for line in lines if line["type"] == "progress"]
        assert progress_lines, "expected at least one progress line before the done event"
        assert progress_lines[-1]["processed"] == progress_lines[-1]["total"] == 1
        assert lines[-1]["type"] == "done"

    # Writes audit log without phi.
    def test_writes_audit_log_without_phi(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, first_name="Ada", last_name="Lovelace")
        client.get("/patients/analytics-dataset", headers=manager_headers)

        log = (
            db_session.query(AuditLog)
            .filter(AuditLog.event_type == "patient_analytics_view")
            .order_by(AuditLog.created_at.desc())
            .first()
        )
        assert log is not None
        assert log.user_id == manager.id
        assert log.event_detail == {"row_count": 1, "unreadable_rows": 0}
        assert "Ada" not in json.dumps(log.event_detail)


class TestGetPatient:
    # No permission returns 403.
    def test_no_permission_gets_403(self, client, outsider_headers, db_session, manager):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.get(f"/patients/{patient.id}", headers=outsider_headers)
        assert resp.status_code == 403

    # Out of scope returns 404.
    def test_out_of_scope_returns_404(self, client, db_session, manager_headers, other_manager):
        patient = _make_patient(db_session, uploaded_by=other_manager.id)
        resp = client.get(f"/patients/{patient.id}", headers=manager_headers)
        assert resp.status_code == 404

    # Returns decrypted patient and writes audit log.
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
    # No permission returns 403.
    def test_no_permission_gets_403(self, client, outsider_headers, db_session, manager):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=outsider_headers, json={"last_name": "Byron"})
        assert resp.status_code == 403

    # Out of scope returns 404.
    def test_out_of_scope_returns_404(self, client, db_session, manager_headers, other_manager):
        patient = _make_patient(db_session, uploaded_by=other_manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"last_name": "Byron"})
        assert resp.status_code == 404

    # Updates only provided fields and sets updated by.
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

    # Patient code is immutable.
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

    # Invalid gender returns 422.
    def test_invalid_gender_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"gender": "Unknown"})
        assert resp.status_code == 422

    # Audit log records changed field names only.
    def test_audit_log_records_changed_field_names_only(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)

        client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"first_name": "Augusta"})

        log = db_session.query(AuditLog).filter(AuditLog.event_type == "patient_edit").one()
        assert log.event_detail["changed_fields"] == ["first_name"]
        assert "Augusta" not in json.dumps(log.event_detail)

    # Resubmitting the current value, or clearing an already-null field, is a no-op: no rewrite, no audit row.
    def test_no_op_save_does_not_rewrite_or_audit(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        original_ciphertext = patient.first_name_enc

        resp = client.patch(
            f"/patients/{patient.id}",
            headers=manager_headers,
            json={"first_name": "Ada", "city": None},
        )
        assert resp.status_code == 200

        db_session.refresh(patient)
        assert patient.first_name_enc == original_ciphertext
        assert patient.updated_by is None
        assert db_session.query(AuditLog).filter(AuditLog.event_type == "patient_edit").count() == 0


class TestUpdatePatientOptionalFields:
    # Updates text field.
    def test_updates_text_field(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"city": "Springfield"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["city"] == "Springfield"

        db_session.refresh(patient)
        assert decrypt_field(patient.city_enc) == "Springfield"

    # Updates int field round trip.
    def test_updates_int_field_round_trip(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"height_in": 70})
        assert resp.status_code == 200, resp.text
        assert resp.json()["height_in"] == 70

        db_session.refresh(patient)
        assert decrypt_field(patient.height_in_enc) == "70"

    # Updates multi value field round trip.
    def test_updates_multi_value_field_round_trip(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)

        resp = client.patch(
            f"/patients/{patient.id}", headers=manager_headers, json={"allergies": ["Penicillin", "Peanuts"]}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["allergies"] == ["Penicillin", "Peanuts"]

        db_session.refresh(patient)
        assert json.loads(decrypt_field(patient.allergies_enc)) == ["Penicillin", "Peanuts"]

    # Invalid enum value returns 422.
    def test_invalid_enum_value_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"blood_type": "Z+"})
        assert resp.status_code == 422

    # Invalid email returns 422.
    def test_invalid_email_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"email": "not-an-email"})
        assert resp.status_code == 422

    # Explicit null clears an optional field.
    def test_explicit_null_clears_an_optional_field(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id, email="ada@example.com")

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"email": None})
        assert resp.status_code == 200, resp.text
        assert resp.json()["email"] is None

        db_session.refresh(patient)
        assert patient.email_enc is None

    # Empty list clears a multi value field.
    def test_empty_list_clears_a_multi_value_field(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id, allergies=["Penicillin"])

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"allergies": []})
        assert resp.status_code == 200, resp.text
        assert resp.json()["allergies"] is None

        db_session.refresh(patient)
        assert patient.allergies_enc is None

    # Explicit null for a required field is a no op.
    def test_explicit_null_for_a_required_field_is_a_no_op(self, client, db_session, manager, manager_headers):
        # These are NOT NULL columns -- an explicit null must be ignored, not error and not clear the field.
        patient = _make_patient(db_session, uploaded_by=manager.id, first_name="Ada")

        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"first_name": None})
        assert resp.status_code == 200, resp.text
        assert resp.json()["first_name"] == "Ada"

        db_session.refresh(patient)
        assert decrypt_field(patient.first_name_enc) == "Ada"


class TestDeletePatient:
    # No permission returns 403.
    def test_no_permission_gets_403(self, client, outsider_headers, db_session, manager):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.delete(f"/patients/{patient.id}", headers=outsider_headers)
        assert resp.status_code == 403

    # Out of scope returns 404.
    def test_out_of_scope_returns_404(self, client, db_session, manager_headers, other_manager):
        patient = _make_patient(db_session, uploaded_by=other_manager.id)
        resp = client.delete(f"/patients/{patient.id}", headers=manager_headers)
        assert resp.status_code == 404

    # Hard deletes and writes audit log.
    def test_hard_deletes_and_writes_audit_log(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        patient_id = patient.id

        resp = client.delete(f"/patients/{patient_id}", headers=manager_headers)
        assert resp.status_code == 204

        assert db_session.query(Patient).filter(Patient.id == patient_id).one_or_none() is None
        log = db_session.query(AuditLog).filter(AuditLog.event_type == "patient_delete").one()
        assert log.event_detail == {"patient_id": str(patient_id)}


class TestUnauthenticated:
    """Requests carrying no Authorization header at all -- distinct from
    outsider_headers (an authenticated user lacking the specific permission),
    this asserts get_current_user's 401 gate runs before require_permission's
    403 gate on every patient endpoint."""

    # No auth header at all returns 401 not 403 for upload.
    def test_upload_returns_401(self, client):
        resp = client.post("/patients/upload", files=_upload_file())
        assert resp.status_code == 401

    # No auth header at all returns 401 not 403 for list.
    def test_list_returns_401(self, client):
        resp = client.get("/patients")
        assert resp.status_code == 401

    # No auth header at all returns 401 not 403 for analytics dataset.
    def test_analytics_dataset_returns_401(self, client):
        resp = client.get("/patients/analytics-dataset")
        assert resp.status_code == 401

    # No auth header at all returns 401 not 403 for get.
    def test_get_returns_401(self, client):
        resp = client.get(f"/patients/{uuid.uuid4()}")
        assert resp.status_code == 401

    # No auth header at all returns 401 not 403 for update.
    def test_update_returns_401(self, client):
        resp = client.patch(f"/patients/{uuid.uuid4()}", json={"first_name": "New"})
        assert resp.status_code == 401

    # No auth header at all returns 401 not 403 for delete.
    def test_delete_returns_401(self, client):
        resp = client.delete(f"/patients/{uuid.uuid4()}")
        assert resp.status_code == 401


class TestPatientAdversarial:
    """Bad-actor-shaped requests: tampered tokens, malformed bodies, SQLi-
    shaped filter strings, oversized/unicode field values."""

    # Tampered bearer token returns 401 not a 500.
    def test_tampered_token_returns_401(self, client, manager):
        token = create_access_token(manager.id)
        tampered = token[:-4] + ("A" if token[-4] != "A" else "B") + token[-3:]
        resp = client.get("/patients", headers={"Authorization": f"Bearer {tampered}"})
        assert resp.status_code == 401

    # Malformed bearer token returns 401 not a 500.
    def test_garbage_token_returns_401(self, client):
        resp = client.get("/patients", headers={"Authorization": "Bearer not-a-real-jwt"})
        assert resp.status_code == 401

    # Non multipart body to upload returns 4xx not a 500.
    def test_non_multipart_body_to_upload_returns_4xx(self, client, manager_headers):
        headers = {**manager_headers, "Content-Type": "application/json"}
        resp = client.post("/patients/upload", headers=headers, content=json.dumps({"file": "not-a-file"}))
        assert 400 <= resp.status_code < 500

    # Sql injection shaped patient code filter is treated as a literal string.
    def test_sql_injection_shaped_patient_code_filter_is_treated_as_literal(
        self, client, db_session, manager, manager_headers
    ):
        _make_patient(db_session, uploaded_by=manager.id, patient_code="P-001")
        resp = client.get(
            "/patients",
            headers=manager_headers,
            params={"patient_code": "'; DROP TABLE patients; --"},
        )
        assert resp.status_code == 200
        assert resp.json()["total"] == 0
        # The table must still exist and still hold the seeded row.
        assert db_session.query(Patient).filter(Patient.patient_code == "P-001").one_or_none() is not None

    # Sql injection shaped name filter is treated as a literal string.
    def test_sql_injection_shaped_name_filter_is_treated_as_literal(self, client, db_session, manager, manager_headers):
        _make_patient(db_session, uploaded_by=manager.id, first_name="Ada")
        resp = client.get(
            "/patients", headers=manager_headers, params={"first_name": "' OR '1'='1"}
        )
        assert resp.status_code == 200
        assert resp.json()["total"] == 0

    # Unicode and emoji names round trip through upload and retrieval unchanged.
    def test_unicode_and_emoji_names_round_trip(self, client, db_session, manager, manager_headers):
        header = VALID_ROWS[0]
        row = ["P-777", "Zoë 🎉 名前", "Müller-Østergård", "1990-01-15", "Female"]
        resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file([header, row]))
        done = _upload_done_event(resp)
        assert done["accepted"] == 1

        patient = db_session.query(Patient).filter(Patient.patient_code == "P-777").one()
        get_resp = client.get(f"/patients/{patient.id}", headers=manager_headers)
        assert get_resp.status_code == 200
        body = get_resp.json()
        assert body["first_name"] == "Zoë 🎉 名前"
        assert body["last_name"] == "Müller-Østergård"

    # Very long field value on update does not crash the request.
    def test_very_long_field_value_on_update_does_not_crash(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        long_value = "A" * 100_000
        resp = client.patch(
            f"/patients/{patient.id}", headers=manager_headers, json={"first_name": long_value}
        )
        assert resp.status_code == 200
        assert resp.json()["first_name"] == long_value

    # Malformed json body to update returns 422 not a 500.
    def test_malformed_json_body_to_update_returns_422(self, client, manager_headers, db_session, manager):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(
            f"/patients/{patient.id}",
            headers={**manager_headers, "Content-Type": "application/json"},
            content="{not valid json",
        )
        assert resp.status_code == 422

    # Wrong type for an int field on update returns 422.
    def test_wrong_type_for_int_field_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(
            f"/patients/{patient.id}", headers=manager_headers, json={"height_in": "not-a-number"}
        )
        assert resp.status_code == 422

    # Nonexistent patient id on update returns 404 not 422.
    def test_nonexistent_patient_id_on_update_returns_404(self, client, manager_headers):
        resp = client.patch(f"/patients/{uuid.uuid4()}", headers=manager_headers, json={"first_name": "New"})
        assert resp.status_code == 404

    # Malformed uuid path parameter returns 422 not a 500.
    def test_malformed_uuid_path_parameter_returns_422(self, client, manager_headers):
        resp = client.get("/patients/not-a-uuid", headers=manager_headers)
        assert resp.status_code == 422

    # Empty string for a required name field on manual update returns 422, matching upload.
    def test_empty_string_first_name_on_update_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"first_name": ""})
        assert resp.status_code == 422

    # Whitespace only name on manual update returns 422.
    def test_whitespace_only_first_name_on_update_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"first_name": "   "})
        assert resp.status_code == 422

    # Formula injection payload in first name on manual update returns 422, matching upload.
    def test_formula_injection_first_name_on_update_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(
            f"/patients/{patient.id}", headers=manager_headers, json={"first_name": "=SUM(A1:A10)"}
        )
        assert resp.status_code == 422

    # Last name follows the same rules as first name.
    def test_blank_last_name_on_update_returns_422(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"last_name": ""})
        assert resp.status_code == 422

    # A valid name change on manual update still succeeds normally.
    def test_valid_first_name_on_update_succeeds(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id)
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"first_name": "Grace"})
        assert resp.status_code == 200
        assert resp.json()["first_name"] == "Grace"

    # An explicit null for first name is still a no-op, same as omitting the field.
    def test_explicit_null_first_name_on_update_is_a_no_op(self, client, db_session, manager, manager_headers):
        patient = _make_patient(db_session, uploaded_by=manager.id, first_name="Ada")
        resp = client.patch(f"/patients/{patient.id}", headers=manager_headers, json={"first_name": None})
        assert resp.status_code == 200
        assert resp.json()["first_name"] == "Ada"

    # Upload rate limit returns 429 on the sixth request within a minute.
    def test_upload_rate_limited_after_five_requests_per_minute(self, client, manager_headers):
        for _ in range(5):
            resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file())
            assert resp.status_code == 201
        resp = client.post("/patients/upload", headers=manager_headers, files=_upload_file())
        assert resp.status_code == 429

    # Analytics dataset rate limit returns 429 on the eleventh request within a minute.
    def test_analytics_dataset_rate_limited_after_ten_requests_per_minute(self, client, manager_headers):
        for _ in range(10):
            resp = client.get("/patients/analytics-dataset", headers=manager_headers)
            assert resp.status_code == 200
        resp = client.get("/patients/analytics-dataset", headers=manager_headers)
        assert resp.status_code == 429
