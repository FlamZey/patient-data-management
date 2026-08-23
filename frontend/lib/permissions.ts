import type { UserRead } from "./types";

// Central check for "does this user's role grant this permission code" --
// used instead of each caller re-deriving `role.permissions.map(p => p.code)`.
// user: signed-in user, or null/undefined before auth resolves.
// code: a permission string like "patient.view".
export function hasPermission(user: UserRead | null | undefined, code: string): boolean {
  return user?.role.permissions.some((permission) => permission.code === code) ?? false;
}
