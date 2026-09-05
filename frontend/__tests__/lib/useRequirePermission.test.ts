import { renderHook, waitFor } from "@testing-library/react";

const replaceMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: jest.fn() }),
}));

const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

import { PERMISSIONS } from "@/lib/permissions";
import { useRequirePermission } from "@/lib/useRequirePermission";
import type { UserRead } from "@/lib/types";

const VIEW_PERMISSION = { id: 1, code: "patient.view", resource: "patient", action: "view", description: null };

function makeUser(permissions: typeof VIEW_PERMISSION[] = [VIEW_PERMISSION]): UserRead {
  return {
    id: "1", email: "a@b.com", username: "a", first_name: "Ada", last_name: "Lovelace", status: "active",
    last_login_at: null, password_changed_at: null,
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
    role: { id: 1, name: "admin", display_name: "Admin", parent_role_id: null, description: null, is_active: true, permissions },
    location: { id: 1, code: "L1", name: "Location One", is_active: true },
    team: null,
  };
}

describe("lib/useRequirePermission", () => {
  beforeEach(() => {
    replaceMock.mockClear();
  });

  // Returns false and does not redirect while currentUser has not resolved yet.
  it("returns false and does not redirect while currentUser has not resolved yet", () => {
    useAuthMock.mockReturnValue({ currentUser: null });
    const { result } = renderHook(() => useRequirePermission(PERMISSIONS.patientView));
    expect(result.current).toBe(false);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // Returns true and does not redirect once the user holds the required permission.
  it("returns true and does not redirect once the user holds the required permission", () => {
    useAuthMock.mockReturnValue({ currentUser: makeUser() });
    const { result } = renderHook(() => useRequirePermission(PERMISSIONS.patientView));
    expect(result.current).toBe(true);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  // Returns false and redirects to /home once resolved without the required permission.
  it("returns false and redirects to /home once resolved without the required permission", async () => {
    useAuthMock.mockReturnValue({ currentUser: makeUser([]) });
    const { result } = renderHook(() => useRequirePermission(PERMISSIONS.patientView));
    expect(result.current).toBe(false);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/home"));
  });
});
