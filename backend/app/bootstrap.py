"""
Reference data the app cannot run without: roles, permissions, role->permission
grants, locations, teams. Migrations create empty tables, and users.role_id/
location_id are NOT NULL, so nobody can sign in until this runs -- it runs
automatically on container start (docker-entrypoint.sh). Demo *users* are
separate and opt-in (app.seed).

Ownership: WHICH PERMISSIONS EXIST is code-owned -- app.core.permissions is
authoritative, and retired codes are deleted here (cascading their grants).
WHICH ROLES HOLD WHICH PERMISSIONS is database-owned -- DEFAULT_ROLE_PERMISSIONS
seeds a role once, then the database wins; a newly catalogued permission is NOT
auto-granted to existing roles (`--reset-grants` forces catalog defaults).
Labels (display names/descriptions) follow the same database-owned rule,
except roles.parent_role_id, which authorization reads as seniority and stays
code-owned, reasserted every run.

Safe to re-run: every insert is keyed on name/code, so nothing duplicates.

Usage:
    python -m app.bootstrap
    python -m app.bootstrap --reset-grants
"""

import argparse

from sqlalchemy.orm import Session

from app.core.permissions import DEFAULT_ROLE_PERMISSIONS, PERMISSION_CATALOG
from app.database import SessionLocal
from app.models import Location, Permission, Role, RolePermission, Team

ROLES = [
    # name, display_name, parent name, description
    # parent name builds roles.parent_role_id, read as seniority by authz.role_rank -- load-bearing, not decorative.
    ("admin", "Administrator", None, "Full system access."),
    ("manager", "Manager", "admin", "Maintains user profiles and uploads/reviews patient data."),
    # No permissions by design -- see DEFAULT_ROLE_PERMISSIONS.
    ("user", "User", "manager", "Standard account with self-service profile access only."),
]

LOCATIONS = [
    # code, name
    ("US", "United States"),
    ("IN", "India"),
    ("EU", "European Union"),
    ("AU", "Australia"),
]

TEAMS = [
    # code, name, description
    ("AR", "Accounts Receivable", "Handles billing and receivables."),
    ("EPA", "Environmental Protection Agency", "Environmental compliance team."),
    ("PRI", "Priority Team", "Handles priority/escalated cases."),
]

# Both come from app.core.permissions -- add a permission there, not here.
PERMISSIONS = list(PERMISSION_CATALOG.items())

# A separate dict of lists, not a reference to DEFAULT_ROLE_PERMISSIONS' tuples -- so tests (e.g. monkeypatching a
# role's grants) can freely replace entries here without mutating the shared, immutable catalog default.
ROLE_PERMISSIONS = {role: list(codes) for role, codes in DEFAULT_ROLE_PERMISSIONS.items()}


def seed_roles(db: Session) -> tuple[dict[str, Role], set[str]]:
    """Creates/refreshes the seeded roles. Returns the roles by name, plus the
    names created on this run -- the only ones seed_role_permissions may apply
    default grants to (existing roles' grants belong to the database)."""
    roles_by_name: dict[str, Role] = {}
    created: set[str] = set()
    for name, display_name, parent_name, description in ROLES:
        role = db.query(Role).filter(Role.name == name).one_or_none()
        if role is None:
            role = Role(name=name, display_name=display_name, description=description)
            db.add(role)
            db.flush()
            created.add(name)
        # display_name/description are labels -- not refreshed from ROLES once the row exists.
        roles_by_name[name] = role

    # parent_role_id stays code-owned (authz.role_rank reads it as seniority), unlike the labels above.
    for name, _display_name, parent_name, _description in ROLES:
        if parent_name is None:
            continue
        role = roles_by_name[name]
        parent = roles_by_name[parent_name]
        if role.parent_role_id != parent.id:
            role.parent_role_id = parent.id

    db.commit()
    return roles_by_name, created


def seed_locations(db: Session) -> dict[str, Location]:
    locations_by_code: dict[str, Location] = {}
    for code, name in LOCATIONS:
        location = db.query(Location).filter(Location.code == code).one_or_none()
        if location is None:
            location = Location(code=code, name=name)
            db.add(location)
            db.flush()
        # name is a label -- not refreshed from LOCATIONS once the row exists (same rule as seed_roles).
        locations_by_code[code] = location
    db.commit()
    return locations_by_code


def seed_teams(db: Session) -> dict[str, Team]:
    teams_by_code: dict[str, Team] = {}
    for code, name, description in TEAMS:
        team = db.query(Team).filter(Team.code == code).one_or_none()
        if team is None:
            team = Team(code=code, name=name, description=description)
            db.add(team)
            db.flush()
        # name/description are labels -- not refreshed from TEAMS once the row exists (same rule as seed_roles).
        teams_by_code[code] = team
    db.commit()
    return teams_by_code


def seed_permissions(db: Session) -> dict[str, Permission]:
    """Reconciles the permissions table to exactly match the catalog: inserts
    what's missing, refreshes descriptions, and deletes retired codes -- a
    stale row would still look like a real, grantable capability."""
    permissions_by_code: dict[str, Permission] = {}
    for code, description in PERMISSIONS:
        permission = db.query(Permission).filter(Permission.code == code).one_or_none()
        if permission is None:
            resource, action = code.split(".", 1)
            permission = Permission(code=code, resource=resource, action=action, description=description)
            db.add(permission)
            db.flush()
        elif permission.description != description:
            permission.description = description
        permissions_by_code[code] = permission

    # role_permissions has ON DELETE CASCADE, so this also drops every grant of the retired permission.
    for permission in db.query(Permission).filter(Permission.code.notin_(list(permissions_by_code))).all():
        db.delete(permission)

    db.commit()
    return permissions_by_code


def seed_role_permissions(
    db: Session,
    roles_by_name: dict[str, Role],
    permissions_by_code: dict[str, Permission],
    *,
    apply_defaults_to: set[str],
) -> None:
    """Sets the named roles' grants to exactly the catalog defaults. Only
    roles in `apply_defaults_to` are touched -- normally just the ones
    created this run. Passing every role name (--reset-grants) discards
    runtime customization instead."""
    for role_name in sorted(apply_defaults_to):
        codes = ROLE_PERMISSIONS[role_name]
        role = roles_by_name[role_name]
        wanted_permission_ids = {permissions_by_code[code].id for code in codes}
        existing_rows = db.query(RolePermission).filter(RolePermission.role_id == role.id).all()
        existing_permission_ids = {row.permission_id for row in existing_rows}

        for row in existing_rows:
            if row.permission_id not in wanted_permission_ids:
                db.delete(row)

        for permission_id in wanted_permission_ids - existing_permission_ids:
            db.add(RolePermission(role_id=role.id, permission_id=permission_id))
    db.commit()


def sync_reference_data(
    db: Session, *, reset_grants: bool = False
) -> tuple[dict[str, Role], dict[str, Location], dict[str, Team]]:
    """Brings every reference table in line with the definitions above.
    `reset_grants=True` forces every role's grants back to catalog defaults,
    discarding runtime customization (off by default -- grants are
    database-owned; see the module docstring). Returns the role/location/team
    lookups so a caller creating users (app.seed) needn't re-query them."""
    roles_by_name, created_roles = seed_roles(db)
    locations_by_code = seed_locations(db)
    teams_by_code = seed_teams(db)
    permissions_by_code = seed_permissions(db)
    seed_role_permissions(
        db,
        roles_by_name,
        permissions_by_code,
        # A brand-new role has no grants to preserve; an existing one is left alone unless a reset is requested.
        apply_defaults_to=set(ROLE_PERMISSIONS) if reset_grants else created_roles,
    )
    return roles_by_name, locations_by_code, teams_by_code


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--reset-grants",
        action="store_true",
        help=(
            "Force every seeded role's permissions back to the catalog defaults, "
            "discarding grants added or revoked directly in the database. Without "
            "this, existing roles' grants are left untouched."
        ),
    )
    args = parser.parse_args()

    db = SessionLocal()
    try:
        sync_reference_data(db, reset_grants=args.reset_grants)
        if args.reset_grants:
            print("Reference data synced; role grants reset to catalog defaults.")
        else:
            print("Reference data synced.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
