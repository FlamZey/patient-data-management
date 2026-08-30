"""Unit tests for app.core.authz's pure helpers.

test_authorization.py already drives every one of these through real HTTP,
which is the right way to prove they're wired into the routes. This file
exists for the parts that HTTP structurally cannot reach:

  * role_rank(None) -- users.role_id is NOT NULL, so a request can never
    present a user without a role.
  * the cycle guard in role_rank -- no endpoint can write a loop into
    roles.parent_role_id.
  * the depth cap -- reaching it would take a 33-deep role chain.

Those three branches are the ones protecting the function that decides who may
administer whom from spinning forever, and nothing else can exercise them.
"""

import pytest
from fastapi import HTTPException

from app.core import authz
from app.core.permissions import Permission
from app.models import Role, User


@pytest.fixture
def chain(db_session):
    """A three-deep hierarchy mirroring the seeded one: root <- middle <- leaf."""

    def _make(name, parent=None):
        role = Role(name=name, display_name=name.title(), parent_role_id=parent.id if parent else None)
        db_session.add(role)
        db_session.flush()
        return role

    root = _make("chain-root")
    middle = _make("chain-middle", root)
    leaf = _make("chain-leaf", middle)
    db_session.commit()
    return root, middle, leaf


class TestRoleRank:
    # A root role ranks 0, and each link down adds one.
    def test_rank_counts_links_to_the_root(self, chain):
        root, middle, leaf = chain
        assert authz.role_rank(root) == 0
        assert authz.role_rank(middle) == 1
        assert authz.role_rank(leaf) == 2

    # A missing role ranks as the least authority available.
    def test_missing_role_ranks_lowest(self):
        """Unreachable over HTTP -- users.role_id is NOT NULL -- but the
        fallback is what stops a half-configured account from out-ranking a
        real one, so it can't be left to inference."""
        assert authz.role_rank(None) == authz._MAX_ROLE_DEPTH

    # A cycle in parent_role_id terminates instead of looping forever.
    def test_cycle_terminates(self, db_session):
        """roles.parent_role_id is a self-FK with nothing in the schema
        preventing a loop, and no endpoint can create one -- so this is the
        only way the guard is ever exercised. A regression here hangs the
        request thread rather than failing loudly."""
        first = Role(name="cycle-a", display_name="Cycle A")
        second = Role(name="cycle-b", display_name="Cycle B")
        db_session.add_all([first, second])
        db_session.flush()
        first.parent_role_id = second.id
        second.parent_role_id = first.id
        db_session.commit()

        rank = authz.role_rank(first)
        assert rank <= authz._MAX_ROLE_DEPTH

    # A chain longer than the cap stops at the cap.
    def test_depth_cap_bounds_a_very_deep_chain(self, db_session):
        parent = None
        for index in range(authz._MAX_ROLE_DEPTH + 3):
            role = Role(
                name=f"deep-{index}",
                display_name=f"Deep {index}",
                parent_role_id=parent.id if parent else None,
            )
            db_session.add(role)
            db_session.flush()
            parent = role
        db_session.commit()

        assert authz.role_rank(parent) == authz._MAX_ROLE_DEPTH


class TestGrantedPermissions:
    # A user with no role at all holds nothing.
    def test_user_without_a_role_holds_nothing(self):
        assert authz.granted_permissions(User()) == frozenset()

    # A deactivated role grants nothing to anyone still assigned to it.
    def test_deactivated_role_grants_nothing(self, location, make_role, make_user):
        role = make_role("retired", [Permission.USER_VIEW], is_active=False)
        user = make_user(role, location, email="retired-holder@example.com")

        assert authz.granted_permissions(user) == frozenset()
        assert authz.has_permission(user, Permission.USER_VIEW) is False

    # An active role grants exactly its codes.
    def test_active_role_grants_its_codes(self, location, make_role, make_user):
        role = make_role("granted", [Permission.USER_VIEW, Permission.PATIENT_VIEW])
        user = make_user(role, location, email="granted@example.com")

        assert authz.granted_permissions(user) == {Permission.USER_VIEW, Permission.PATIENT_VIEW}
        assert authz.has_any_permission(user, Permission.USER_DELETE, Permission.PATIENT_VIEW) is True
        assert authz.has_any_permission(user, Permission.USER_DELETE) is False


class TestAdministerRules:
    @pytest.fixture
    def actors(self, db_session, location, make_role, make_user):
        senior = make_role("rule-senior")
        junior = make_role("rule-junior", parent=senior)
        return {
            "actor": make_user(junior, location, email="rule-actor@example.com"),
            "peer": make_user(junior, location, email="rule-peer@example.com"),
            "senior": make_user(senior, location, email="rule-senior@example.com"),
            "junior_role": junior,
            "senior_role": senior,
        }

    # Acting on yourself skips the rank test entirely.
    def test_self_is_exempt(self, actors):
        authz.assert_can_administer(actors["actor"], actors["actor"])

    # A peer is refused -- authority runs strictly downward.
    def test_peer_is_refused(self, actors):
        with pytest.raises(HTTPException) as exc:
            authz.assert_can_administer(actors["actor"], actors["peer"])
        assert exc.value.status_code == 403

    # Someone more senior is refused.
    def test_senior_is_refused(self, actors):
        with pytest.raises(HTTPException) as exc:
            authz.assert_can_administer(actors["actor"], actors["senior"])
        assert exc.value.status_code == 403

    # Someone below is allowed.
    def test_subordinate_is_allowed(self, actors):
        authz.assert_can_administer(actors["senior"], actors["actor"])

    # A role at or below the actor's own may be assigned.
    def test_can_assign_own_rank_and_below(self, actors):
        authz.assert_can_assign_role(actors["actor"], actors["junior_role"])

    # A more senior role may not.
    def test_cannot_assign_a_more_senior_role(self, actors):
        with pytest.raises(HTTPException) as exc:
            authz.assert_can_assign_role(actors["actor"], actors["senior_role"])
        assert exc.value.status_code == 403
        assert "more senior" in exc.value.detail

    # Deactivating yourself is refused before any rank test runs.
    def test_cannot_deactivate_self(self, actors):
        with pytest.raises(HTTPException) as exc:
            authz.assert_can_deactivate(actors["actor"], actors["actor"])
        assert "your own account" in exc.value.detail


class TestPatientScope:
    """Read-all and write-all are separate permissions: seeing every uploader's
    records is not authority to change them."""

    def _user(self, location, make_role, make_user, codes, email):
        return make_user(make_role(f"scope-{email.split('@')[0]}", codes), location, email=email)

    # With neither permission, both reads and writes are scoped to your own rows.
    def test_owner_only_by_default(self, location, make_role, make_user):
        user = self._user(location, make_role, make_user, [Permission.PATIENT_VIEW], "own@example.com")
        assert authz.patient_owner_scope(user, write=False) == user.id
        assert authz.patient_owner_scope(user, write=True) == user.id

    # view_all lifts the filter for reads only.
    def test_view_all_lifts_reads_but_not_writes(self, location, make_role, make_user):
        user = self._user(
            location, make_role, make_user,
            [Permission.PATIENT_VIEW, Permission.PATIENT_VIEW_ALL], "viewall@example.com",
        )
        assert authz.patient_owner_scope(user, write=False) is None
        assert authz.patient_owner_scope(user, write=True) == user.id

    # manage_all lifts both, since writing implies reading.
    def test_manage_all_lifts_both(self, location, make_role, make_user):
        user = self._user(
            location, make_role, make_user,
            [Permission.PATIENT_VIEW, Permission.PATIENT_MANAGE_ALL], "manageall@example.com",
        )
        assert authz.patient_owner_scope(user, write=False) is None
        assert authz.patient_owner_scope(user, write=True) is None


class TestPrivilegedFieldDeclaration:
    """The field -> permission map is the single place routers learn which
    body fields need more than user.edit, so its shape is worth pinning."""

    # role_id and status are the privileged fields, mapped to their permissions.
    def test_privileged_fields_map_to_their_permissions(self):
        assert authz.PRIVILEGED_USER_FIELDS == {
            "role_id": Permission.ROLE_ASSIGN,
            "status": Permission.USER_SUSPEND,
        }

    # The endpoint gate admits user.edit plus every privileged permission.
    def test_update_permissions_cover_edit_and_every_privileged_field(self):
        assert set(authz.USER_UPDATE_PERMISSIONS) == {
            Permission.USER_EDIT,
            *authz.PRIVILEGED_USER_FIELDS.values(),
        }

    # location_id and team_id are deliberately NOT privileged.
    def test_org_fields_are_not_privileged(self):
        """Nothing in this application scopes access by location or team, so
        gating them would be a permission guarding nothing. If either ever
        gates data access, it belongs in PRIVILEGED_USER_FIELDS."""
        assert "location_id" not in authz.PRIVILEGED_USER_FIELDS
        assert "team_id" not in authz.PRIVILEGED_USER_FIELDS
