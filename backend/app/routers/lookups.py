"""Read-only reference-data lookups (roles, locations, teams).

These exist purely to populate the user-management dropdowns and column
filters, so they require user.view rather than merely being authenticated --
otherwise any account, including one holding no permissions at all, could
enumerate the org structure and (via /roles) the whole permission matrix.

/roles returns RoleSummary, which omits each role's permission list for the
same reason: a caller's own permissions come back from /auth/me, and nothing
in the UI needs to read the grants of roles the caller doesn't hold.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.deps import require_permission
from app.core.permissions import Permission
from app.database import get_db
from app.models import Location, Role, Team
from app.schemas import LocationRead, RoleSummary, TeamRead

router = APIRouter(tags=["lookups"], dependencies=[Depends(require_permission(Permission.USER_VIEW))])


# Every lookup is ordered by id -- i.e. seed/insertion order, which for roles
# is also seniority (admin, manager, user). Without an explicit ORDER BY these
# come back in whatever order Postgres happens to hold them, and that shifts
# the moment any row is UPDATEd: the dropdowns would silently reshuffle for
# users, and anything selecting an option by position becomes a coin flip.


@router.get("/roles", response_model=list[RoleSummary])
def list_roles(db: Session = Depends(get_db)) -> list[Role]:
    """List active roles, without their permission grants (see module docstring)."""
    return db.query(Role).filter(Role.is_active.is_(True)).order_by(Role.id).all()


@router.get("/locations", response_model=list[LocationRead])
def list_locations(db: Session = Depends(get_db)) -> list[Location]:
    """List active locations."""
    return db.query(Location).filter(Location.is_active.is_(True)).order_by(Location.id).all()


@router.get("/teams", response_model=list[TeamRead])
def list_teams(db: Session = Depends(get_db)) -> list[Team]:
    """List active teams."""
    return db.query(Team).filter(Team.is_active.is_(True)).order_by(Team.id).all()
