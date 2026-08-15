"""Read-only reference-data lookups (roles, locations, teams). Requires authentication."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.deps import get_current_user
from app.database import get_db
from app.models import Location, Role, Team
from app.schemas import LocationRead, RoleRead, TeamRead

router = APIRouter(tags=["lookups"], dependencies=[Depends(get_current_user)])


@router.get("/roles", response_model=list[RoleRead])
def list_roles(db: Session = Depends(get_db)) -> list[Role]:
    return db.query(Role).filter(Role.is_active.is_(True)).all()


@router.get("/locations", response_model=list[LocationRead])
def list_locations(db: Session = Depends(get_db)) -> list[Location]:
    return db.query(Location).filter(Location.is_active.is_(True)).all()


@router.get("/teams", response_model=list[TeamRead])
def list_teams(db: Session = Depends(get_db)) -> list[Team]:
    return db.query(Team).filter(Team.is_active.is_(True)).all()
