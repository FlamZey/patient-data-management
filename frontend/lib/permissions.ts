import type { UserRead } from "./types";

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
