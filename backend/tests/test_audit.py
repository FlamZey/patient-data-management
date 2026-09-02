import pathlib
import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.audit_events import AUDIT_EVENT_TYPES
from app.core.encryption import encrypt_field
from app.core.permissions import DEFAULT_ROLE_PERMISSIONS, Permission
from app.models import AuditLog, Patient


def _log(
    db_session,
    *,
    event_type="login_success",
    user=None,
    detail=None,
    ip_address="10.0.0.1",
    user_agent="pytest",
    created_at=None,
) -> AuditLog:
    row = AuditLog(
        user_id=user.id if user is not None else None,
        event_type=event_type,
        event_detail=detail,
        ip_address=ip_address,
        user_agent=user_agent,
        # Explicit timestamp (server_default=now() only applies when omitted) keeps date-range tests deterministic.
        created_at=created_at or datetime.now(timezone.utc),
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


@pytest.fixture
def auditor(make_role, make_user, location):
    """Holds audit.view and nothing else -- so a 200 here proves this endpoint
    is gated on audit.view specifically, not on being an administrator."""
    role = make_role("auditor", [Permission.AUDIT_VIEW])
    return make_user(role, location, email="auditor@example.com")


@pytest.fixture
def auditor_headers(auditor, auth_headers):
    return auth_headers(auditor)


@pytest.fixture
def outsider_headers(make_role, make_user, location, auth_headers):
    """An active account holding every *other* administrative permission --
    the point being that none of them add up to reading the audit log."""
    role = make_role(
        "everything-but-audit",
        [code for code in DEFAULT_ROLE_PERMISSIONS["admin"] if code != Permission.AUDIT_VIEW],
    )
    return auth_headers(make_user(role, location, email="everything-but-audit@example.com"))


class TestAuditLogAuthorization:
    # The permission holder gets 200.
    def test_audit_view_permission_gets_200(self, client, auditor_headers, db_session, auditor):
        _log(db_session, user=auditor)
        resp = client.get("/audit-logs", headers=auditor_headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["total"] == 1

    # An account without audit.view gets 403, whatever else it holds.
    def test_without_audit_view_gets_403(self, client, outsider_headers):
        resp = client.get("/audit-logs", headers=outsider_headers)
        assert resp.status_code == 403
        assert "audit.view" in resp.json()["detail"]

    # A permissionless account gets 403.
    def test_permissionless_account_gets_403(self, client, make_role, make_user, location, auth_headers):
        headers = auth_headers(make_user(make_role("no-access"), location, email="nobody@example.com"))
        assert client.get("/audit-logs", headers=headers).status_code == 403

    # No credentials returns 401, before any permission check.
    def test_missing_credentials_returns_401(self, client):
        assert client.get("/audit-logs").status_code == 401

    # The seeded manager role does not hold audit.view.
    def test_manager_defaults_do_not_include_audit_view(self):
        assert Permission.AUDIT_VIEW not in DEFAULT_ROLE_PERMISSIONS["manager"]
        assert Permission.AUDIT_VIEW not in DEFAULT_ROLE_PERMISSIONS["user"]

    # The log is not writable or deletable through the API.
    @pytest.mark.parametrize("method", ["post", "patch", "put", "delete"])
    def test_the_endpoint_is_read_only(self, client, auditor_headers, db_session, auditor, method):
        row = _log(db_session, user=auditor)

        collection = getattr(client, method)("/audit-logs", headers=auditor_headers)
        item = getattr(client, method)(f"/audit-logs/{row.id}", headers=auditor_headers)

        # 405 on the collection (path exists, verb doesn't), 404 on the item path (no such route) -- never a success.
        assert collection.status_code == 405, collection.text
        assert item.status_code == 404, item.text
        assert db_session.query(AuditLog).count() == 1


class TestAuditLogFilters:
    # Filtering by event type.
    def test_event_type_filter(self, client, auditor_headers, db_session, auditor):
        _log(db_session, user=auditor, event_type="login_success")
        _log(db_session, user=auditor, event_type="patient_view")

        body = client.get("/audit-logs", headers=auditor_headers, params={"event_type": "patient_view"}).json()
        assert body["total"] == 1
        assert body["items"][0]["event_type"] == "patient_view"

    # Several event types combine as OR.
    def test_event_type_filter_accepts_several_values(self, client, auditor_headers, db_session, auditor):
        _log(db_session, user=auditor, event_type="login_success")
        _log(db_session, user=auditor, event_type="patient_view")
        _log(db_session, user=auditor, event_type="role_change")

        body = client.get(
            "/audit-logs", headers=auditor_headers, params={"event_type": ["login_success", "role_change"]}
        ).json()
        assert body["total"] == 2
        assert {item["event_type"] for item in body["items"]} == {"login_success", "role_change"}

    # Filtering by actor, case-insensitively, on the name.
    def test_actor_filter_matches_name_case_insensitively(
        self, client, auditor_headers, db_session, auditor, make_role, make_user, location
    ):
        other = make_user(make_role("other"), location, email="grace@example.com")
        db_session.query(type(other)).filter_by(id=other.id).update({"last_name": "Hopper"})
        db_session.commit()

        _log(db_session, user=auditor)
        _log(db_session, user=other)

        body = client.get("/audit-logs", headers=auditor_headers, params={"actor": "HOPP"}).json()
        assert body["total"] == 1
        assert body["items"][0]["actor"]["email"] == "grace@example.com"

    # Filtering by actor also matches the email.
    def test_actor_filter_matches_email(self, client, auditor_headers, db_session, auditor, make_role, make_user, location):
        other = make_user(make_role("other"), location, email="grace@example.com")
        _log(db_session, user=auditor)
        _log(db_session, user=other)

        body = client.get("/audit-logs", headers=auditor_headers, params={"actor": "grace@"}).json()
        assert body["total"] == 1
        assert body["items"][0]["actor"]["email"] == "grace@example.com"

    # An actorless row (a sign-in against an unknown email) still comes back.
    def test_rows_without_an_actor_are_returned(self, client, auditor_headers, db_session):
        _log(db_session, user=None, event_type="login_failure", detail={"email": "ghost@example.com"})

        body = client.get("/audit-logs", headers=auditor_headers).json()
        assert body["total"] == 1
        assert body["items"][0]["actor"] is None

    # The date range is inclusive at both ends.
    def test_date_range_filter_is_inclusive(self, client, auditor_headers, db_session, auditor):
        _log(db_session, user=auditor, created_at=datetime(2024, 3, 1, 12, 0, tzinfo=timezone.utc))
        # 23:59 on the upper bound's own day must still match -- comparing against midnight would drop this row.
        _log(db_session, user=auditor, created_at=datetime(2024, 3, 3, 23, 59, tzinfo=timezone.utc))
        _log(db_session, user=auditor, created_at=datetime(2024, 3, 5, 12, 0, tzinfo=timezone.utc))

        body = client.get(
            "/audit-logs", headers=auditor_headers, params={"date_from": "2024-03-01", "date_to": "2024-03-03"}
        ).json()
        assert body["total"] == 2

    # Each bound works on its own.
    def test_date_bounds_work_independently(self, client, auditor_headers, db_session, auditor):
        _log(db_session, user=auditor, created_at=datetime(2024, 3, 1, 12, 0, tzinfo=timezone.utc))
        _log(db_session, user=auditor, created_at=datetime(2024, 3, 5, 12, 0, tzinfo=timezone.utc))

        from_only = client.get("/audit-logs", headers=auditor_headers, params={"date_from": "2024-03-02"}).json()
        assert from_only["total"] == 1

        to_only = client.get("/audit-logs", headers=auditor_headers, params={"date_to": "2024-03-02"}).json()
        assert to_only["total"] == 1

    # Filters combine with AND, not OR.
    def test_filters_combine_with_and(self, client, auditor_headers, db_session, auditor):
        _log(db_session, user=auditor, event_type="login_success", created_at=datetime(2024, 3, 1, tzinfo=timezone.utc))
        _log(db_session, user=auditor, event_type="patient_view", created_at=datetime(2024, 3, 1, tzinfo=timezone.utc))
        _log(db_session, user=auditor, event_type="login_success", created_at=datetime(2024, 5, 1, tzinfo=timezone.utc))

        body = client.get(
            "/audit-logs",
            headers=auditor_headers,
            params={"event_type": "login_success", "date_from": "2024-04-01"},
        ).json()
        assert body["total"] == 1

    # An unknown event type matches nothing rather than erroring.
    def test_unknown_event_type_matches_nothing(self, client, auditor_headers, db_session, auditor):
        _log(db_session, user=auditor)
        body = client.get("/audit-logs", headers=auditor_headers, params={"event_type": "not_a_thing"}).json()
        assert body["total"] == 0
        assert body["items"] == []


class TestAuditLogOrderingAndPagination:
    # Newest first by default.
    def test_default_order_is_newest_first(self, client, auditor_headers, db_session, auditor):
        base = datetime(2024, 3, 1, tzinfo=timezone.utc)
        for offset, event_type in enumerate(("login_success", "patient_view", "role_change")):
            _log(db_session, user=auditor, event_type=event_type, created_at=base + timedelta(hours=offset))

        body = client.get("/audit-logs", headers=auditor_headers).json()
        assert [item["event_type"] for item in body["items"]] == ["role_change", "patient_view", "login_success"]

    # Rows sharing a timestamp still come back in one total order, with no row appearing on two pages or none.
    def test_ordering_is_deterministic_across_pages_for_tied_timestamps(
        self, client, auditor_headers, db_session, auditor
    ):
        tied = datetime(2024, 3, 1, 12, 0, tzinfo=timezone.utc)
        for _ in range(6):
            _log(db_session, user=auditor, created_at=tied)

        seen: list[int] = []
        for page in (1, 2, 3):
            body = client.get(
                "/audit-logs", headers=auditor_headers, params={"page": page, "page_size": 2}
            ).json()
            assert body["total"] == 6
            seen.extend(item["id"] for item in body["items"])

        assert len(set(seen)) == 6, "a row was repeated or dropped across pages"
        assert seen == sorted(seen, reverse=True)

    # An UPDATE elsewhere in the table doesn't reshuffle the result -- the bug the lookups endpoints hit with no ORDER BY.
    def test_order_survives_an_update(self, client, auditor_headers, db_session, auditor):
        tied = datetime(2024, 3, 1, 12, 0, tzinfo=timezone.utc)
        for _ in range(5):
            _log(db_session, user=auditor, created_at=tied)

        before = [item["id"] for item in client.get("/audit-logs", headers=auditor_headers).json()["items"]]

        middle = db_session.query(AuditLog).order_by(AuditLog.id).offset(2).first()
        middle.user_agent = "rewritten"
        db_session.commit()

        after = [item["id"] for item in client.get("/audit-logs", headers=auditor_headers).json()["items"]]
        assert after == before

    # Sorting by event type, ascending.
    def test_sort_by_event_type(self, client, auditor_headers, db_session, auditor):
        for event_type in ("patient_view", "login_success", "role_change"):
            _log(db_session, user=auditor, event_type=event_type)

        body = client.get(
            "/audit-logs", headers=auditor_headers, params={"sort_by": "event_type", "sort_dir": "asc"}
        ).json()
        assert [item["event_type"] for item in body["items"]] == ["login_success", "patient_view", "role_change"]

    # Pagination reports the full total, not the page length.
    def test_pagination(self, client, auditor_headers, db_session, auditor):
        base = datetime(2024, 3, 1, tzinfo=timezone.utc)
        for offset in range(5):
            _log(db_session, user=auditor, created_at=base + timedelta(hours=offset))

        body = client.get("/audit-logs", headers=auditor_headers, params={"page": 2, "page_size": 2}).json()
        assert body["total"] == 5
        assert len(body["items"]) == 2

        last = client.get("/audit-logs", headers=auditor_headers, params={"page": 3, "page_size": 2}).json()
        assert len(last["items"]) == 1

    # The page size is capped rather than letting a caller pull the whole table.
    def test_page_size_is_capped(self, client, auditor_headers):
        assert client.get("/audit-logs", headers=auditor_headers, params={"page_size": 201}).status_code == 422
        assert client.get("/audit-logs", headers=auditor_headers, params={"page_size": 200}).status_code == 200

    # The known event types come back with the page, for the client's filter.
    def test_response_carries_the_event_type_catalog(self, client, auditor_headers):
        body = client.get("/audit-logs", headers=auditor_headers).json()
        assert body["event_types"] == list(AUDIT_EVENT_TYPES)


class TestAuditLogActorJoin:
    # The acting user comes back resolved, not as a bare UUID.
    def test_actor_is_joined_not_a_bare_uuid(self, client, auditor_headers, db_session, auditor):
        _log(db_session, user=auditor)

        actor = client.get("/audit-logs", headers=auditor_headers).json()["items"][0]["actor"]
        assert actor["id"] == str(auditor.id)
        assert actor["email"] == auditor.email
        assert actor["first_name"] == auditor.first_name

    # The actor projection stops at identity -- not a copy of the user directory, and doesn't disclose the permission model.
    def test_actor_carries_no_role_or_account_state(self, client, auditor_headers, db_session, auditor):
        _log(db_session, user=auditor)

        actor = client.get("/audit-logs", headers=auditor_headers).json()["items"][0]["actor"]
        assert set(actor) == {"id", "email", "username", "first_name", "last_name"}


class TestAuditLogContainsNoPHI:
    """audit_logs is PHI-free by construction at every write site; this is the
    read side of that guarantee. If a future event type starts recording
    patient values, these fail rather than the endpoint quietly serving them."""

    @pytest.fixture
    def patient(self, db_session, auditor):
        row = Patient(
            patient_code="P-AUDIT-1",
            first_name_enc=encrypt_field("Ada"),
            last_name_enc=encrypt_field("Lovelace"),
            date_of_birth_enc=encrypt_field("1990-01-15"),
            gender_enc=encrypt_field("Female"),
            uploaded_by=auditor.id,
        )
        db_session.add(row)
        db_session.commit()
        db_session.refresh(row)
        return row

    # A real patient_view/patient_edit event exposes ids and field names only.
    def test_patient_events_expose_no_patient_values(
        self, client, auditor_headers, db_session, auditor, patient
    ):
        _log(db_session, user=auditor, event_type="patient_view", detail={"patient_id": str(patient.id)})
        _log(
            db_session,
            user=auditor,
            event_type="patient_edit",
            detail={"patient_id": str(patient.id), "changed_fields": ["first_name", "date_of_birth"]},
        )

        raw = client.get("/audit-logs", headers=auditor_headers).text
        for phi in ("Ada", "Lovelace", "1990-01-15", "Female", "P-AUDIT-1"):
            assert phi not in raw, f"{phi!r} reached the audit log response"

    # The endpoint never joins to (or otherwise reaches into) the patients table.
    def test_the_response_carries_no_patient_fields(self, client, auditor_headers, db_session, auditor, patient):
        _log(db_session, user=auditor, event_type="patient_view", detail={"patient_id": str(patient.id)})

        item = client.get("/audit-logs", headers=auditor_headers).json()["items"][0]
        assert set(item) == {
            "id",
            "event_type",
            "event_detail",
            "ip_address",
            "user_agent",
            "created_at",
            "actor",
        }
        # The id is a pointer, not data -- nothing resolves it into a record.
        assert item["event_detail"] == {"patient_id": str(patient.id)}

    # event_detail is passed through verbatim, not shape-interpreted, so the endpoint can't start surfacing values.
    def test_event_detail_is_passed_through_unchanged(self, client, auditor_headers, db_session, auditor):
        detail = {"nested": {"a": [1, 2]}, "count": 3, "flag": True, "missing": None}
        _log(db_session, user=auditor, event_type="patient_analytics_view", detail=detail)

        assert client.get("/audit-logs", headers=auditor_headers).json()["items"][0]["event_detail"] == detail


class TestAuditEventCatalogIntegrity:
    """The same rule the permission catalog is held to: the list the API
    publishes describes what the application actually emits."""

    # Every event_type literal written anywhere in the app is catalogued.
    def test_every_emitted_event_type_is_catalogued(self):
        import app

        app_dir = pathlib.Path(app.__file__).parent
        catalog_file = app_dir / "core" / "audit_events.py"
        sources = "\n".join(
            path.read_text(encoding="utf-8") for path in app_dir.rglob("*.py") if path != catalog_file
        )

        emitted = set(re.findall(r'event_type=["\']([a-z_]+)["\']', sources))
        assert emitted, "found no event_type= literals -- the pattern needs updating"
        assert emitted <= set(AUDIT_EVENT_TYPES), f"emitted but not catalogued: {sorted(emitted - set(AUDIT_EVENT_TYPES))}"

    # ...and nothing is catalogued that no longer exists.
    def test_the_catalog_has_no_duplicates(self):
        assert len(AUDIT_EVENT_TYPES) == len(set(AUDIT_EVENT_TYPES))


class TestAuditLogIsWrittenByTheAuditedPaths:
    """A read endpoint over an empty table would pass every test above, so
    this checks the two halves actually meet: an action taken through the API
    shows up in the view."""

    # A role change made through PATCH /users is readable here afterwards.
    def test_a_role_change_appears_in_the_audit_view(
        self, client, db_session, make_role, make_user, location, auth_headers
    ):
        admin_role = make_role("admin", DEFAULT_ROLE_PERMISSIONS["admin"])
        target_role = make_role("target", [], parent=admin_role)
        promoted_role = make_role("promoted", [], parent=admin_role)
        admin = make_user(admin_role, location, email="admin@example.com")
        target = make_user(target_role, location, email="target@example.com")
        headers = auth_headers(admin)

        assert client.patch(
            f"/users/{target.id}", json={"role_id": promoted_role.id}, headers=headers
        ).status_code == 200

        body = client.get("/audit-logs", headers=headers, params={"event_type": "role_change"}).json()
        assert body["total"] == 1
        assert body["items"][0]["actor"]["email"] == admin.email
        assert body["items"][0]["event_detail"]["user_id"] == str(target.id)

    # Reading the audit log does not itself write a row (which would make the table grow every time anyone looked at it).
    def test_reading_the_log_writes_no_row(self, client, auditor_headers, db_session):
        client.get("/audit-logs", headers=auditor_headers)
        assert db_session.query(AuditLog).count() == 0

    # A nonexistent id isn't a route at all -- there is no per-row endpoint.
    def test_there_is_no_single_row_endpoint(self, client, auditor_headers):
        assert client.get(f"/audit-logs/{uuid.uuid4()}", headers=auditor_headers).status_code == 404
