"""Tests for the reference-data sync (app.bootstrap).

The point of these is the ownership split the module documents: the permission
*catalog* is owned by the code, while which roles *hold* which permissions is
owned by the database. Both halves are easy to break by "tidying" the sync into
a full reconcile, so each direction is pinned here.
"""

import pytest

from app.bootstrap import ROLE_PERMISSIONS, sync_reference_data
from app.core.permissions import DEFAULT_ROLE_PERMISSIONS, Permission as PermissionCode
from app.models import Location, Permission, Role, RolePermission, Team


def granted_codes(db_session, role_name: str) -> set[str]:
    """The permission codes currently granted to a role, read back from the
    join table rather than from any in-memory relationship."""
    role = db_session.query(Role).filter(Role.name == role_name).one()
    rows = db_session.query(RolePermission).filter(RolePermission.role_id == role.id).all()
    codes = set()
    for row in rows:
        codes.add(db_session.query(Permission).filter(Permission.id == row.permission_id).one().code)
    return codes


def permission_id(db_session, code: str) -> int:
    return db_session.query(Permission).filter(Permission.code == code).one().id


class TestFirstRun:
    # A fresh database gets the roles, the catalog, and the default grants.
    def test_fresh_database_gets_defaults(self, db_session):
        sync_reference_data(db_session)

        assert {role.name for role in db_session.query(Role).all()} == set(ROLE_PERMISSIONS)
        assert {p.code for p in db_session.query(Permission).all()} == set(DEFAULT_ROLE_PERMISSIONS["admin"])
        for role_name, codes in ROLE_PERMISSIONS.items():
            assert granted_codes(db_session, role_name) == set(codes), role_name

    # The role hierarchy is wired up, since authorization reads it as seniority.
    def test_role_hierarchy_is_established(self, db_session):
        sync_reference_data(db_session)

        roles = {role.name: role for role in db_session.query(Role).all()}
        assert roles["admin"].parent_role_id is None
        assert roles["manager"].parent_role_id == roles["admin"].id
        assert roles["user"].parent_role_id == roles["manager"].id

    # Re-running changes nothing.
    def test_second_run_is_idempotent(self, db_session):
        sync_reference_data(db_session)
        before = {name: granted_codes(db_session, name) for name in ROLE_PERMISSIONS}

        sync_reference_data(db_session)

        assert {name: granted_codes(db_session, name) for name in ROLE_PERMISSIONS} == before
        assert db_session.query(Role).count() == len(ROLE_PERMISSIONS)
        assert db_session.query(Permission).count() == len(DEFAULT_ROLE_PERMISSIONS["admin"])


class TestGrantsAreDatabaseOwned:
    """Grants added or revoked at runtime must survive later syncs -- this is
    what makes "granting a role a permission is a database write" true, rather
    than a change silently reverted on the next backend restart."""

    # A grant added directly to the database survives a re-run.
    def test_added_grant_survives(self, db_session):
        sync_reference_data(db_session)
        manager = db_session.query(Role).filter(Role.name == "manager").one()
        db_session.add(
            RolePermission(
                role_id=manager.id, permission_id=permission_id(db_session, PermissionCode.USER_SUSPEND)
            )
        )
        db_session.commit()

        sync_reference_data(db_session)

        assert PermissionCode.USER_SUSPEND in granted_codes(db_session, "manager")

    # A grant revoked directly in the database is not re-added.
    def test_revoked_grant_is_not_restored(self, db_session):
        sync_reference_data(db_session)
        manager = db_session.query(Role).filter(Role.name == "manager").one()
        db_session.query(RolePermission).filter(
            RolePermission.role_id == manager.id,
            RolePermission.permission_id == permission_id(db_session, PermissionCode.PATIENT_EDIT),
        ).delete()
        db_session.commit()

        sync_reference_data(db_session)

        assert PermissionCode.PATIENT_EDIT not in granted_codes(db_session, "manager")

    # A role stripped of every grant stays stripped.
    def test_fully_revoked_role_stays_empty(self, db_session):
        sync_reference_data(db_session)
        manager = db_session.query(Role).filter(Role.name == "manager").one()
        db_session.query(RolePermission).filter(RolePermission.role_id == manager.id).delete()
        db_session.commit()

        sync_reference_data(db_session)

        assert granted_codes(db_session, "manager") == set()

    # A newly catalogued permission is NOT auto-granted to existing roles.
    def test_new_catalog_permission_is_not_auto_granted(self, db_session, monkeypatch):
        """The documented cost of database-owned grants: adding a permission to
        the catalog creates the row but grants it to nobody, because touching an
        existing role's grants would mean overwriting operator decisions."""
        sync_reference_data(db_session)

        monkeypatch.setitem(ROLE_PERMISSIONS, "manager", [*ROLE_PERMISSIONS["manager"], PermissionCode.USER_DELETE])
        sync_reference_data(db_session)

        assert PermissionCode.USER_DELETE not in granted_codes(db_session, "manager")


class TestResetGrants:
    """The supported way back to the defaults, for when database-owned drift
    isn't wanted."""

    # Reset discards an added grant.
    def test_reset_removes_an_added_grant(self, db_session):
        sync_reference_data(db_session)
        manager = db_session.query(Role).filter(Role.name == "manager").one()
        db_session.add(
            RolePermission(
                role_id=manager.id, permission_id=permission_id(db_session, PermissionCode.ROLE_ASSIGN)
            )
        )
        db_session.commit()

        sync_reference_data(db_session, reset_grants=True)

        assert granted_codes(db_session, "manager") == set(ROLE_PERMISSIONS["manager"])

    # Reset restores a revoked grant.
    def test_reset_restores_a_revoked_grant(self, db_session):
        sync_reference_data(db_session)
        manager = db_session.query(Role).filter(Role.name == "manager").one()
        db_session.query(RolePermission).filter(RolePermission.role_id == manager.id).delete()
        db_session.commit()

        sync_reference_data(db_session, reset_grants=True)

        assert granted_codes(db_session, "manager") == set(ROLE_PERMISSIONS["manager"])


class TestCatalogIsCodeOwned:
    """The other half of the split: which permissions exist is still decided by
    the code, so a retired code really disappears."""

    # A permission absent from the catalog is deleted on the next run.
    def test_permission_outside_the_catalog_is_deleted(self, db_session):
        sync_reference_data(db_session)
        db_session.add(Permission(code="legacy.thing", resource="legacy", action="thing"))
        db_session.commit()

        sync_reference_data(db_session)

        assert db_session.query(Permission).filter(Permission.code == "legacy.thing").one_or_none() is None

    # Deleting a retired permission also removes any grant of it.
    def test_deleting_a_permission_cascades_to_its_grants(self, db_session):
        sync_reference_data(db_session)
        legacy = Permission(code="legacy.thing", resource="legacy", action="thing")
        db_session.add(legacy)
        db_session.flush()
        admin = db_session.query(Role).filter(Role.name == "admin").one()
        db_session.add(RolePermission(role_id=admin.id, permission_id=legacy.id))
        db_session.commit()
        legacy_id = legacy.id

        sync_reference_data(db_session)

        assert db_session.query(RolePermission).filter(RolePermission.permission_id == legacy_id).count() == 0
        assert granted_codes(db_session, "admin") == set(ROLE_PERMISSIONS["admin"])

    # A description edited in the database is refreshed from the catalog.
    def test_description_is_refreshed_from_the_catalog(self, db_session):
        sync_reference_data(db_session)
        row = db_session.query(Permission).filter(Permission.code == PermissionCode.USER_VIEW).one()
        row.description = "edited by hand"
        db_session.commit()

        sync_reference_data(db_session)

        db_session.refresh(row)
        assert row.description != "edited by hand"


class TestDemoUsersAreSeparate:
    # Syncing reference data creates no user accounts.
    def test_reference_sync_creates_no_users(self, db_session):
        from app.models import User

        sync_reference_data(db_session)

        assert db_session.query(User).count() == 0

    # The demo seed builds on the reference data and adds the accounts.
    def test_demo_seed_adds_accounts_on_top(self, db_session):
        from app.models import User
        from app.seed import DEMO_USERS, seed_users

        roles_by_name, locations_by_code, teams_by_code = sync_reference_data(db_session)
        seed_users(db_session, roles_by_name, locations_by_code, teams_by_code)

        assert db_session.query(User).count() == len(DEMO_USERS)

    # Re-running the demo seed does not duplicate accounts.
    def test_demo_seed_is_idempotent(self, db_session):
        from app.models import User
        from app.seed import DEMO_USERS, seed_users

        for _ in range(2):
            roles_by_name, locations_by_code, teams_by_code = sync_reference_data(db_session)
            seed_users(db_session, roles_by_name, locations_by_code, teams_by_code)

        assert db_session.query(User).count() == len(DEMO_USERS)


class TestLabelsAreDatabaseOwned:
    """Display names and descriptions seed the row when it is created and are
    never written again -- the same rule as grants, applied consistently to
    roles, locations and teams. Previously roles alone were overwritten on
    every run, so renaming a role in the database silently reverted on the
    next backend restart while renaming a location did not."""

    # A renamed role keeps its new label.
    def test_renamed_role_survives(self, db_session):
        sync_reference_data(db_session)
        role = db_session.query(Role).filter(Role.name == "manager").one()
        role.display_name = "Team Lead"
        role.description = "Locally reworded."
        db_session.commit()

        sync_reference_data(db_session)

        db_session.refresh(role)
        assert role.display_name == "Team Lead"
        assert role.description == "Locally reworded."

    # A renamed location keeps its new label.
    def test_renamed_location_survives(self, db_session):
        sync_reference_data(db_session)
        location = db_session.query(Location).filter(Location.code == "IN").one()
        location.name = "Bharat"
        db_session.commit()

        sync_reference_data(db_session)

        db_session.refresh(location)
        assert location.name == "Bharat"

    # A renamed team keeps its new label.
    def test_renamed_team_survives(self, db_session):
        sync_reference_data(db_session)
        team = db_session.query(Team).filter(Team.code == "AR").one()
        team.name = "Billing"
        db_session.commit()

        sync_reference_data(db_session)

        db_session.refresh(team)
        assert team.name == "Billing"

    # A role created on this run still gets its label from the code.
    def test_new_row_still_takes_its_label_from_code(self, db_session):
        sync_reference_data(db_session)

        role = db_session.query(Role).filter(Role.name == "manager").one()
        assert role.display_name == "Manager"

    # Deactivating a role in the database is durable.
    def test_deactivated_role_stays_deactivated(self, db_session):
        sync_reference_data(db_session)
        role = db_session.query(Role).filter(Role.name == "manager").one()
        role.is_active = False
        db_session.commit()

        sync_reference_data(db_session)

        db_session.refresh(role)
        assert role.is_active is False


class TestHierarchyIsCodeOwned:
    """The exception to label-ownership: parent_role_id is not cosmetic --
    authz.role_rank reads it as seniority, so ROLES stays the definition of
    record and a reparent made in the database is reasserted."""

    # A reparented role is put back where the code says it belongs.
    def test_reparented_role_is_restored(self, db_session):
        sync_reference_data(db_session)
        roles = {r.name: r for r in db_session.query(Role).all()}
        # Promote "user" to a root role -- under authz.role_rank that would
        # make it the most senior role in the system.
        roles["user"].parent_role_id = None
        db_session.commit()

        sync_reference_data(db_session)

        roles = {r.name: r for r in db_session.query(Role).all()}
        assert roles["user"].parent_role_id == roles["manager"].id


@pytest.mark.parametrize("role_name", sorted(DEFAULT_ROLE_PERMISSIONS))
class TestSeededRolesMatchTheCatalog:
    # Each seeded role's defaults reference only real catalogued permissions.
    def test_defaults_are_all_real_permissions(self, db_session, role_name):
        sync_reference_data(db_session)

        assert set(ROLE_PERMISSIONS[role_name]) <= set(DEFAULT_ROLE_PERMISSIONS["admin"])
        assert granted_codes(db_session, role_name) == set(DEFAULT_ROLE_PERMISSIONS[role_name])
