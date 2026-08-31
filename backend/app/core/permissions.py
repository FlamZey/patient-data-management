"""The permission catalog: every permission code the application enforces,
plus the default role -> permission grants. This module is the single source of truth.

Adding a permission here alone changes nothing: it has to be enforced by an
endpoint dependency (`require_permission`) or a field rule
(`authz.PRIVILEGED_USER_FIELDS`) to mean anything.
"""


class Permission:
    """Permission code constants. Referenced instead of bare strings so a
    typo is an AttributeError at import time rather than a silently
    never-satisfied check at request time."""

    # --- user administration ---
    USER_VIEW = "user.view"
    USER_CREATE = "user.create"
    USER_EDIT = "user.edit"
    USER_DELETE = "user.delete"
    USER_SUSPEND = "user.suspend"

    # --- role assignment ---
    # Deliberately separate from USER_EDIT: changing which role an account
    # holds is a privilege decision, not an edit to normal profile data.
    ROLE_ASSIGN = "role.assign"

    # --- patient records ---
    PATIENT_VIEW = "patient.view"
    PATIENT_VIEW_ALL = "patient.view_all"
    PATIENT_CREATE = "patient.create"
    PATIENT_EDIT = "patient.edit"
    PATIENT_DELETE = "patient.delete"
    PATIENT_MANAGE_ALL = "patient.manage_all"

    # --- audit trail ---
    # Read-only. Nothing writes or deletes audit rows through the API, so
    # there is no audit.edit/audit.delete to go with this -- the log is
    # append-only from the application's own instrumentation.
    AUDIT_VIEW = "audit.view"


# code -> human-readable description
PERMISSION_CATALOG: dict[str, str] = {
    Permission.USER_VIEW: "View user accounts and the reference data (roles, locations, teams) used to manage them.",
    Permission.USER_CREATE: "Create user accounts.",
    Permission.USER_EDIT: "Edit a user's profile fields (name, email, username, location, team).",
    Permission.USER_DELETE: "Deactivate (soft-delete) a user account.",
    Permission.USER_SUSPEND: "Change another user's account status (suspend, reactivate, lock, pending).",
    Permission.ROLE_ASSIGN: "Set or change which role a user account holds.",
    Permission.PATIENT_VIEW: "View patient records you uploaded.",
    Permission.PATIENT_VIEW_ALL: "View patient records uploaded by any user.",
    Permission.PATIENT_CREATE: "Upload/import new patient records.",
    Permission.PATIENT_EDIT: "Edit patient records you uploaded.",
    Permission.PATIENT_DELETE: "Delete patient records you uploaded.",
    Permission.PATIENT_MANAGE_ALL: "Edit or delete patient records uploaded by any user.",
    Permission.AUDIT_VIEW: "Read the security/compliance audit log (who did what, from which IP).",
}


# Default grants per seeded role. Admin gets the whole catalog; the other two
# are least-privilege lists, not "everything minus a few".
#
# Manager deliberately holds neither ROLE_ASSIGN nor USER_SUSPEND: a manager
# maintains people's profile details, but promoting an account or cutting off
# its access are administrator decisions. AUDIT_VIEW is administrator-only for
# the same reason and then some: the log carries IP addresses and every failed
# sign-in attempt, which is more sensitive than the user list a manager can
# already read.
DEFAULT_ROLE_PERMISSIONS: dict[str, tuple[str, ...]] = {
    "admin": tuple(PERMISSION_CATALOG),
    "manager": (
        Permission.USER_VIEW,
        Permission.USER_EDIT,
        Permission.PATIENT_VIEW,
        Permission.PATIENT_CREATE,
        Permission.PATIENT_EDIT,
    ),
    # The standard role is self-service only: /auth/me and its password
    # change, which every authenticated account can reach without holding
    # any permission at all.
    "user": (),
}
