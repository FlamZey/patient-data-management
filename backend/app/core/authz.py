"""Central authorization logic.

Three distinct questions are answered here, and kept distinct on purpose:

1. *Permission authorization* -- does this caller hold permission X at all?
   `granted_permissions` / `has_permission`, surfaced to routers as the
   `require_permission` dependency in `app.core.deps`.

2. *Field-level authorization* -- a caller allowed to edit a user is not
   thereby allowed to change that user's role or account status. Which
   request-body fields need their own permission is declared once in
   `PRIVILEGED_USER_FIELDS` and enforced by `authorize_user_update`, so no
   router ever re-implements it.

3. *Resource-level authorization* -- may this caller act on *this specific*
   row? For users that's the role hierarchy (`assert_can_administer`,
   `assert_can_assign_role`); for patients it's upload ownership
   (`patient_scope_filter_required`).

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
    """Permission codes this user actually holds.

    A deactivated role grants nothing: `is_active` is the switch for taking a
    role out of service, and it would be pointless if the role's permissions
    kept working for everyone already assigned to it.
    """
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
    """Imperative form of the `require_permission` dependency, for checks
    that can only happen after the request body is known (see
    `authorize_user_update`). Same message shape, so a caller can't tell
    from the response whether the gate was a dependency or a field rule."""
    if not has_permission(user, code):
        raise forbidden(f"Missing required permission: {code}")


# --- role hierarchy ---------------------------------------------------------
# roles.parent_role_id models seniority: admin (no parent) <- manager <- user.
# Rank is the distance to the root, so a LOWER rank means MORE authority.
# Before this existed, the hierarchy was stored but never consulted, which is
# what let a user.edit holder promote anyone to admin.


def role_rank(role: Role | None) -> int:
    """Distance from `role` up to a root role. Root (no parent) is 0.

    An unknown/missing role ranks as the least authority available, so a
    half-configured account can never out-rank a real one.
    """
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
    """A caller may only act on accounts whose role is strictly BELOW their
    own. Holding user.edit is authority over the people beneath you -- not over
    the administrator who granted it to you, and not over your own peers.

    Peers are excluded deliberately: two managers are not each other's
    supervisor, so one quietly changing the other's email or suspending them is
    a lateral move no permission is meant to authorize.

    Acting on *yourself* is exempt from the rank test -- otherwise nobody could
    ever edit their own record here, since your own role always ties with
    itself. Self-edits are still bounded by the separate rules in
    authorize_user_update, which refuse changes to your own role or status.
    """
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
# Which UserUpdate/UserCreate fields carry their own permission requirement.
# Everything NOT listed here is ordinary profile data covered by user.edit.
#
# location_id/team_id are deliberately absent: nothing in this application
# scopes access by location or team (patients scope by uploader, permissions
# by role), so they are org placement rather than an authorization boundary.
# If location or team ever gates data access, they belong in this dict.
PRIVILEGED_USER_FIELDS: dict[str, str] = {
    "role_id": Permission.ROLE_ASSIGN,
    "status": Permission.USER_SUSPEND,
}

# The permissions that can justify a PATCH /users/{id} at all. The endpoint
# gates on holding *any* of them so an entirely unprivileged caller is
# rejected before a target is even loaded; which fields each one actually
# unlocks is then decided by authorize_user_update below.
USER_UPDATE_PERMISSIONS: tuple[str, ...] = (
    Permission.USER_EDIT,
    *PRIVILEGED_USER_FIELDS.values(),
)


def _load_role(db: Session, role_id: int) -> Role:
    """Resolves an assignable role, rejecting ids that don't exist or name a
    retired role. Without this the id goes straight to a NOT NULL FK and a
    bad value surfaces as a 500 IntegrityError."""
    role = db.query(Role).filter(Role.id == role_id).one_or_none()
    if role is None or not role.is_active:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Unknown or inactive role"
        )
    return role


def _validate_org_refs(db: Session, updates: dict) -> None:
    """Same existence/active check as _load_role, for the two org FKs. These
    aren't privileged (see PRIVILEGED_USER_FIELDS) but a client-supplied id
    still has to name a real, in-service row."""
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
    """Authorizes POST /users. The endpoint itself gates on user.create; this
    adds the per-field rules, which for a create means the role being handed
    to the new account -- creating an admin is a role assignment like any
    other, so it needs role.assign and passes the same seniority check."""
    _validate_org_refs(db, payload_fields)

    require_permission_of(actor, PRIVILEGED_USER_FIELDS["role_id"])
    assert_can_assign_role(actor, _load_role(db, payload_fields["role_id"]))


def authorize_user_update(db: Session, *, actor: User, target: User, updates: dict) -> None:
    """Authorizes PATCH /users/{id} against the exact set of fields the
    request is trying to change.

    This is the fix for the core privilege-escalation bug: the endpoint's
    permission gate says only that the caller may change *something* about a
    user, so every field that carries more authority than "profile data" is
    checked here, individually, against the caller's own permissions --
    adding role_id or status to a body can no longer smuggle a privileged
    change through a user.edit-only gate.
    """
    # Seniority first: no permission grants authority over a more senior
    # account, so this is checked before any per-field rule.
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
    """Resource rules for DELETE /users/{id} (a soft-delete to suspended).
    The user.delete permission gate is on the endpoint; this is the part that
    depends on *which* account is being deactivated."""
    if target.id == actor.id:
        raise forbidden("You cannot deactivate your own account")
    assert_can_administer(actor, target)


# --- patient scoping --------------------------------------------------------
# Visibility is ownership-based (uploaded_by), with two separate escape
# hatches. Read-all and write-all are distinct permissions on purpose: being
# allowed to see every uploader's records is not the same authority as being
# allowed to edit or delete them.


def can_read_all_patients(user: User) -> bool:
    return has_any_permission(user, Permission.PATIENT_VIEW_ALL, Permission.PATIENT_MANAGE_ALL)


def can_write_all_patients(user: User) -> bool:
    return has_permission(user, Permission.PATIENT_MANAGE_ALL)


def patient_owner_scope(user: User, *, write: bool) -> UUID | None:
    """The uploader id a patient query must be filtered to, or None when the
    caller's permissions lift the ownership filter for this kind of access."""
    unscoped = can_write_all_patients(user) if write else can_read_all_patients(user)
    return None if unscoped else user.id
