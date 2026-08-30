"""
Reference data the application cannot run without: roles, permissions, the
role -> permission grants, locations, and teams.

This is NOT demo data. The migrations create empty tables, so without this
step a fresh database has no roles at all -- and since `users.role_id` and
`users.location_id` are both NOT NULL, no account can be created and nobody
can sign in. It therefore runs automatically on container start (see
backend/docker-entrypoint.sh) rather than being a step someone has to
remember. Demo *users* are the opt-in part and live in app.seed.

Two different ownership rules apply here, and the distinction is the whole
point of this module:

* WHICH PERMISSIONS EXIST is owned by the code. A permission is only real
  because some line of code enforces it, so the catalog in
  app.core.permissions is authoritative: codes are inserted, refreshed, and
  -- when retired from the catalog -- deleted, taking their grants with them
  via the role_permissions cascade. A permission row added by hand is removed
  on the next run.

* WHICH ROLES HOLD WHICH PERMISSIONS is owned by the database. DEFAULT_ROLE_
  PERMISSIONS is a set of *defaults*, applied when a role is first created and
  never again. After that the database wins: a grant added or revoked at
  runtime survives every subsequent run. This is what makes the design claim
  in docs/architecture.md true -- changing a role's access is a database
  write, not a code change and a deploy.

  The consequence to be aware of: a permission newly added to the catalog is
  NOT automatically granted to existing roles. Someone has to grant it. Run
  `python -m app.bootstrap --reset-grants` to force every seeded role back to
  its catalog defaults, discarding runtime customization.

* LABELS -- roles', locations' and teams' display names and descriptions --
  are owned by the database too, by the same rule: the values here seed the
  row when it is created and are never written again. Renaming a role or a
  location directly in the database is durable.

  The one exception is roles.parent_role_id, which is reasserted on every run:
  it is not a label but the seniority hierarchy that authorization enforces
  (app.core.authz.role_rank), so ROLES stays the definition of record.

In short: this module guarantees the rows *exist* and that the permission
catalog is exact. Almost everything else about those rows, once created, is
yours to change and will not be overwritten.

Safe to re-run: every insert is preceded by a lookup on the row's natural key
(name/code), so this only fills in what's missing instead of duplicating or
tripping a unique constraint.

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
    # parent name builds roles.parent_role_id, which authorization reads as
    # seniority (see app.core.authz.role_rank) -- a role with no parent is the
    # most senior, so this ordering is load-bearing, not just descriptive.
    ("admin", "Administrator", None, "Full system access."),
    ("manager", "Manager", "admin", "Maintains user profiles and uploads/reviews patient data."),
    # No permissions by design -- see DEFAULT_ROLE_PERMISSIONS. A standard
    # account can sign in and manage its own profile and password, nothing else.
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

# Permission codes and the per-role grants both come from
# app.core.permissions, so the catalog the application enforces and the rows
# written here can never drift apart. Add a permission there, not here.
PERMISSIONS = list(PERMISSION_CATALOG.items())

ROLE_PERMISSIONS = {role: list(codes) for role, codes in DEFAULT_ROLE_PERMISSIONS.items()}


def seed_roles(db: Session) -> tuple[dict[str, Role], set[str]]:
    """Creates/refreshes the seeded roles.

    Returns the roles by name, plus the names of the ones actually created on
    this run -- those are the only roles seed_role_permissions may apply
    default grants to, since an existing role's grants belong to the database
    (see the module docstring).
    """
    roles_by_name: dict[str, Role] = {}
    created: set[str] = set()
    for name, display_name, parent_name, description in ROLES:
        role = db.query(Role).filter(Role.name == name).one_or_none()
        if role is None:
            role = Role(name=name, display_name=display_name, description=description)
            db.add(role)
            db.flush()
            created.add(name)
        # An existing role's display_name/description are deliberately NOT
        # refreshed from ROLES -- they are labels, and labels belong to the
        # database once the row exists (same rule as locations and teams).
        # Renaming a role in the database is durable.
        roles_by_name[name] = role

    # parent_role_id stays code-owned, unlike the labels above: it is not
    # cosmetic -- authorization reads it as seniority (authz.role_rank), so the
    # hierarchy declared in ROLES should always be the one actually in force.
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
        teams_by_code[code] = team
    db.commit()
    return teams_by_code


def seed_permissions(db: Session) -> dict[str, Permission]:
    """Reconciles the permissions table to exactly match the catalog: inserts
    what's missing, refreshes descriptions, and deletes codes the application
    no longer enforces. That last part matters -- a permission row left behind
    after its checks were removed reads like a live capability to anyone
    inspecting the database, and can still be granted to a role."""
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

    # role_permissions has ON DELETE CASCADE, so dropping a retired permission
    # also drops every grant of it.
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
    """Sets the named roles' grants to exactly the catalog defaults.

    Only the roles in `apply_defaults_to` are touched at all -- normally just
    the ones created on this run. Every other role's grants are left exactly
    as the database has them, which is what makes runtime changes durable.
    Passing every role name (what --reset-grants does) turns this back into a
    full reconcile that discards customization.
    """
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

    `reset_grants=True` additionally forces every seeded role's grants back to
    the catalog defaults, discarding any runtime customization. Off by default
    because grants are database-owned; see the module docstring.

    Returns the role/location/team lookups so a caller that goes on to create
    users (app.seed) doesn't have to re-query them.
    """
    roles_by_name, created_roles = seed_roles(db)
    locations_by_code = seed_locations(db)
    teams_by_code = seed_teams(db)
    permissions_by_code = seed_permissions(db)
    seed_role_permissions(
        db,
        roles_by_name,
        permissions_by_code,
        # A brand-new role has no grants to preserve, so defaults apply. An
        # existing one is left alone unless the caller explicitly asks for a
        # reset.
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
