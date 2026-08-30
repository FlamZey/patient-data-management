"""
Demo user accounts, for local development and the e2e suite.

Deliberately separate from app.bootstrap: that module holds the reference data
(roles, permissions, grants, locations, teams) the application genuinely
cannot run without and which is applied automatically on container start.
This one creates throwaway accounts that share a well-known password, so it
must never run against a real deployment.

Running this also syncs the reference data first, so `python -m app.seed`
remains a single command that produces a fully usable database.

Safe to re-run against a non-empty database: an account is only created if no
user with that email exists yet.

Usage:
    python -m app.seed
"""

from sqlalchemy.orm import Session

from app.bootstrap import sync_reference_data
from app.core.security import hash_password
from app.database import SessionLocal
from app.models import Location, Role, Team, User

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
        # Demo users reference roles/locations/teams by name, so the reference
        # data has to exist first. Normally the container entrypoint has
        # already done this; calling it again is a no-op.
        roles_by_name, locations_by_code, teams_by_code = sync_reference_data(db)
        seed_users(db, roles_by_name, locations_by_code, teams_by_code)
        print("Seed complete.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
