"""Central authorization logic. Three separate questions, kept separate:

1. Permission -- does the caller hold permission X at all? (granted_permissions,
   has_permission, surfaced as the require_permission dependency in deps.py)
2. Field-level -- editing a user doesn't mean changing their role/status too;
   see PRIVILEGED_USER_FIELDS and authorize_user_update.
3. Resource-level -- may the caller act on *this* row? Role hierarchy for
   users (assert_can_administer), upload ownership for patients (patient_owner_scope).

Routers call into this module; this module never imports routers.
"""

from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.permissions import Permission
from app.models import Location, Role, Team, User

# Maximum parent links walked when ranking a role -- also the cycle guard,
# since roles.parent_role_id is a self-FK with nothing stopping a loop.
_MAX_ROLE_DEPTH = 32


def granted_permissions(user: User) -> frozenset[str]:
    """Permission codes this user actually holds. A deactivated role grants
    nothing -- retiring a role would be pointless otherwise."""
    if user.role is None or not user.role.is_active:
        return frozenset()
    return frozenset(permission.code for permission in user.role.permissions)


def has_permission(user: User, code: str) -> bool:
    return code in granted_permissions(user)


def has_any_permission(user: User, *codes: str) -> bool:
    return bool(granted_permissions(user) & set(codes))


def forbidden(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=detail)


def require_permission_of(user: User, code: str) -> None:
    """Like the require_permission dependency, but callable directly for
    checks that need the request body first (see authorize_user_update)."""
    if not has_permission(user, code):
        raise forbidden(f"Missing required permission: {code}")


# --- role hierarchy ---------------------------------------------------------
# roles.parent_role_id models seniority: admin (no parent) <- manager <- user.
# Rank is the distance to the root, so a LOWER rank means MORE authority.


def role_rank(role: Role | None) -> int:
    """Distance from `role` up to a root role (root is 0). A missing role
    ranks as the least authority, so a half-configured account never
    out-ranks a real one."""
    if role is None:
        return _MAX_ROLE_DEPTH

    rank = 0
    seen: set[int] = set()
    current = role
    while current.parent is not None and rank < _MAX_ROLE_DEPTH:
        if current.id in seen:  # cycle in parent_role_id -- stop rather than loop forever
            break
        seen.add(current.id)
        current = current.parent
        rank += 1
    return rank


def assert_can_administer(actor: User, target: User) -> None:
    """A caller may only act on accounts ranked strictly below their own --
    not on peers (two managers aren't each other's supervisor) and not
    upward. Self-edits are exempt here (your rank always ties with itself)
    but stay bounded by authorize_user_update's own-role/status rules."""
    if target.id == actor.id:
        return
    if role_rank(target.role) <= role_rank(actor.role):
        raise forbidden("You can only modify users whose role is below your own")


def assert_can_assign_role(actor: User, new_role: Role) -> None:
    """Nobody may hand out a role more senior than the one they hold --
    otherwise role.assign would be a one-step path to admin."""
    if role_rank(new_role) < role_rank(actor.role):
        raise forbidden("You cannot assign a role more senior than your own")


# --- user write authorization -----------------------------------------------
# UserUpdate/UserCreate fields that need their own permission beyond
# user.edit. location_id/team_id are deliberately absent: they're org
# placement, not an access boundary (patients scope by uploader, not location/team).
PRIVILEGED_USER_FIELDS: dict[str, str] = {
    "role_id": Permission.ROLE_ASSIGN,
    "status": Permission.USER_SUSPEND,
}

# Any one of these reaches PATCH /users/{id} at all; authorize_user_update
# below then decides which fields each one actually unlocks.
USER_UPDATE_PERMISSIONS: tuple[str, ...] = (
    Permission.USER_EDIT,
    *PRIVILEGED_USER_FIELDS.values(),
)


def _load_role(db: Session, role_id: int) -> Role:
    """Resolves an assignable role, rejecting an id that's missing or
    retired -- otherwise a bad value hits the NOT NULL FK as a 500."""
    role = db.query(Role).filter(Role.id == role_id).one_or_none()
    if role is None or not role.is_active:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Unknown or inactive role"
        )
    return role


def _validate_org_refs(db: Session, updates: dict) -> None:
    """Same existence/active check as _load_role, for location_id/team_id --
    not privileged, but a client-supplied id still must name a real row."""
    if "location_id" in updates and updates["location_id"] is not None:
        location = db.query(Location).filter(Location.id == updates["location_id"]).one_or_none()
        if location is None or not location.is_active:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Unknown or inactive location"
            )

    if updates.get("team_id") is not None:
        team = db.query(Team).filter(Team.id == updates["team_id"]).one_or_none()
        if team is None or not team.is_active:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Unknown or inactive team"
            )


def authorize_user_create(db: Session, *, actor: User, payload_fields: dict) -> None:
    """Authorizes POST /users beyond the user.create gate: the role handed to
    the new account is a role assignment like any other, so it needs
    role.assign and the same seniority check."""
    _validate_org_refs(db, payload_fields)

    require_permission_of(actor, PRIVILEGED_USER_FIELDS["role_id"])
    assert_can_assign_role(actor, _load_role(db, payload_fields["role_id"]))


def authorize_user_update(db: Session, *, actor: User, target: User, updates: dict) -> None:
    """Authorizes PATCH /users/{id} against the exact fields being changed.
    The endpoint gate only proves the caller may change *something*; every
    privileged field is checked here individually so role_id/status can't be
    smuggled through on a user.edit-only permission."""
    # Seniority first -- no permission grants authority over a more senior account.
    assert_can_administer(actor, target)

    if set(updates) - set(PRIVILEGED_USER_FIELDS):
        require_permission_of(actor, Permission.USER_EDIT)

    for field, required_code in PRIVILEGED_USER_FIELDS.items():
        if field in updates:
            require_permission_of(actor, required_code)

    _validate_org_refs(db, updates)

    if "status" in updates and target.id == actor.id:
        # Suspending or unsuspending yourself is never a legitimate
        # administrative action, and self-service status changes are exactly
        # how an account escapes a suspension.
        raise forbidden("You cannot change your own account status")

    if "role_id" in updates:
        if target.id == actor.id:
            # The classic escalation path, blocked outright rather than left
            # to the seniority check (which would still permit a self-demote).
            raise forbidden("You cannot change your own role")
        assert_can_assign_role(actor, _load_role(db, updates["role_id"]))


def assert_can_deactivate(actor: User, target: User) -> None:
    """Resource rules for DELETE /users/{id} (soft-delete to suspended):
    no self-deactivation, and the usual seniority check."""
    if target.id == actor.id:
        raise forbidden("You cannot deactivate your own account")
    assert_can_administer(actor, target)


# --- patient scoping --------------------------------------------------------
# Visibility is ownership-based (uploaded_by). Read-all and write-all are
# separate permissions: seeing every uploader's records doesn't mean you may edit them.


def can_read_all_patients(user: User) -> bool:
    return has_any_permission(user, Permission.PATIENT_VIEW_ALL, Permission.PATIENT_MANAGE_ALL)


def can_write_all_patients(user: User) -> bool:
    return has_permission(user, Permission.PATIENT_MANAGE_ALL)


def patient_owner_scope(user: User, *, write: bool) -> UUID | None:
    """The uploader id a patient query must be filtered to, or None when the
    caller's permissions lift the ownership filter for this kind of access."""
    unscoped = can_write_all_patients(user) if write else can_read_all_patients(user)
    return None if unscoped else user.id
