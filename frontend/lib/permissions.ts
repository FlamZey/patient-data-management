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

// Central check for "does this user's role grant this permission code" --
// used instead of each caller re-deriving `role.permissions.map(p => p.code)`.
// user: signed-in user, or null/undefined before auth resolves.
// code: a permission code from PERMISSIONS above. Typed as PermissionCode
// rather than string so a typo is a compile error -- a misspelled code would
// otherwise be a check that simply never matches, silently hiding a control.
//
// UserRead.role is a RoleRead, so `permissions` is always present per the
// types -- passing a grant-less RoleSummary from the /roles lookup is a
// compile error rather than a silent `false`. The `?.` below is runtime
// defence only: responses aren't validated at runtime, so a malformed payload
// must read as "no permissions" rather than throwing inside a render.
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
 * Returns `null` when the chain cannot be fully resolved, which the server
 * never has to deal with: it walks the chain in the database, while this only
 * has whatever `GET /roles` returned. A parent that isn't in `rolesById` -- an
 * inactive role, or the lookup not having loaded yet -- is unresolvable, and
 * callers must treat that as "unknown" rather than guessing a number.
 *
 * The walk starts from a role *object* rather than an id so the caller's own
 * role and each row's role resolve even when they're absent from the lookup;
 * only their ancestors need to be found.
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
 * a caller may only act on accounts whose role is strictly BELOW their own, so
 * peers are excluded (manager -> manager and admin -> admin are both refused),
 * and acting on yourself is exempt from the rank test entirely.
 *
 * Returns `true` when either rank is unresolvable. That is deliberate: the
 * backend decides regardless, so an unknown answer should leave the control
 * offered and let the API refuse it (with a specific message) rather than
 * hide an action the caller may well be allowed to take. In particular this
 * keeps every row's Edit button visible while `GET /roles` is still in flight.
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
