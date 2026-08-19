"""
Idempotent seed script for roles, locations, teams, permissions, and demo users.

Safe to re-run against a non-empty database: every insert is preceded by a
lookup on the row's natural key (name/code/email), so re-running this script
only fills in whatever is missing instead of duplicating or raising on
unique-constraint violations.

Usage:
    python -m app.seed
"""

from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.database import SessionLocal
from app.models import Location, Permission, Role, RolePermission, Team, User


ROLES = [
    # name, display_name, parent name, description
    ("admin", "Administrator", None, "Full system access."),
    ("manager", "Manager", "admin", "Manages users and reviews patient data."),
    ("user", "User", "manager", "Standard operator with patient data access."),
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

PERMISSIONS = [
    # code, description
    ("user.view", "View user accounts."),
    ("user.edit", "Edit user accounts."),
    ("user.delete", "Delete user accounts."),
    ("user.create", "Create user accounts."),
    ("role.assign", "Assign roles to users."),
    ("audit.view", "View audit logs."),
    ("patient.view", "View patient data."),
    ("patient.edit", "Edit patient data."),
    ("patient.delete", "Delete patient data."),
    ("patient.view_all", "View patient data uploaded by any manager."),
]

ROLE_PERMISSIONS = {
    "admin": [code for code, _ in PERMISSIONS],
    "manager": ["user.view", "user.edit", "audit.view", "patient.view", "patient.edit"],
    "user": [],
}

DEMO_PASSWORD = "ChangeMe123!"

DEMO_USERS = [
    # email, username, first_name, last_name, role, location, team
    ("admin.us@example.com", "admin.us", "Ada", "Admin", "admin", "US", None),
    ("manager.in@example.com", "manager.in", "Mira", "Manager", "manager", "IN", "AR"),
    ("manager.eu@example.com", "manager.eu", "Elan", "Manager", "manager", "EU", "PRI"),
    ("user.us@example.com", "user.us", "Uma", "User", "user", "US", "AR"),
    ("user.au@example.com", "user.au", "Ravi", "User", "user", "AU", "EPA"),
    ("user.eu@example.com", "user.eu", "Nora", "User", "user", "EU", "PRI"),
]


def seed_roles(db: Session) -> dict[str, Role]:
    roles_by_name: dict[str, Role] = {}
    for name, display_name, parent_name, description in ROLES:
        role = db.query(Role).filter(Role.name == name).one_or_none()
        if role is None:
            role = Role(name=name, display_name=display_name, description=description)
            db.add(role)
            db.flush()
        roles_by_name[name] = role

    for name, _display_name, parent_name, _description in ROLES:
        if parent_name is None:
            continue
        role = roles_by_name[name]
        parent = roles_by_name[parent_name]
        if role.parent_role_id != parent.id:
            role.parent_role_id = parent.id

    db.commit()
    return roles_by_name


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
    permissions_by_code: dict[str, Permission] = {}
    for code, description in PERMISSIONS:
        permission = db.query(Permission).filter(Permission.code == code).one_or_none()
        if permission is None:
            resource, action = code.split(".", 1)
            permission = Permission(code=code, resource=resource, action=action, description=description)
            db.add(permission)
            db.flush()
        permissions_by_code[code] = permission
    db.commit()
    return permissions_by_code


def seed_role_permissions(
    db: Session, roles_by_name: dict[str, Role], permissions_by_code: dict[str, Permission]
) -> None:
    """Reconciles role_permissions to exactly match ROLE_PERMISSIONS: adds
    whatever's missing and removes whatever's no longer granted, so changing
    ROLE_PERMISSIONS and re-running takes effect even on an already-seeded DB."""
    for role_name, codes in ROLE_PERMISSIONS.items():
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


def seed_users(
    db: Session,
    roles_by_name: dict[str, Role],
    locations_by_code: dict[str, Location],
    teams_by_code: dict[str, Team],
) -> None:
    password_hash = hash_password(DEMO_PASSWORD)
    for email, username, first_name, last_name, role_name, location_code, team_code in DEMO_USERS:
        user = db.query(User).filter(User.email == email).one_or_none()
        if user is not None:
            continue
        db.add(
            User(
                email=email,
                username=username,
                password_hash=password_hash,
                first_name=first_name,
                last_name=last_name,
                role_id=roles_by_name[role_name].id,
                location_id=locations_by_code[location_code].id,
                team_id=teams_by_code[team_code].id if team_code else None,
            )
        )
    db.commit()


def main() -> None:
    db = SessionLocal()
    try:
        roles_by_name = seed_roles(db)
        locations_by_code = seed_locations(db)
        teams_by_code = seed_teams(db)
        permissions_by_code = seed_permissions(db)
        seed_role_permissions(db, roles_by_name, permissions_by_code)
        seed_users(db, roles_by_name, locations_by_code, teams_by_code)
        print("Seed complete.")
    finally:
        db.close()


if __name__ == "__main__":
    main()