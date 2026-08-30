import { hasAnyPermission, hasPermission, PERMISSIONS, userEditCapabilities } from "@/lib/permissions";
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
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
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

  // Malformed data with no permissions field reads as "no permissions".
  it("returns false when the role carries no permissions field", () => {
    // Not a legitimate shape -- UserRead.role is a RoleRead, so the types
    // guarantee `permissions`. This guards the runtime case only: responses
    // aren't validated, so a malformed payload must read as "no permissions"
    // rather than throwing inside a render.
    const user = makeUser([]);
    delete (user.role as { permissions?: unknown }).permissions;
    expect(hasPermission(user, "patient.view")).toBe(false);
  });
});

describe("lib/permissions: hasAnyPermission", () => {
  // True when at least one code is granted.
  it("returns true when at least one code is granted", () => {
    const user = makeUser(["user.edit"]);
    expect(hasAnyPermission(user, "role.assign", "user.edit")).toBe(true);
  });

  // False when none of the codes are granted.
  it("returns false when none of the codes are granted", () => {
    const user = makeUser(["user.view"]);
    expect(hasAnyPermission(user, "role.assign", "user.suspend")).toBe(false);
  });

  // False for a signed-out user.
  it("returns false for a null user", () => {
    expect(hasAnyPermission(null, "user.edit")).toBe(false);
  });
});

describe("lib/permissions: userEditCapabilities", () => {
  // user.edit alone unlocks profile fields only.
  it("treats user.edit as profile-only authority", () => {
    const caps = userEditCapabilities(makeUser([PERMISSIONS.userEdit]));
    expect(caps).toEqual({
      canEditProfile: true,
      canAssignRole: false,
      canChangeStatus: false,
      canEditAnything: true,
    });
  });

  // role.assign alone unlocks the role field only.
  it("treats role.assign as role-only authority", () => {
    const caps = userEditCapabilities(makeUser([PERMISSIONS.roleAssign]));
    expect(caps).toEqual({
      canEditProfile: false,
      canAssignRole: true,
      canChangeStatus: false,
      canEditAnything: true,
    });
  });

  // user.suspend alone unlocks the status field only.
  it("treats user.suspend as status-only authority", () => {
    const caps = userEditCapabilities(makeUser([PERMISSIONS.userSuspend]));
    expect(caps).toEqual({
      canEditProfile: false,
      canAssignRole: false,
      canChangeStatus: true,
      canEditAnything: true,
    });
  });

  // No relevant permission means no edit affordance at all.
  it("reports no edit authority when none of the three are granted", () => {
    const caps = userEditCapabilities(makeUser([PERMISSIONS.userView]));
    expect(caps.canEditAnything).toBe(false);
  });

  // An administrator holds all three.
  it("reports full authority for an administrator", () => {
    const caps = userEditCapabilities(
      makeUser([PERMISSIONS.userEdit, PERMISSIONS.roleAssign, PERMISSIONS.userSuspend]),
    );
    expect(caps).toEqual({
      canEditProfile: true,
      canAssignRole: true,
      canChangeStatus: true,
      canEditAnything: true,
    });
  });
});
