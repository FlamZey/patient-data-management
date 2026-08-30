"""Authorization tests driven through real HTTP requests.

Everything here goes through the TestClient against a live route, so what's
being asserted is the status code a caller actually receives -- not that some
helper function returns False. A permission check that exists but isn't wired
into a route would pass a unit test of the helper and fail every test here.

The roles are built as a real hierarchy (admin <- manager <- user, via
roles.parent_role_id) using the seeded grants from app.core.permissions, so
these tests exercise the shipped model rather than an invented one.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.limiter import limiter
from app.core.permissions import DEFAULT_ROLE_PERMISSIONS, PERMISSION_CATALOG, Permission
from app.core.security import generate_refresh_token, hash_refresh_token
from app.models import AuditLog, Location, RefreshToken, Team, User


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """POST /users is rate-limited on a process-wide in-memory counter keyed
    by route+IP, so one test's creates would otherwise leak into the next."""
    limiter.reset()
    yield


# --- the shipped role hierarchy ---------------------------------------------


@pytest.fixture
def admin_role(make_role):
    return make_role("admin", DEFAULT_ROLE_PERMISSIONS["admin"])


@pytest.fixture
def manager_role(make_role, admin_role):
    return make_role("manager", DEFAULT_ROLE_PERMISSIONS["manager"], parent=admin_role)


@pytest.fixture
def user_role(make_role, manager_role):
    return make_role("user", DEFAULT_ROLE_PERMISSIONS["user"], parent=manager_role)


@pytest.fixture
def admin(make_user, admin_role, location):
    return make_user(admin_role, location, email="admin@example.com")


@pytest.fixture
def manager(make_user, manager_role, location):
    return make_user(manager_role, location, email="manager@example.com")


@pytest.fixture
def other_manager(make_user, manager_role, location):
    return make_user(manager_role, location, email="other-manager@example.com")


@pytest.fixture
def plain_user(make_user, user_role, location):
    return make_user(user_role, location, email="plain@example.com")


@pytest.fixture
def admin_headers(admin, auth_headers):
    return auth_headers(admin)


@pytest.fixture
def manager_headers(manager, auth_headers):
    return auth_headers(manager)


@pytest.fixture
def user_headers(plain_user, auth_headers):
    return auth_headers(plain_user)


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


class TestPermissionCatalogIntegrity:
    """Guards the rule that a permission must be enforced or not exist."""

    # Every catalogued permission is referenced by enforcement code.
    def test_every_catalogued_permission_is_enforced_somewhere(self):
        import pathlib

        import app

        app_dir = pathlib.Path(app.__file__).parent
        catalog_file = app_dir / "core" / "permissions.py"
        sources = "\n".join(
            path.read_text(encoding="utf-8")
            for path in app_dir.rglob("*.py")
            if path != catalog_file
        )

        constants = {
            value: name
            for name, value in vars(Permission).items()
            if not name.startswith("_") and isinstance(value, str)
        }
        unenforced = [
            code for code, name in constants.items() if f"Permission.{name}" not in sources
        ]
        assert unenforced == [], f"defined but never enforced: {unenforced}"

    # The catalog and the constants class describe the same set of codes.
    def test_catalog_matches_permission_constants(self):
        constants = {
            value for name, value in vars(Permission).items()
            if not name.startswith("_") and isinstance(value, str)
        }
        assert constants == set(PERMISSION_CATALOG)

    # Every code granted to a seeded role is a real catalogued permission.
    def test_role_grants_reference_real_permissions(self):
        for role_name, codes in DEFAULT_ROLE_PERMISSIONS.items():
            unknown = set(codes) - set(PERMISSION_CATALOG)
            assert unknown == set(), f"{role_name} granted unknown codes: {unknown}"

    # Neither manager nor user holds an administrative permission.
    def test_non_admin_roles_hold_no_administrative_permissions(self):
        administrative = {
            Permission.USER_CREATE,
            Permission.USER_DELETE,
            Permission.USER_SUSPEND,
            Permission.ROLE_ASSIGN,
            Permission.PATIENT_VIEW_ALL,
            Permission.PATIENT_MANAGE_ALL,
            Permission.PATIENT_DELETE,
        }
        for role_name in ("manager", "user"):
            granted = set(DEFAULT_ROLE_PERMISSIONS[role_name])
            assert granted & administrative == set()


class TestAdminCapabilities:
    """The administrator can perform every administrative action -- the
    counterpart to the denial tests below, so those prove a permission
    boundary rather than a broken endpoint."""

    # Admin lists users.
    def test_admin_can_list_users(self, client, admin_headers, plain_user):
        resp = client.get("/users", headers=admin_headers)
        assert resp.status_code == 200

    # Admin creates a user.
    def test_admin_can_create_user(self, client, admin_headers, user_role, location):
        payload = _create_payload(role_id=user_role.id, location_id=location.id)
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 201, resp.text
        assert resp.json()["role"]["id"] == user_role.id

    # Admin creates another admin.
    def test_admin_can_create_another_admin(self, client, admin_headers, admin_role, location):
        payload = _create_payload(
            role_id=admin_role.id, location_id=location.id, email="second-admin@example.com", username="second-admin"
        )
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 201, resp.text

    # Admin promotes a user to manager.
    def test_admin_can_assign_a_role(self, client, db_session, admin_headers, plain_user, manager_role):
        resp = client.patch(
            f"/users/{plain_user.id}", json={"role_id": manager_role.id}, headers=admin_headers
        )
        assert resp.status_code == 200, resp.text

        db_session.refresh(plain_user)
        assert plain_user.role_id == manager_role.id

    # Role changes are written to the audit log.
    def test_role_change_writes_an_audit_log_entry(
        self, client, db_session, admin_headers, admin, plain_user, user_role, manager_role
    ):
        client.patch(f"/users/{plain_user.id}", json={"role_id": manager_role.id}, headers=admin_headers)

        log = db_session.query(AuditLog).filter(AuditLog.event_type == "role_change").one()
        assert log.user_id == admin.id
        assert log.event_detail == {
            "user_id": str(plain_user.id),
            "from_role_id": user_role.id,
            "to_role_id": manager_role.id,
        }

    # Admin suspends an account.
    def test_admin_can_suspend_an_account(self, client, db_session, admin_headers, plain_user):
        resp = client.patch(f"/users/{plain_user.id}", json={"status": "suspended"}, headers=admin_headers)
        assert resp.status_code == 200, resp.text

        db_session.refresh(plain_user)
        assert plain_user.status == "suspended"

    # Status changes are written to the audit log.
    def test_status_change_writes_an_audit_log_entry(self, client, db_session, admin_headers, admin, plain_user):
        client.patch(f"/users/{plain_user.id}", json={"status": "suspended"}, headers=admin_headers)

        log = db_session.query(AuditLog).filter(AuditLog.event_type == "status_change").one()
        assert log.user_id == admin.id
        assert log.event_detail["to_status"] == "suspended"

    # Admin deactivates an account.
    def test_admin_can_deactivate_an_account(self, client, db_session, admin_headers, plain_user):
        resp = client.delete(f"/users/{plain_user.id}", headers=admin_headers)
        assert resp.status_code == 204

        db_session.refresh(plain_user)
        assert plain_user.status == "suspended"

    # Admin reads the reference-data lookups.
    @pytest.mark.parametrize("path", ["/roles", "/locations", "/teams"])
    def test_admin_can_read_lookups(self, client, admin_headers, path):
        assert client.get(path, headers=admin_headers).status_code == 200


class TestManagerPermittedActions:
    """What a manager is actually for: maintaining people's profile details."""

    # Manager lists users.
    def test_manager_can_list_users(self, client, manager_headers):
        assert client.get("/users", headers=manager_headers).status_code == 200

    # Manager edits a subordinate's profile fields.
    def test_manager_can_edit_profile_fields(self, client, db_session, manager_headers, plain_user):
        resp = client.patch(
            f"/users/{plain_user.id}",
            json={"first_name": "Renamed", "email": "renamed@example.com"},
            headers=manager_headers,
        )
        assert resp.status_code == 200, resp.text

        db_session.refresh(plain_user)
        assert plain_user.first_name == "Renamed"

    # Manager changes a subordinate's location and team.
    def test_manager_can_change_location_and_team(self, client, db_session, manager_headers, plain_user):
        other_location = Location(code="IN", name="India")
        team = Team(code="AR", name="Accounts Receivable")
        db_session.add_all([other_location, team])
        db_session.commit()

        resp = client.patch(
            f"/users/{plain_user.id}",
            json={"location_id": other_location.id, "team_id": team.id},
            headers=manager_headers,
        )
        assert resp.status_code == 200, resp.text

        db_session.refresh(plain_user)
        assert plain_user.location_id == other_location.id
        assert plain_user.team_id == team.id

    # Manager edits their own profile fields through the admin endpoint.
    def test_manager_can_edit_their_own_profile_fields(self, client, manager_headers, manager):
        resp = client.patch(f"/users/{manager.id}", json={"first_name": "Self"}, headers=manager_headers)
        assert resp.status_code == 200, resp.text


class TestManagerDeniedAdministrativeActions:
    """The privilege-escalation surface. Each of these was reachable before:
    UserUpdate accepted role_id and status, and PATCH /users/{id} gated on
    user.edit alone."""

    # Manager cannot promote another user to admin.
    def test_manager_cannot_promote_a_user_to_admin(
        self, client, db_session, manager_headers, plain_user, admin_role, user_role
    ):
        resp = client.patch(
            f"/users/{plain_user.id}", json={"role_id": admin_role.id}, headers=manager_headers
        )
        assert resp.status_code == 403

        db_session.refresh(plain_user)
        assert plain_user.role_id == user_role.id

    # Manager cannot promote themselves.
    def test_manager_cannot_promote_themselves(
        self, client, db_session, manager_headers, manager, admin_role, manager_role
    ):
        resp = client.patch(f"/users/{manager.id}", json={"role_id": admin_role.id}, headers=manager_headers)
        assert resp.status_code == 403

        db_session.refresh(manager)
        assert manager.role_id == manager_role.id

    # Manager cannot assign any role at all, not even a subordinate one.
    def test_manager_cannot_assign_even_a_subordinate_role(
        self, client, db_session, manager_headers, plain_user, manager_role, user_role
    ):
        resp = client.patch(
            f"/users/{plain_user.id}", json={"role_id": manager_role.id}, headers=manager_headers
        )
        assert resp.status_code == 403
        assert "role.assign" in resp.json()["detail"]

        db_session.refresh(plain_user)
        assert plain_user.role_id == user_role.id

    # Manager cannot suspend an account.
    def test_manager_cannot_suspend_an_account(self, client, db_session, manager_headers, plain_user):
        resp = client.patch(
            f"/users/{plain_user.id}", json={"status": "suspended"}, headers=manager_headers
        )
        assert resp.status_code == 403
        assert "user.suspend" in resp.json()["detail"]

        db_session.refresh(plain_user)
        assert plain_user.status == "active"

    # A privileged field smuggled in alongside allowed fields rejects the whole request.
    def test_privileged_field_alongside_allowed_fields_rejects_everything(
        self, client, db_session, manager_headers, plain_user, admin_role, user_role
    ):
        """The original bug's exact shape: a legitimate profile edit carrying
        role_id. Authorization runs before anything is written, so neither
        half of the request is applied."""
        resp = client.patch(
            f"/users/{plain_user.id}",
            json={"first_name": "Trojan", "role_id": admin_role.id},
            headers=manager_headers,
        )
        assert resp.status_code == 403

        db_session.refresh(plain_user)
        assert plain_user.role_id == user_role.id
        assert plain_user.first_name != "Trojan"

    # A status change smuggled in alongside allowed fields rejects the whole request.
    def test_status_smuggled_alongside_allowed_fields_rejects_everything(
        self, client, db_session, manager_headers, plain_user
    ):
        resp = client.patch(
            f"/users/{plain_user.id}",
            json={"last_name": "Trojan", "status": "suspended"},
            headers=manager_headers,
        )
        assert resp.status_code == 403

        db_session.refresh(plain_user)
        assert plain_user.status == "active"
        assert plain_user.last_name != "Trojan"

    # Manager cannot create users.
    def test_manager_cannot_create_users(self, client, manager_headers, user_role, location):
        payload = _create_payload(role_id=user_role.id, location_id=location.id)
        resp = client.post("/users", json=payload, headers=manager_headers)
        assert resp.status_code == 403

    # Manager cannot deactivate users.
    def test_manager_cannot_deactivate_users(self, client, db_session, manager_headers, plain_user):
        resp = client.delete(f"/users/{plain_user.id}", headers=manager_headers)
        assert resp.status_code == 403

        db_session.refresh(plain_user)
        assert plain_user.status == "active"

    # Manager cannot edit an administrator's account.
    def test_manager_cannot_edit_an_admin_account(self, client, db_session, manager_headers, admin):
        resp = client.patch(f"/users/{admin.id}", json={"first_name": "Downgraded"}, headers=manager_headers)
        assert resp.status_code == 403

        db_session.refresh(admin)
        assert admin.first_name != "Downgraded"

    # Manager cannot take over an admin account by changing its email.
    def test_manager_cannot_change_an_admin_email(self, client, db_session, manager_headers, admin):
        resp = client.patch(
            f"/users/{admin.id}", json={"email": "attacker@example.com"}, headers=manager_headers
        )
        assert resp.status_code == 403

        db_session.refresh(admin)
        assert admin.email == "admin@example.com"

    # Manager cannot delete patients.
    def test_manager_cannot_delete_patients(self, client, manager_headers):
        resp = client.delete(f"/patients/{uuid.uuid4()}", headers=manager_headers)
        assert resp.status_code == 403


class TestPeersCannotAdministerEachOther:
    """Authority runs strictly downward. Two managers are not each other's
    supervisor, so a lateral edit is refused no matter which permissions the
    caller holds -- rank is checked independently of the permission gate."""

    # A manager cannot edit a peer manager's profile.
    def test_manager_cannot_edit_a_peer_manager(self, client, db_session, manager_headers, other_manager):
        resp = client.patch(
            f"/users/{other_manager.id}", json={"first_name": "Peer"}, headers=manager_headers
        )
        assert resp.status_code == 403
        assert "below your own" in resp.json()["detail"]

        db_session.refresh(other_manager)
        assert other_manager.first_name != "Peer"

    # An admin cannot edit another admin.
    def test_admin_cannot_edit_another_admin(self, client, db_session, admin_headers, make_user, admin_role, location):
        """The notable consequence of the strict rule: the top role has no
        peers it can administer either, so admin accounts can only be managed
        by their owner (or out of band)."""
        other_admin = make_user(admin_role, location, email="other-admin@example.com")

        resp = client.patch(
            f"/users/{other_admin.id}", json={"first_name": "Peer"}, headers=admin_headers
        )
        assert resp.status_code == 403

        db_session.refresh(other_admin)
        assert other_admin.first_name != "Peer"

    # An admin cannot suspend another admin.
    def test_admin_cannot_suspend_another_admin(self, client, db_session, admin_headers, make_user, admin_role, location):
        other_admin = make_user(admin_role, location, email="other-admin@example.com")

        resp = client.patch(
            f"/users/{other_admin.id}", json={"status": "suspended"}, headers=admin_headers
        )
        assert resp.status_code == 403

        db_session.refresh(other_admin)
        assert other_admin.status == "active"

    # An admin cannot deactivate another admin.
    def test_admin_cannot_deactivate_another_admin(self, client, db_session, admin_headers, make_user, admin_role, location):
        other_admin = make_user(admin_role, location, email="other-admin@example.com")

        resp = client.delete(f"/users/{other_admin.id}", headers=admin_headers)
        assert resp.status_code == 403

        db_session.refresh(other_admin)
        assert other_admin.status == "active"

    # A manager cannot deactivate a peer even holding user.delete.
    def test_peer_deactivation_is_refused_even_with_user_delete(
        self, client, db_session, make_role, make_user, admin_role, location, auth_headers
    ):
        role = make_role("deleter", [Permission.USER_VIEW, Permission.USER_DELETE], parent=admin_role)
        actor = make_user(role, location, email="deleter@example.com")
        peer = make_user(role, location, email="deleter-peer@example.com")

        resp = client.delete(f"/users/{peer.id}", headers=auth_headers(actor))
        assert resp.status_code == 403

        db_session.refresh(peer)
        assert peer.status == "active"

    # Acting on your own record is still allowed -- self is exempt from rank.
    def test_self_edit_is_still_allowed(self, client, db_session, manager_headers, manager):
        resp = client.patch(f"/users/{manager.id}", json={"first_name": "Self"}, headers=manager_headers)
        assert resp.status_code == 200, resp.text

        db_session.refresh(manager)
        assert manager.first_name == "Self"

    # Authority still runs downward: a manager can edit a standard user.
    def test_downward_edits_still_work(self, client, db_session, manager_headers, plain_user):
        resp = client.patch(
            f"/users/{plain_user.id}", json={"first_name": "Downward"}, headers=manager_headers
        )
        assert resp.status_code == 200, resp.text

        db_session.refresh(plain_user)
        assert plain_user.first_name == "Downward"


class TestRoleAssignSeniority:
    """role.assign is necessary but not sufficient: it never lets a holder
    hand out authority above their own."""

    @pytest.fixture
    def senior_manager_headers(self, make_role, make_user, admin_role, location, auth_headers):
        """A manager-rank role that HAS been granted role.assign -- isolates
        the seniority rule from the permission check."""
        role = make_role(
            "senior-manager",
            [Permission.USER_VIEW, Permission.USER_EDIT, Permission.ROLE_ASSIGN, Permission.USER_CREATE],
            parent=admin_role,
        )
        return auth_headers(make_user(role, location, email="senior-manager@example.com"))

    # Holding role.assign still cannot promote anyone to a more senior role.
    def test_role_assign_cannot_promote_above_own_rank(
        self, client, db_session, senior_manager_headers, plain_user, admin_role, user_role
    ):
        resp = client.patch(
            f"/users/{plain_user.id}", json={"role_id": admin_role.id}, headers=senior_manager_headers
        )
        assert resp.status_code == 403
        assert "more senior" in resp.json()["detail"]

        db_session.refresh(plain_user)
        assert plain_user.role_id == user_role.id

    # Holding role.assign can promote within/below own rank.
    def test_role_assign_can_promote_within_own_rank(
        self, client, db_session, senior_manager_headers, plain_user, manager_role
    ):
        resp = client.patch(
            f"/users/{plain_user.id}", json={"role_id": manager_role.id}, headers=senior_manager_headers
        )
        assert resp.status_code == 200, resp.text

        db_session.refresh(plain_user)
        assert plain_user.role_id == manager_role.id

    # Creating an account with a more senior role is refused.
    def test_cannot_create_an_account_more_senior_than_own_role(
        self, client, db_session, senior_manager_headers, admin_role, location
    ):
        payload = _create_payload(
            role_id=admin_role.id, location_id=location.id, email="backdoor@example.com", username="backdoor"
        )
        resp = client.post("/users", json=payload, headers=senior_manager_headers)
        assert resp.status_code == 403

        assert db_session.query(User).filter(User.email == "backdoor@example.com").one_or_none() is None

    # user.create alone is not enough to hand out a role.
    def test_user_create_without_role_assign_is_refused(
        self, client, db_session, make_role, make_user, admin_role, user_role, location, auth_headers
    ):
        role = make_role("recruiter", [Permission.USER_CREATE], parent=admin_role)
        headers = auth_headers(make_user(role, location, email="recruiter@example.com"))

        payload = _create_payload(role_id=user_role.id, location_id=location.id)
        resp = client.post("/users", json=payload, headers=headers)
        assert resp.status_code == 403
        assert "role.assign" in resp.json()["detail"]

        assert db_session.query(User).filter(User.email == payload["email"]).one_or_none() is None


class TestPrivilegedPermissionsAreIndependent:
    """Each privileged permission unlocks exactly its own field -- holding one
    grants nothing else, in either direction."""

    @pytest.fixture
    def suspender_headers(self, make_role, make_user, admin_role, location, auth_headers):
        role = make_role("suspender", [Permission.USER_VIEW, Permission.USER_SUSPEND], parent=admin_role)
        return auth_headers(make_user(role, location, email="suspender@example.com"))

    @pytest.fixture
    def assigner_headers(self, make_role, make_user, admin_role, location, auth_headers):
        role = make_role("assigner", [Permission.USER_VIEW, Permission.ROLE_ASSIGN], parent=admin_role)
        return auth_headers(make_user(role, location, email="assigner@example.com"))

    # user.suspend changes status without needing user.edit.
    def test_user_suspend_alone_can_change_status(self, client, db_session, suspender_headers, plain_user):
        resp = client.patch(f"/users/{plain_user.id}", json={"status": "locked"}, headers=suspender_headers)
        assert resp.status_code == 200, resp.text

        db_session.refresh(plain_user)
        assert plain_user.status == "locked"

    # user.suspend does not confer profile editing.
    def test_user_suspend_alone_cannot_edit_profile_fields(
        self, client, db_session, suspender_headers, plain_user
    ):
        resp = client.patch(
            f"/users/{plain_user.id}", json={"first_name": "Nope"}, headers=suspender_headers
        )
        assert resp.status_code == 403
        assert "user.edit" in resp.json()["detail"]

        db_session.refresh(plain_user)
        assert plain_user.first_name != "Nope"

    # role.assign does not confer profile editing.
    def test_role_assign_alone_cannot_edit_profile_fields(
        self, client, db_session, assigner_headers, plain_user
    ):
        resp = client.patch(
            f"/users/{plain_user.id}", json={"username": "hijacked"}, headers=assigner_headers
        )
        assert resp.status_code == 403

        db_session.refresh(plain_user)
        assert plain_user.username != "hijacked"

    # role.assign does not confer suspension.
    def test_role_assign_alone_cannot_suspend(self, client, db_session, assigner_headers, plain_user):
        resp = client.patch(
            f"/users/{plain_user.id}", json={"status": "suspended"}, headers=assigner_headers
        )
        assert resp.status_code == 403

        db_session.refresh(plain_user)
        assert plain_user.status == "active"


class TestSelfAdministrationLimits:
    """Rules that apply even to an administrator acting on their own account."""

    # An admin cannot change their own role.
    def test_admin_cannot_change_their_own_role(self, client, db_session, admin_headers, admin, user_role, admin_role):
        resp = client.patch(f"/users/{admin.id}", json={"role_id": user_role.id}, headers=admin_headers)
        assert resp.status_code == 403

        db_session.refresh(admin)
        assert admin.role_id == admin_role.id

    # An admin cannot change their own status.
    def test_admin_cannot_change_their_own_status(self, client, db_session, admin_headers, admin):
        resp = client.patch(f"/users/{admin.id}", json={"status": "suspended"}, headers=admin_headers)
        assert resp.status_code == 403

        db_session.refresh(admin)
        assert admin.status == "active"

    # An admin cannot deactivate their own account.
    def test_admin_cannot_deactivate_their_own_account(self, client, db_session, admin_headers, admin):
        resp = client.delete(f"/users/{admin.id}", headers=admin_headers)
        assert resp.status_code == 403

        db_session.refresh(admin)
        assert admin.status == "active"


class TestStandardUser:
    """The `user` role holds no permissions: self-service works, everything
    else is refused by the backend regardless of what the UI would show."""

    @pytest.mark.parametrize(
        ("method", "path_template"),
        [
            ("get", "/users"),
            ("get", "/users/{target}"),
            ("post", "/users"),
            ("patch", "/users/{target}"),
            ("delete", "/users/{target}"),
            ("get", "/roles"),
            ("get", "/locations"),
            ("get", "/teams"),
            ("get", "/patients"),
            ("get", "/patients/analytics-dataset"),
            ("patch", "/patients/{target}"),
            ("delete", "/patients/{target}"),
        ],
    )
    # Every protected endpoint refuses a permissionless account.
    def test_permissionless_account_is_refused_everywhere(
        self, client, user_headers, other_manager, method, path_template
    ):
        path = path_template.format(target=other_manager.id)
        resp = getattr(client, method)(path, headers=user_headers, **({"json": {}} if method in {"post", "patch"} else {}))
        assert resp.status_code == 403, f"{method.upper()} {path} -> {resp.status_code}"

    # A standard user reads their own profile.
    def test_standard_user_can_read_own_profile(self, client, user_headers, plain_user):
        resp = client.get("/auth/me", headers=user_headers)
        assert resp.status_code == 200
        assert resp.json()["email"] == plain_user.email

    # A standard user edits their own name.
    def test_standard_user_can_edit_own_name(self, client, db_session, user_headers, plain_user):
        resp = client.patch(
            "/auth/me", json={"first_name": "Self", "last_name": "Service"}, headers=user_headers
        )
        assert resp.status_code == 200

        db_session.refresh(plain_user)
        assert plain_user.first_name == "Self"

    # Privileged fields sent to the self-service endpoint are ignored.
    def test_self_service_endpoint_ignores_privileged_fields(
        self, client, db_session, user_headers, plain_user, admin_role, user_role
    ):
        """SelfProfileUpdate has no role_id/status fields, so Pydantic drops
        them -- this pins that behaviour rather than trusting it."""
        resp = client.patch(
            "/auth/me",
            json={
                "first_name": "Self",
                "last_name": "Service",
                "role_id": admin_role.id,
                "status": "active",
                "email": "escalated@example.com",
            },
            headers=user_headers,
        )
        assert resp.status_code == 200

        db_session.refresh(plain_user)
        assert plain_user.role_id == user_role.id
        assert plain_user.email == "plain@example.com"

    # A standard user cannot edit another user through the self-service endpoint's sibling.
    def test_standard_user_cannot_edit_another_user(self, client, user_headers, other_manager):
        resp = client.patch(
            f"/users/{other_manager.id}", json={"first_name": "Nope"}, headers=user_headers
        )
        assert resp.status_code == 403


class TestUnauthenticated:
    """The 401 gate runs before any permission check on every protected route."""

    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("get", "/users"),
            ("post", "/users"),
            ("patch", "/users/00000000-0000-0000-0000-000000000000"),
            ("delete", "/users/00000000-0000-0000-0000-000000000000"),
            ("get", "/roles"),
            ("get", "/locations"),
            ("get", "/teams"),
            ("get", "/patients"),
            ("get", "/auth/me"),
            ("patch", "/auth/me"),
        ],
    )
    # No credentials returns 401.
    def test_missing_credentials_returns_401(self, client, method, path):
        resp = getattr(client, method)(path, **({"json": {}} if method in {"post", "patch"} else {}))
        assert resp.status_code == 401

    # A tampered token returns 401, not a permission error.
    def test_tampered_token_returns_401(self, client, admin_headers):
        token = admin_headers["Authorization"].removeprefix("Bearer ")
        tampered = token[:-4] + ("A" if token[-4] != "A" else "B") + token[-3:]
        resp = client.patch(
            f"/users/{uuid.uuid4()}", json={"first_name": "X"}, headers={"Authorization": f"Bearer {tampered}"}
        )
        assert resp.status_code == 401


class TestInactiveRoleGrantsNothing:
    # Deactivating a role revokes its permissions from everyone holding it.
    def test_inactive_role_grants_no_permissions(
        self, client, db_session, make_role, make_user, location, auth_headers
    ):
        role = make_role("retired-admin", DEFAULT_ROLE_PERMISSIONS["admin"], is_active=False)
        headers = auth_headers(make_user(role, location, email="retired@example.com"))

        assert client.get("/users", headers=headers).status_code == 403


class TestClientSuppliedIdsAreValidated:
    """Ids from the request body name real, in-service rows -- otherwise the
    value reaches a NOT NULL foreign key and surfaces as a 500."""

    # An unknown role id is rejected as 422, not a 500.
    def test_unknown_role_id_returns_422(self, client, admin_headers, plain_user):
        resp = client.patch(f"/users/{plain_user.id}", json={"role_id": 999999}, headers=admin_headers)
        assert resp.status_code == 422

    # A deactivated role cannot be assigned.
    def test_inactive_role_cannot_be_assigned(self, client, admin_headers, plain_user, make_role):
        retired = make_role("retired", [], is_active=False)
        resp = client.patch(f"/users/{plain_user.id}", json={"role_id": retired.id}, headers=admin_headers)
        assert resp.status_code == 422

    # An unknown location id is rejected as 422.
    def test_unknown_location_id_returns_422(self, client, admin_headers, plain_user):
        resp = client.patch(f"/users/{plain_user.id}", json={"location_id": 999999}, headers=admin_headers)
        assert resp.status_code == 422

    # An unknown team id is rejected as 422.
    def test_unknown_team_id_returns_422(self, client, admin_headers, plain_user):
        resp = client.patch(f"/users/{plain_user.id}", json={"team_id": 999999}, headers=admin_headers)
        assert resp.status_code == 422

    # An unknown role id on create is rejected as 422.
    def test_unknown_role_id_on_create_returns_422(self, client, admin_headers, location):
        payload = _create_payload(role_id=999999, location_id=location.id)
        resp = client.post("/users", json=payload, headers=admin_headers)
        assert resp.status_code == 422


class TestSuspensionEndsSessions:
    """A suspended account's refresh cookie must stop working -- otherwise the
    account keeps minting access tokens after being cut off."""

    def _issue_refresh_token(self, db_session, user) -> str:
        raw = generate_refresh_token()
        db_session.add(
            RefreshToken(
                user_id=user.id,
                token_hash=hash_refresh_token(raw),
                expires_at=datetime.now(timezone.utc) + timedelta(days=7),
            )
        )
        db_session.commit()
        return raw

    # Suspending via PATCH revokes the target's refresh tokens.
    def test_patch_suspension_revokes_refresh_tokens(self, client, db_session, admin_headers, plain_user):
        raw = self._issue_refresh_token(db_session, plain_user)

        client.patch(f"/users/{plain_user.id}", json={"status": "suspended"}, headers=admin_headers)

        client.cookies.set("refresh_token", raw)
        assert client.post("/auth/refresh").status_code == 401

    # Deactivating via DELETE revokes the target's refresh tokens.
    def test_delete_revokes_refresh_tokens(self, client, db_session, admin_headers, plain_user):
        raw = self._issue_refresh_token(db_session, plain_user)

        client.delete(f"/users/{plain_user.id}", headers=admin_headers)

        client.cookies.set("refresh_token", raw)
        assert client.post("/auth/refresh").status_code == 401

    # A refresh token belonging to a non-active account is refused even if never explicitly revoked.
    def test_refresh_is_refused_for_a_non_active_account(
        self, client, db_session, make_user, user_role, location
    ):
        suspended = make_user(user_role, location, email="suspended@example.com", status="suspended")
        raw = self._issue_refresh_token(db_session, suspended)

        client.cookies.set("refresh_token", raw)
        assert client.post("/auth/refresh").status_code == 401


class TestPatientScopeSeparation:
    """patient.view_all lifts the ownership filter for reads only. Being able
    to see every uploader's records is not authority to change them."""

    @pytest.fixture
    def uploader(self, make_role, make_user, admin_role, location):
        role = make_role(
            "uploader",
            [Permission.PATIENT_VIEW, Permission.PATIENT_CREATE, Permission.PATIENT_EDIT],
            parent=admin_role,
        )
        return make_user(role, location, email="uploader@example.com")

    @pytest.fixture
    def patient(self, db_session, uploader):
        from app.core.encryption import encrypt_field
        from app.models import Patient

        row = Patient(
            patient_code="P-SCOPE-1",
            first_name_enc=encrypt_field("Ada"),
            last_name_enc=encrypt_field("Lovelace"),
            date_of_birth_enc=encrypt_field("1990-01-15"),
            gender_enc=encrypt_field("Female"),
            uploaded_by=uploader.id,
        )
        db_session.add(row)
        db_session.commit()
        db_session.refresh(row)
        return row

    @pytest.fixture
    def viewer_all_headers(self, make_role, make_user, admin_role, location, auth_headers):
        role = make_role(
            "patient-auditor",
            [Permission.PATIENT_VIEW, Permission.PATIENT_VIEW_ALL, Permission.PATIENT_EDIT, Permission.PATIENT_DELETE],
            parent=admin_role,
        )
        return auth_headers(make_user(role, location, email="patient-auditor@example.com"))

    @pytest.fixture
    def manage_all_headers(self, make_role, make_user, admin_role, location, auth_headers):
        role = make_role(
            "patient-admin",
            [
                Permission.PATIENT_VIEW,
                Permission.PATIENT_VIEW_ALL,
                Permission.PATIENT_MANAGE_ALL,
                Permission.PATIENT_EDIT,
                Permission.PATIENT_DELETE,
            ],
            parent=admin_role,
        )
        return auth_headers(make_user(role, location, email="patient-admin@example.com"))

    # view_all reads another uploader's record.
    def test_view_all_can_read_another_uploaders_record(self, client, viewer_all_headers, patient):
        resp = client.get(f"/patients/{patient.id}", headers=viewer_all_headers)
        assert resp.status_code == 200

    # view_all cannot edit another uploader's record.
    def test_view_all_cannot_edit_another_uploaders_record(
        self, client, db_session, viewer_all_headers, patient
    ):
        from app.core.encryption import decrypt_field

        resp = client.patch(
            f"/patients/{patient.id}", json={"first_name": "Rewritten"}, headers=viewer_all_headers
        )
        assert resp.status_code == 404

        db_session.refresh(patient)
        assert decrypt_field(patient.first_name_enc) == "Ada"

    # view_all cannot delete another uploader's record.
    def test_view_all_cannot_delete_another_uploaders_record(
        self, client, db_session, viewer_all_headers, patient
    ):
        from app.models import Patient

        resp = client.delete(f"/patients/{patient.id}", headers=viewer_all_headers)
        assert resp.status_code == 404
        assert db_session.query(Patient).filter(Patient.id == patient.id).one_or_none() is not None

    # manage_all can edit another uploader's record.
    def test_manage_all_can_edit_another_uploaders_record(self, client, manage_all_headers, patient):
        resp = client.patch(
            f"/patients/{patient.id}", json={"first_name": "Rewritten"}, headers=manage_all_headers
        )
        assert resp.status_code == 200, resp.text

    # manage_all can delete another uploader's record.
    def test_manage_all_can_delete_another_uploaders_record(
        self, client, db_session, manage_all_headers, patient
    ):
        from app.models import Patient

        resp = client.delete(f"/patients/{patient.id}", headers=manage_all_headers)
        assert resp.status_code == 204
        assert db_session.query(Patient).filter(Patient.id == patient.id).one_or_none() is None

    # Uploading requires patient.create, not merely patient.edit.
    def test_upload_requires_patient_create(
        self, client, make_role, make_user, admin_role, location, auth_headers
    ):
        role = make_role(
            "editor-only", [Permission.PATIENT_VIEW, Permission.PATIENT_EDIT], parent=admin_role
        )
        headers = auth_headers(make_user(role, location, email="editor-only@example.com"))

        resp = client.post(
            "/patients/upload",
            headers=headers,
            files={"file": ("patients.xlsx", b"not-a-real-workbook", "application/vnd.ms-excel")},
        )
        assert resp.status_code == 403
        assert "patient.create" in resp.json()["detail"]
