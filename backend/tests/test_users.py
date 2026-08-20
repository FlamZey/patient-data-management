import uuid

import pytest

from app.models import AuditLog, User


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
    def test_no_permission_gets_403(self, client, location, make_role, make_user, auth_headers):
        actor_role = make_role("no-access")
        actor = make_user(actor_role, location, email="outsider@example.com")

        resp = client.get("/users", headers=auth_headers(actor))
        assert resp.status_code == 403

    def test_user_view_permission_returns_all_users(
        self, client, location, make_role, make_user, auth_headers, active_user
    ):
        actor_role = make_role("manager", ["user.view"])
        actor = make_user(actor_role, location, email="manager@example.com")

        resp = client.get("/users", headers=auth_headers(actor))
        assert resp.status_code == 200
        emails = {row["email"] for row in resp.json()}
        assert actor.email in emails
        assert active_user.email in emails


class TestGetUser:
    def test_no_permission_gets_403(self, client, location, make_role, make_user, auth_headers, active_user):
        actor_role = make_role("no-access")
        actor = make_user(actor_role, location, email="outsider@example.com")

        resp = client.get(f"/users/{active_user.id}", headers=auth_headers(actor))
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
    def test_no_permission_gets_403(self, client, location, make_role, make_user, auth_headers, role):
        actor_role = make_role("no-access")
        actor = make_user(actor_role, location, email="outsider@example.com")

        payload = _create_payload(role_id=role.id, location_id=location.id)
        resp = client.post("/users", json=payload, headers=auth_headers(actor))
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
    def test_no_permission_gets_403(self, client, location, make_role, make_user, auth_headers, active_user):
        actor_role = make_role("no-access")
        actor = make_user(actor_role, location, email="outsider@example.com")

        resp = client.patch(f"/users/{active_user.id}", json={"first_name": "New"}, headers=auth_headers(actor))
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
