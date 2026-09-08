import type { RoleSummary, UserRead } from "./types";

// Mirrors backend/app/core/permissions.py. These gate what the UI *offers*;
// the backend gates what actually happens. Every check here has a matching
// server-side check -- hiding a control is a usability decision, never the
// security boundary, so a value that slipped past the UI is still refused by
// the API (see backend/app/core/authz.py).
export const PERMISSIONS = {
  userView: "user.view",
  userCreate: "user.create",
  userEdit: "user.edit",
  userDelete: "user.delete",
  userSuspend: "user.suspend",
  roleAssign: "role.assign",
  patientView: "patient.view",
  patientViewAll: "patient.view_all",
  patientCreate: "patient.create",
  patientEdit: "patient.edit",
  patientDelete: "patient.delete",
  patientManageAll: "patient.manage_all",
  auditView: "audit.view",
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// Does this user's role grant this permission code? `code` is typed as
// PermissionCode, not string, so a typo is a compile error instead of a
// check that silently never matches. The `?.` is runtime defence only --
// permissions is always present by type, but responses aren't validated
// at runtime, so a malformed payload should read as "no permissions"
// rather than throw.
export function hasPermission(user: UserRead | null | undefined, code: PermissionCode): boolean {
  return user?.role.permissions?.some((permission) => permission.code === code) ?? false;
}

// True if the user holds at least one of the given codes -- the frontend
// counterpart to the backend's require_any_permission, for controls that any
// one of several permissions unlocks.
export function hasAnyPermission(user: UserRead | null | undefined, ...codes: PermissionCode[]): boolean {
  return codes.some((code) => hasPermission(user, code));
}

// Which fields of another user's account this caller may change. Mirrors
// PRIVILEGED_USER_FIELDS and USER_UPDATE_PERMISSIONS in
// backend/app/core/authz.py: editing a profile, assigning a role, and
// changing an account's status are three separate authorizations, so the
// table renders three separately-gated controls rather than one "can edit"
// flag that would let a manager submit a role change the API then rejects.
export interface UserEditCapabilities {
  canEditProfile: boolean; // name, email, username, location, team
  canAssignRole: boolean;
  canChangeStatus: boolean;
  canEditAnything: boolean; // whether to show the row's edit affordance at all
}

export function userEditCapabilities(user: UserRead | null | undefined): UserEditCapabilities {
  const canEditProfile = hasPermission(user, PERMISSIONS.userEdit);
  const canAssignRole = hasPermission(user, PERMISSIONS.roleAssign);
  const canChangeStatus = hasPermission(user, PERMISSIONS.userSuspend);
  return {
    canEditProfile,
    canAssignRole,
    canChangeStatus,
    canEditAnything: canEditProfile || canAssignRole || canChangeStatus,
  };
}


// --- role hierarchy ----------------------------------------------------------
// Client-side mirror of backend/app/core/authz.py's role_rank /
// assert_can_administer, used only to avoid offering controls the API would
// refuse. The backend remains the authority: everything below is a UX
// prediction of its answer, never a substitute for it.

// Mirrors authz._MAX_ROLE_DEPTH -- the depth cap that doubles as a cycle guard,
// since roles.parent_role_id is a self-FK with nothing stopping a loop.
const MAX_ROLE_DEPTH = 32;

/**
 * Distance from `role` up to a root role; root (no parent) is 0, so a LOWER
 * rank means MORE authority -- same as the backend.
 *
 * Returns `null` when the chain can't be fully resolved -- a parent missing
 * from `rolesById` (inactive role, or `GET /roles` still loading) -- rather
 * than guessing a number. Takes a role *object*, not an id, so the caller's
 * own role and each row's role resolve even when absent from the lookup.
 */
export function roleRank(
  role: RoleSummary | null | undefined,
  rolesById: Map<number, RoleSummary>,
): number | null {
  // Matches the backend, where a missing role ranks as the least authority
  // available so a half-configured account can never out-rank a real one.
  if (!role) return MAX_ROLE_DEPTH;

  let rank = 0;
  let current = role;
  const seen = new Set<number>();

  while (current.parent_role_id !== null && rank < MAX_ROLE_DEPTH) {
    if (seen.has(current.id)) break; // cycle -- stop rather than loop forever
    seen.add(current.id);

    const parent = rolesById.get(current.parent_role_id);
    if (!parent) return null; // unresolvable: not in the lookup
    current = parent;
    rank += 1;
  }
  return rank;
}

/**
 * Whether `actor` may administer `target`, mirroring authz.assert_can_administer:
 * only accounts strictly BELOW the actor's role (peers excluded), except
 * acting on yourself, which is always allowed.
 *
 * Returns `true` when either rank is unresolvable, deliberately -- the backend
 * decides regardless, so an unknown answer should leave the control offered
 * (e.g. every row's Edit button, while `GET /roles` is still loading) rather
 * than hide an action the caller may be allowed to take.
 */
export function canAdministerUser(
  actor: UserRead | null | undefined,
  target: UserRead,
  rolesById: Map<number, RoleSummary>,
): boolean {
  if (!actor) return false;
  if (actor.id === target.id) return true; // self is exempt from the rank test

  const actorRank = roleRank(actor.role, rolesById);
  const targetRank = roleRank(target.role, rolesById);
  if (actorRank === null || targetRank === null) return true; // unknown -- defer to the backend

  return targetRank > actorRank;
}
