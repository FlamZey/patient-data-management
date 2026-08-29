import uuid

import pytest

from app.core.limiter import limiter
from app.core.security import create_access_token, hash_password
from app.models import AuditLog, Location, Team, User

_TEST_PASSWORD = "ValidPass123!"


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """POST /users is rate-limited via the shared app.core.limiter, whose
    in-memory counter persists for the whole pytest process (and is keyed per
    route+IP, not per user) -- reset it before every test so an earlier
    test's create calls never push a later test over the limit. Mirrors the
    same fixture in test_auth.py / test_patients.py."""
    limiter.reset()
    yield


def _make_user(
    db_session,
    *,
    role,
    location,
    team=None,
    email="user@example.com",
    first_name="Test",
    last_name="User",
    status="active",
) -> User:
    user = User(
        email=email,
        username=email.split("@")[0],
        password_hash=hash_password(_TEST_PASSWORD),
        first_name=first_name,
        last_name=last_name,
        role_id=role.id,
        location_id=location.id,
        team_id=team.id if team else None,
        status=status,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def outsider(location, make_role, make_user):
    """An active user with no granted permissions -- for asserting that a
    specific permission gate is enforced, not just 'must be authenticated'."""
    return make_user(make_role("no-access"), location, email="outsider@example.com")


@pytest.fixture
def outsider_headers(outsider, auth_headers):
    return auth_headers(outsider)


@pytest.fixture
def admin_user(location, make_role, make_user):
    """An active user granted every user.* permission -- for tests that need
    to drive an endpoint's business logic and aren't themselves testing
    permission-gating (see TestListUsers etc. for that)."""
    role = make_role("admin", ["user.view", "user.create", "user.edit", "user.delete"])
    return make_user(role, location, email="admin@example.com")


@pytest.fixture
def admin_headers(admin_user, auth_headers):
    return auth_headers(admin_user)


def _create_payload(*, role_id, location_id, **overrides):
    payload = {
        "email": "new-hire@example.com",
        "username": "new-hire",
        "password": "ValidPass123!",
        "first_name": "New",
        "last_name": "Hire",
        "role_id": role_id,
        "location_id": location_id,
    }
    payload.update(overrides)
    return payload


class TestListUsers:
    # No permission returns 403.
    def test_no_permission_gets_403(self, client, outsider_headers):
        resp = client.get("/users", headers=outsider_headers)
        assert resp.status_code == 403

    # User view permission returns all users.
    def test_user_view_permission_returns_all_users(
        self, client, location, make_role, make_user, auth_headers, active_user
    ):
        actor_role = make_role("manager", ["user.view"])
        actor = make_user(actor_role, location, email="manager@example.com")

        resp = client.get("/users", headers=auth_headers(actor))
        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 2
        emails = {row["email"] for row in body["items"]}
        assert actor.email in emails
        assert active_user.email in emails


@pytest.fixture
def viewer_headers(location, make_role, make_user, auth_headers):
    """A user.view-only actor for the filter/sort/pagination tests below --
    kept separate from admin_headers so those tests aren't tripped up by
    admin_user also existing in the users table."""
    role = make_role("viewer", ["user.view"])
    viewer = make_user(role, location, email="viewer@example.com")
    return auth_headers(viewer)


class TestListUsersFilters:
    # Name filter is case insensitive.
    def test_name_filter_is_case_insensitive(self, client, db_session, location, make_role, viewer_headers):
        role = make_role("staff")
        _make_user(db_session, role=role, location=location, email="ada@example.com", first_name="Ada", last_name="Lovelace")
        _make_user(db_session, role=role, location=location, email="grace@example.com", first_name="Grace", last_name="Hopper")

        resp = client.get("/users", headers=viewer_headers, params={"name": "GRACE"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["last_name"] == "Hopper"

    # Email filter.
    def test_email_filter(self, client, db_session, location, make_role, viewer_headers):
        role = make_role("staff")
        _make_user(db_session, role=role, location=location, email="ada@example.com")
        _make_user(db_session, role=role, location=location, email="grace@example.com")

        resp = client.get("/users", headers=viewer_headers, params={"email": "grace"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["email"] == "grace@example.com"

    # Role filter.
    def test_role_filter(self, client, db_session, location, make_role, viewer_headers):
        engineer_role = make_role("engineer")
        analyst_role = make_role("analyst")
        _make_user(db_session, role=engineer_role, location=location, email="e@example.com")
        _make_user(db_session, role=analyst_role, location=location, email="a@example.com")

        resp = client.get("/users", headers=viewer_headers, params={"role": "Engineer"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["email"] == "e@example.com"

    # Location filter.
    def test_location_filter(self, client, db_session, location, make_role, viewer_headers):
        other_location = Location(code="IN", name="India")
        db_session.add(other_location)
        db_session.commit()

        role = make_role("staff")
        _make_user(db_session, role=role, location=location, email="us@example.com")
        _make_user(db_session, role=role, location=other_location, email="in@example.com")

        resp = client.get("/users", headers=viewer_headers, params={"location": "India"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["email"] == "in@example.com"

    # Team filter matches unassigned.
    def test_team_filter_matches_unassigned(self, client, db_session, location, make_role, viewer_headers):
        team = Team(code="AR", name="Accounts Receivable")
        db_session.add(team)
        db_session.commit()

        role = make_role("staff")
        _make_user(db_session, role=role, location=location, team=team, email="teamed@example.com")
        _make_user(db_session, role=role, location=location, email="unassigned@example.com")

        resp = client.get("/users", headers=viewer_headers, params={"team": "Unassigned", "role": "Staff"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["email"] == "unassigned@example.com"

    # Team filter combines real names with unassigned.
    def test_team_filter_combines_real_names_with_unassigned(
        self, client, db_session, location, make_role, viewer_headers
    ):
        team = Team(code="AR", name="Accounts Receivable")
        db_session.add(team)
        db_session.commit()

        role = make_role("staff")
        _make_user(db_session, role=role, location=location, team=team, email="teamed@example.com")
        _make_user(db_session, role=role, location=location, email="unassigned@example.com")

        resp = client.get(
            "/users",
            headers=viewer_headers,
            params={"team": ["Accounts Receivable", "Unassigned"], "role": "Staff"},
        )
        body = resp.json()
        assert body["total"] == 2

    # Status filter.
    def test_status_filter(self, client, db_session, location, make_role, viewer_headers):
        role = make_role("staff")
        _make_user(db_session, role=role, location=location, email="active@example.com", status="active")
        _make_user(db_session, role=role, location=location, email="suspended@example.com", status="suspended")

        resp = client.get("/users", headers=viewer_headers, params={"status": "suspended"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["email"] == "suspended@example.com"

    # Column filters combine with and not or.
    def test_column_filters_combine_with_and_not_or(self, client, db_session, location, make_role, viewer_headers):
        role = make_role("staff")
        _make_user(db_session, role=role, location=location, email="ada@example.com", first_name="Ada", last_name="Lovelace")
        _make_user(db_session, role=role, location=location, email="ada2@example.com", first_name="Ada", last_name="Hopper")

        resp = client.get("/users", headers=viewer_headers, params={"name": "Ada", "email": "ada2"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["last_name"] == "Hopper"

    # Sort and pagination.
    def test_sort_and_pagination(self, client, db_session, location, make_role, viewer_headers):
        role = make_role("staff")
        for name in ("Charlie", "Alice", "Bob"):
            _make_user(
                db_session, role=role, location=location, email=f"{name.lower()}@example.com", first_name=name, last_name="Z"
            )

        resp = client.get(
            "/users", headers=viewer_headers, params={"sort_by": "name", "sort_dir": "asc", "role": "Staff"}
        )
        assert [item["first_name"] for item in resp.json()["items"]] == ["Alice", "Bob", "Charlie"]

        page_resp = client.get(
            "/users", headers=viewer_headers, params={"role": "Staff", "page": 2, "page_size": 2}
        )
        page_body = page_resp.json()
        assert page_body["total"] == 3
        assert len(page_body["items"]) == 1


class TestGetUser:
    # No permission returns 403.
    def test_no_permission_gets_403(self, client, outsider_headers, active_user):
        resp = client.get(f"/users/{active_user.id}", headers=outsider_headers)
        assert resp.status_code == 403

    # User view permission returns matching user.
    def test_user_view_permission_returns_matching_user(
        self, client, location, make_role, make_user, auth_headers, active_user
    ):
        actor_role = make_role("manager", ["user.view"])
        actor = make_user(actor_role, location, email="manager@example.com")

        resp = client.get(f"/users/{active_user.id}", headers=auth_headers(actor))
        assert resp.status_code == 200
        assert resp.json()["email"] == active_user.email

    # Nonexistent id returns 404.
    def test_nonexistent_id_returns_404(self, client, admin_headers):
        resp = client.get(f"/users/{uuid.uuid4()}", headers=admin_headers)
        assert resp.status_code == 404


class TestCreateUser:
    # No permission returns 403.
    def test_no_permission_gets_403(self, client, location, outsider_headers, role):
        payload = _create_payload(role_id=role.id, location_id=location.id)
        resp = client.post("/users", json=payload, headers=outsider_headers)
        assert resp.status_code == 403

    # User create permission creates user with hashed password.
    def test_user_create_permission_creates_user_with_hashed_password(
        self, client, db_session, location, make_role, make_user, auth_headers, role
    ):
        actor_role = make_role("manager", ["user.create"])
        actor = make_user(actor_role, location, email="manager@example.com")

        payload = _create_payload(role_id=role.id, location_id=location.id)
        resp = client.post("/users", json=payload, headers=auth_headers(actor))
        assert resp.status_code == 201

        body = resp.json()
        assert body["email"] == payload["email"]
        assert "password" not in body
        assert "password_hash" not in body

        created = db_session.query(User).filter(User.email == payload["email"]).one()
        assert created.password_hash != payload["password"]
        assert created.created_by == actor.id

    # Create writes audit log.
    def test_create_writes_audit_log(self, client, db_session, admin_headers, admin_user, role, location):
        payload = _create_payload(role_id=role.id, location_id=location.id)
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 201

        created = db_session.query(User).filter(User.email == payload["email"]).one()
        audit_row = db_session.query(AuditLog).filter(AuditLog.event_type == "user_created").one()
        assert audit_row.event_detail["created_user_id"] == str(created.id)
        assert audit_row.user_id == admin_user.id

    # Duplicate email returns 409.
    def test_duplicate_email_returns_409(self, client, admin_headers, role, location, active_user):
        payload = _create_payload(role_id=role.id, location_id=location.id, email=active_user.email)
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 409

    # Duplicate username returns 409.
    def test_duplicate_username_returns_409(self, client, admin_headers, role, location, active_user):
        payload = _create_payload(role_id=role.id, location_id=location.id, username=active_user.username)
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 409

    @pytest.mark.parametrize(
        "password",
        ["short1!", "longenough!", "12345678!", "NoSpecialChar1"],
    )
    # Weak password returns 422.
    def test_weak_password_returns_422(self, client, admin_headers, role, location, password):
        payload = _create_payload(role_id=role.id, location_id=location.id, password=password)
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 422


class TestUpdateUser:
    # No permission returns 403.
    def test_no_permission_gets_403(self, client, outsider_headers, active_user):
        resp = client.patch(f"/users/{active_user.id}", json={"first_name": "New"}, headers=outsider_headers)
        assert resp.status_code == 403

    # User edit permission updates fields.
    def test_user_edit_permission_updates_fields(
        self, client, location, make_role, make_user, auth_headers, active_user
    ):
        actor_role = make_role("manager", ["user.edit"])
        actor = make_user(actor_role, location, email="manager@example.com")

        resp = client.patch(f"/users/{active_user.id}", json={"first_name": "Updated"}, headers=auth_headers(actor))
        assert resp.status_code == 200
        assert resp.json()["first_name"] == "Updated"

    # Nonexistent id returns 404.
    def test_nonexistent_id_returns_404(self, client, admin_headers):
        resp = client.patch(f"/users/{uuid.uuid4()}", json={"first_name": "X"}, headers=admin_headers)
        assert resp.status_code == 404

    # Duplicate email returns 409.
    def test_duplicate_email_returns_409(self, client, admin_headers, active_user, inactive_user):
        resp = client.patch(f"/users/{active_user.id}", json={"email": inactive_user.email}, headers=admin_headers)
        assert resp.status_code == 409

    # Duplicate username returns 409.
    def test_duplicate_username_returns_409(self, client, admin_headers, active_user, inactive_user):
        resp = client.patch(
            f"/users/{active_user.id}", json={"username": inactive_user.username}, headers=admin_headers
        )
        assert resp.status_code == 409

    # Keeping own email does not conflict with self.
    def test_keeping_own_email_does_not_conflict_with_self(self, client, admin_headers, active_user):
        """A PATCH that resends a user's current email (e.g. a form
        submitting its full, mostly-unchanged state) must not be rejected
        as a conflict against the user's own existing row."""
        resp = client.patch(
            f"/users/{active_user.id}",
            json={"email": active_user.email, "first_name": "Same"},
            headers=admin_headers,
        )
        assert resp.status_code == 200

    # Invalid status returns 422.
    def test_invalid_status_returns_422(self, client, admin_headers, active_user):
        resp = client.patch(f"/users/{active_user.id}", json={"status": "banana"}, headers=admin_headers)
        assert resp.status_code == 422


class TestDeleteUser:
    # No permission returns 403.
    def test_no_permission_gets_403(self, client, location, make_role, make_user, auth_headers):
        """A different, unrelated permission (view) is not enough --
        proves the check is specific to user.delete, not just 'has any
        permission at all'."""
        actor_role = make_role("manager", ["user.view"])
        actor = make_user(actor_role, location, email="manager@example.com")

        target_role = make_role("target")
        target = make_user(target_role, location, email="target@example.com")

        resp = client.delete(f"/users/{target.id}", headers=auth_headers(actor))
        assert resp.status_code == 403

    # User delete permission soft deletes target.
    def test_user_delete_permission_soft_deletes_target(
        self, client, db_session, location, make_role, make_user, auth_headers
    ):
        actor_role = make_role("admin", ["user.delete"])
        actor = make_user(actor_role, location, email="admin@example.com")

        target_role = make_role("target")
        target = make_user(target_role, location, email="target@example.com")

        resp = client.delete(f"/users/{target.id}", headers=auth_headers(actor))
        assert resp.status_code == 204

        db_session.refresh(target)
        assert target.status == "suspended"

    # Delete writes audit log.
    def test_delete_writes_audit_log(self, client, db_session, admin_headers, admin_user, location, make_role, make_user):
        target_role = make_role("target")
        target = make_user(target_role, location, email="target@example.com")

        resp = client.delete(f"/users/{target.id}", headers=admin_headers)
        assert resp.status_code == 204

        audit_row = db_session.query(AuditLog).filter(AuditLog.event_type == "user_deleted").one()
        assert audit_row.event_detail["deleted_user_id"] == str(target.id)
        assert audit_row.user_id == admin_user.id

    # Nonexistent id returns 404.
    def test_nonexistent_id_returns_404(self, client, admin_headers):
        resp = client.delete(f"/users/{uuid.uuid4()}", headers=admin_headers)
        assert resp.status_code == 404


class TestUnauthenticated:
    """Requests carrying no Authorization header at all -- distinct from
    outsider_headers (an authenticated user lacking the specific permission),
    this asserts the 401 gate runs before the 403 permission gate on every
    users endpoint."""

    # No auth header at all returns 401 not 403 for list.
    def test_list_returns_401(self, client):
        resp = client.get("/users")
        assert resp.status_code == 401

    # No auth header at all returns 401 not 403 for get.
    def test_get_returns_401(self, client):
        resp = client.get(f"/users/{uuid.uuid4()}")
        assert resp.status_code == 401

    # No auth header at all returns 401 not 403 for create.
    def test_create_returns_401(self, client, role, location):
        resp = client.post("/users", json=_create_payload(role_id=role.id, location_id=location.id))
        assert resp.status_code == 401

    # No auth header at all returns 401 not 403 for update.
    def test_update_returns_401(self, client):
        resp = client.patch(f"/users/{uuid.uuid4()}", json={"first_name": "New"})
        assert resp.status_code == 401

    # No auth header at all returns 401 not 403 for delete.
    def test_delete_returns_401(self, client):
        resp = client.delete(f"/users/{uuid.uuid4()}")
        assert resp.status_code == 401


class TestUserAdversarial:
    """Bad-actor-shaped requests: tampered tokens, malformed bodies, SQLi-
    shaped filter strings, oversized/unicode field values, IDOR via listing."""

    # Tampered bearer token returns 401 not a 500.
    def test_tampered_token_returns_401(self, client, admin_user):
        token = create_access_token(admin_user.id)
        tampered = token[:-4] + ("A" if token[-4] != "A" else "B") + token[-3:]
        resp = client.get("/users", headers={"Authorization": f"Bearer {tampered}"})
        assert resp.status_code == 401

    # Sql injection shaped name filter is treated as a literal string.
    def test_sql_injection_shaped_name_filter_is_treated_as_literal(self, client, admin_headers):
        resp = client.get("/users", headers=admin_headers, params={"name": "'; DROP TABLE users; --"})
        assert resp.status_code == 200
        assert resp.json()["total"] == 0

    # Malformed json body to create returns 422 not a 500.
    def test_malformed_json_body_to_create_returns_422(self, client, admin_headers):
        resp = client.post(
            "/users",
            headers={**admin_headers, "Content-Type": "application/json"},
            content="{not valid json",
        )
        assert resp.status_code == 422

    # Missing required fields on create returns 422.
    def test_missing_required_fields_on_create_returns_422(self, client, admin_headers):
        resp = client.post("/users", headers=admin_headers, json={"email": "incomplete@example.com"})
        assert resp.status_code == 422

    # Invalid email format on create returns 422.
    def test_invalid_email_format_on_create_returns_422(self, client, admin_headers, role, location):
        payload = _create_payload(role_id=role.id, location_id=location.id, email="not-an-email")
        resp = client.post("/users", headers=admin_headers, json=payload)
        assert resp.status_code == 422

    # Unicode and emoji names round trip through create and retrieval unchanged.
    def test_unicode_and_emoji_names_round_trip(self, client, admin_headers, role, location):
        payload = _create_payload(
            role_id=role.id,
            location_id=location.id,
            email="unicode-user@example.com",
            username="unicode-user",
            first_name="Zoë 🎉 名前",
            last_name="Müller-Østergård",
        )
        resp = client.post("/users", headers=admin_headers, json=payload)
        assert resp.status_code == 201
        body = resp.json()
        assert body["first_name"] == "Zoë 🎉 名前"
        assert body["last_name"] == "Müller-Østergård"

    # First name over the 100 char database column limit returns 422 not a 500.
    def test_first_name_over_column_limit_returns_422_not_500(self, client, admin_headers, role, location):
        payload = _create_payload(
            role_id=role.id, location_id=location.id, email="long-name@example.com",
            username="long-name", first_name="A" * 300,
        )
        resp = client.post("/users", headers=admin_headers, json=payload)
        assert resp.status_code == 422

    # Malformed uuid path parameter returns 422 not a 500.
    def test_malformed_uuid_path_parameter_returns_422(self, client, admin_headers):
        resp = client.get("/users/not-a-uuid", headers=admin_headers)
        assert resp.status_code == 422

    # Create rate limit returns 429 on the eleventh request within a minute.
    def test_create_rate_limited_after_ten_requests_per_minute(self, client, admin_headers, role, location):
        for i in range(10):
            payload = _create_payload(
                role_id=role.id, location_id=location.id, email=f"rl-{i}@example.com", username=f"rl-{i}"
            )
            resp = client.post("/users", headers=admin_headers, json=payload)
            assert resp.status_code == 201
        payload = _create_payload(role_id=role.id, location_id=location.id, email="rl-10@example.com", username="rl-10")
        resp = client.post("/users", headers=admin_headers, json=payload)
        assert resp.status_code == 429
