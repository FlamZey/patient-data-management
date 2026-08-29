import { hasPermission } from "@/lib/permissions";
import type { PermissionRead, RoleRead, UserRead } from "@/lib/types";

function makePermission(code: string): PermissionRead {
  return { id: 1, code, resource: code.split(".")[0], action: code.split(".")[1], description: null };
}

function makeRole(codes: string[]): RoleRead {
  return {
    id: 1,
    name: "role",
    display_name: "Role",
    parent_role_id: null,
    description: null,
    is_active: true,
    permissions: codes.map(makePermission),
  };
}

function makeUser(codes: string[]): UserRead {
  return {
    id: "u1",
    email: "a@example.com",
    username: "a",
    first_name: "A",
    last_name: "B",
    status: "active",
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    password_changed_at: null,
    role: makeRole(codes),
    location: { id: 1, code: "US", name: "United States", is_active: true },
    team: null,
  };
}

describe("lib/permissions", () => {
  // Returns true when the user's role grants the exact permission code.
  it("returns true when the user's role grants the exact permission code", () => {
    const user = makeUser(["patient.view", "patient.edit"]);
    expect(hasPermission(user, "patient.view")).toBe(true);
  });

  // Returns false when the user's role does not grant the permission code.
  it("returns false when the user's role does not grant the permission code", () => {
    const user = makeUser(["patient.view"]);
    expect(hasPermission(user, "patient.delete")).toBe(false);
  });

  // Returns false when the user has no permissions at all.
  it("returns false when the user has no permissions at all", () => {
    const user = makeUser([]);
    expect(hasPermission(user, "patient.view")).toBe(false);
  });

  // Returns false for a null user (not yet authenticated).
  it("returns false for a null user", () => {
    expect(hasPermission(null, "patient.view")).toBe(false);
  });

  // Returns false for an undefined user (auth still resolving).
  it("returns false for an undefined user", () => {
    expect(hasPermission(undefined, "patient.view")).toBe(false);
  });

  // Does not match a code that only partially overlaps another granted code.
  it("does not match a code that only partially overlaps another granted code", () => {
    const user = makeUser(["patient.view_all"]);
    expect(hasPermission(user, "patient.view")).toBe(false);
  });
});
