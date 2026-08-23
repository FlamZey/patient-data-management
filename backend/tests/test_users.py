import uuid

import pytest

from app.core.security import hash_password
from app.models import AuditLog, Location, Team, User

_TEST_PASSWORD = "ValidPass123!"


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
    def test_no_permission_gets_403(self, client, outsider_headers):
        resp = client.get("/users", headers=outsider_headers)
        assert resp.status_code == 403

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
    def test_name_filter_is_case_insensitive(self, client, db_session, location, make_role, viewer_headers):
        role = make_role("staff")
        _make_user(db_session, role=role, location=location, email="ada@example.com", first_name="Ada", last_name="Lovelace")
        _make_user(db_session, role=role, location=location, email="grace@example.com", first_name="Grace", last_name="Hopper")

        resp = client.get("/users", headers=viewer_headers, params={"name": "GRACE"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["last_name"] == "Hopper"

    def test_email_filter(self, client, db_session, location, make_role, viewer_headers):
        role = make_role("staff")
        _make_user(db_session, role=role, location=location, email="ada@example.com")
        _make_user(db_session, role=role, location=location, email="grace@example.com")

        resp = client.get("/users", headers=viewer_headers, params={"email": "grace"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["email"] == "grace@example.com"

    def test_role_filter(self, client, db_session, location, make_role, viewer_headers):
        engineer_role = make_role("engineer")
        analyst_role = make_role("analyst")
        _make_user(db_session, role=engineer_role, location=location, email="e@example.com")
        _make_user(db_session, role=analyst_role, location=location, email="a@example.com")

        resp = client.get("/users", headers=viewer_headers, params={"role": "Engineer"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["email"] == "e@example.com"

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

    def test_status_filter(self, client, db_session, location, make_role, viewer_headers):
        role = make_role("staff")
        _make_user(db_session, role=role, location=location, email="active@example.com", status="active")
        _make_user(db_session, role=role, location=location, email="suspended@example.com", status="suspended")

        resp = client.get("/users", headers=viewer_headers, params={"status": "suspended"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["email"] == "suspended@example.com"

    def test_column_filters_combine_with_and_not_or(self, client, db_session, location, make_role, viewer_headers):
        role = make_role("staff")
        _make_user(db_session, role=role, location=location, email="ada@example.com", first_name="Ada", last_name="Lovelace")
        _make_user(db_session, role=role, location=location, email="ada2@example.com", first_name="Ada", last_name="Hopper")

        resp = client.get("/users", headers=viewer_headers, params={"name": "Ada", "email": "ada2"})
        body = resp.json()
        assert body["total"] == 1
        assert body["items"][0]["last_name"] == "Hopper"

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
    def test_no_permission_gets_403(self, client, outsider_headers, active_user):
        resp = client.get(f"/users/{active_user.id}", headers=outsider_headers)
        assert resp.status_code == 403

    def test_user_view_permission_returns_matching_user(
        self, client, location, make_role, make_user, auth_headers, active_user
    ):
        actor_role = make_role("manager", ["user.view"])
        actor = make_user(actor_role, location, email="manager@example.com")

        resp = client.get(f"/users/{active_user.id}", headers=auth_headers(actor))
        assert resp.status_code == 200
        assert resp.json()["email"] == active_user.email

    def test_nonexistent_id_returns_404(self, client, admin_headers):
        resp = client.get(f"/users/{uuid.uuid4()}", headers=admin_headers)
        assert resp.status_code == 404


class TestCreateUser:
    def test_no_permission_gets_403(self, client, location, outsider_headers, role):
        payload = _create_payload(role_id=role.id, location_id=location.id)
        resp = client.post("/users", json=payload, headers=outsider_headers)
        assert resp.status_code == 403

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

    def test_create_writes_audit_log(self, client, db_session, admin_headers, admin_user, role, location):
        payload = _create_payload(role_id=role.id, location_id=location.id)
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 201

        created = db_session.query(User).filter(User.email == payload["email"]).one()
        audit_row = db_session.query(AuditLog).filter(AuditLog.event_type == "user_created").one()
        assert audit_row.event_detail["created_user_id"] == str(created.id)
        assert audit_row.user_id == admin_user.id

    def test_duplicate_email_returns_409(self, client, admin_headers, role, location, active_user):
        payload = _create_payload(role_id=role.id, location_id=location.id, email=active_user.email)
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 409

    def test_duplicate_username_returns_409(self, client, admin_headers, role, location, active_user):
        payload = _create_payload(role_id=role.id, location_id=location.id, username=active_user.username)
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 409

    @pytest.mark.parametrize(
        "password",
        ["short1!", "longenough!", "12345678!", "NoSpecialChar1"],
    )
    def test_weak_password_returns_422(self, client, admin_headers, role, location, password):
        payload = _create_payload(role_id=role.id, location_id=location.id, password=password)
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 422


class TestUpdateUser:
    def test_no_permission_gets_403(self, client, outsider_headers, active_user):
        resp = client.patch(f"/users/{active_user.id}", json={"first_name": "New"}, headers=outsider_headers)
        assert resp.status_code == 403

    def test_user_edit_permission_updates_fields(
        self, client, location, make_role, make_user, auth_headers, active_user
    ):
        actor_role = make_role("manager", ["user.edit"])
        actor = make_user(actor_role, location, email="manager@example.com")

        resp = client.patch(f"/users/{active_user.id}", json={"first_name": "Updated"}, headers=auth_headers(actor))
        assert resp.status_code == 200
        assert resp.json()["first_name"] == "Updated"

    def test_nonexistent_id_returns_404(self, client, admin_headers):
        resp = client.patch(f"/users/{uuid.uuid4()}", json={"first_name": "X"}, headers=admin_headers)
        assert resp.status_code == 404

    def test_duplicate_email_returns_409(self, client, admin_headers, active_user, inactive_user):
        resp = client.patch(f"/users/{active_user.id}", json={"email": inactive_user.email}, headers=admin_headers)
        assert resp.status_code == 409

    def test_duplicate_username_returns_409(self, client, admin_headers, active_user, inactive_user):
        resp = client.patch(
            f"/users/{active_user.id}", json={"username": inactive_user.username}, headers=admin_headers
        )
        assert resp.status_code == 409

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

    def test_invalid_status_returns_422(self, client, admin_headers, active_user):
        resp = client.patch(f"/users/{active_user.id}", json={"status": "banana"}, headers=admin_headers)
        assert resp.status_code == 422


class TestDeleteUser:
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

    def test_delete_writes_audit_log(self, client, db_session, admin_headers, admin_user, location, make_role, make_user):
        target_role = make_role("target")
        target = make_user(target_role, location, email="target@example.com")

        resp = client.delete(f"/users/{target.id}", headers=admin_headers)
        assert resp.status_code == 204

        audit_row = db_session.query(AuditLog).filter(AuditLog.event_type == "user_deleted").one()
        assert audit_row.event_detail["deleted_user_id"] == str(target.id)
        assert audit_row.user_id == admin_user.id

    def test_nonexistent_id_returns_404(self, client, admin_headers):
        resp = client.delete(f"/users/{uuid.uuid4()}", headers=admin_headers)
        assert resp.status_code == 404
