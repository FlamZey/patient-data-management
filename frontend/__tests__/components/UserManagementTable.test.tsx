import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiGetUsersMock = jest.fn();
const apiGetMock = jest.fn();
const apiPatchMock = jest.fn();
jest.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown = null) {
      super("failed");
      this.status = status;
      this.body = body;
    }
  },
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiGetUsers: (...args: unknown[]) => apiGetUsersMock(...args),
  apiPatch: (...args: unknown[]) => apiPatchMock(...args),
}));

const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

jest.mock("@/components/UserFormDialog", () => {
  const Mock = () => null;
  Mock.displayName = "UserFormDialog";
  return Mock;
});

import UserManagementTable from "@/components/UserManagementTable";
import { ApiError } from "@/lib/api";
import type { RoleRead, LocationRead, TeamRead, UserRead } from "@/lib/types";

// __tests__/app/manage-users.test.tsx already covers UserManagementTable
// end to end through the real page for the common paths (create, generic
// inline save/rollback, status checklist filter, sort, debounced name
// filter, pagination, permission gating). This file covers the branches
// that leaves untested: the two distinct 409-conflict messages, inline
// field-level validation, role/location/team filter short-circuits, the
// request-dedup guard, and grouped name-field editing.

const EDIT_PERMISSION = { id: 1, code: "user.edit", resource: "user", action: "edit", description: null };
const CREATE_PERMISSION = { id: 2, code: "user.create", resource: "user", action: "create", description: null };

function makeUser(permissions = [EDIT_PERMISSION, CREATE_PERMISSION]): UserRead {
  return {
    id: "admin1", email: "admin@b.com", username: "admin", first_name: "Ad", last_name: "Min", status: "active",
    failed_login_count: 0, locked_until: null, last_login_at: null, password_changed_at: null,
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
    role: { id: 1, name: "admin", display_name: "Admin", parent_role_id: null, description: null, is_active: true, permissions },
    location: { id: 1, code: "US", name: "United States", is_active: true },
    team: null,
  };
}

// parent_role_id builds the seniority chain the table's per-row Edit gate walks
// (see lib/permissions.ts's canAdministerUser, mirroring the backend). Roles
// default to sitting under Admin (id 1) so a row is administrable by the
// signed-in admin -- without a parent every role would be rank 0, i.e. a peer
// of every other, and authority runs strictly downward.
function makeRole(id: number, name: string, parentRoleId: number | null = 1): RoleRead {
  return {
    id,
    name: name.toLowerCase(),
    display_name: name,
    parent_role_id: id === 1 ? null : parentRoleId,
    description: null,
    is_active: true,
    permissions: [],
  };
}

function makeRow(overrides: Partial<UserRead> = {}): UserRead {
  return {
    id: "row1", email: "user@b.com", username: "user1", first_name: "Grace", last_name: "Hopper", status: "active",
    failed_login_count: 0, locked_until: null, last_login_at: null, password_changed_at: null,
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
    role: makeRole(2, "Manager"),
    location: { id: 1, code: "US", name: "United States", is_active: true },
    team: null,
    ...overrides,
  };
}

const ROLES: RoleRead[] = [makeRole(1, "Admin"), makeRole(2, "Manager")];
const LOCATIONS: LocationRead[] = [{ id: 1, code: "US", name: "United States", is_active: true }];
const TEAMS: TeamRead[] = [{ id: 1, code: "AR", name: "Accounts Receivable", description: null, is_active: true }];

function mockLookups() {
  apiGetMock.mockImplementation((path: string) => {
    if (path === "/roles") return Promise.resolve(ROLES);
    if (path === "/locations") return Promise.resolve(LOCATIONS);
    if (path === "/teams") return Promise.resolve(TEAMS);
    return Promise.resolve([]);
  });
}

describe("components/UserManagementTable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthMock.mockReturnValue({ currentUser: makeUser() });
    mockLookups();
    apiGetUsersMock.mockResolvedValue({ items: [makeRow()], total: 1 });
  });

  describe("inline edit conflict messages", () => {
    // Shows an email-specific message when the save fails with a 409 mentioning email.
    it("shows an email-specific message when the save fails with a 409 mentioning email", async () => {
      const user = userEvent.setup();
      apiPatchMock.mockRejectedValue(new ApiError(409, { detail: "Email already in use" }));
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const emailInput = screen.getByDisplayValue("user@b.com");
      await user.clear(emailInput);
      await user.type(emailInput, "taken@b.com");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("This email is already in use.");
    });

    // Shows a username-specific message when the save fails with a 409 mentioning username.
    it("shows a username-specific message when the save fails with a 409 mentioning username", async () => {
      const user = userEvent.setup();
      apiPatchMock.mockRejectedValue(new ApiError(409, { detail: "Username already in use" }));
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const usernameInput = screen.getByDisplayValue("user1");
      await user.clear(usernameInput);
      await user.type(usernameInput, "taken");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("This username is already taken.");
    });

    // Falls back to a generic conflict message when the 409 detail names neither field.
    it("falls back to a generic conflict message when the 409 detail names neither field", async () => {
      const user = userEvent.setup();
      apiPatchMock.mockRejectedValue(new ApiError(409, { detail: "conflict" }));
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const usernameInput = screen.getByDisplayValue("user1");
      await user.clear(usernameInput);
      await user.type(usernameInput, "whatever");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByRole("alert")).toHaveTextContent("That email or username is already in use.");
    });
  });

  describe("inline edit field validation", () => {
    // Disables save and marks the input invalid when first name is cleared.
    it("disables save and marks the input invalid when first name is cleared", async () => {
      // The name column only border-highlights an invalid field (no separate
      // error text, unlike email/username/role/location/status) -- confirmed
      // by reading the column's cell renderer, not assumed.
      const user = userEvent.setup();
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const firstNameInput = screen.getByPlaceholderText("First name");
      await user.clear(firstNameInput);

      expect(firstNameInput.className).toContain("border-danger");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    // Disables save when first name is set to only an invisible zero width space.
    it("disables save when first name is set to only an invisible zero width space", async () => {
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const firstNameInput = screen.getByPlaceholderText("First name");
      fireEvent.change(firstNameInput, { target: { value: String.fromCharCode(0x200b) } });

      expect(firstNameInput.className).toContain("border-danger");
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    // Shows an invalid-format error for a malformed email without submitting.
    it("shows an invalid-format error for a malformed email without submitting", async () => {
      const user = userEvent.setup();
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const emailInput = screen.getByDisplayValue("user@b.com");
      await user.clear(emailInput);
      await user.type(emailInput, "not-an-email");

      expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      expect(apiPatchMock).not.toHaveBeenCalled();
    });

    // Groups first and last name into one changed field pair sent together as name.
    it("groups first and last name into one changed field pair sent together as name", async () => {
      const user = userEvent.setup();
      apiPatchMock.mockResolvedValue(makeRow({ first_name: "Ada" }));
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));

      const firstNameInput = screen.getByPlaceholderText("First name");
      await user.clear(firstNameInput);
      await user.type(firstNameInput, "Ada");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() =>
        expect(apiPatchMock).toHaveBeenCalledWith("/users/row1", { first_name: "Ada", last_name: "Hopper" }),
      );
    });
  });

  describe("checklist filter short circuits", () => {
    // Unchecking every role option matches zero rows without querying the server.
    it("unchecking every role option matches zero rows without querying the server", async () => {
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      apiGetUsersMock.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "Filter by Role" }));
      fireEvent.click(screen.getByLabelText("(Select All)"));

      await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());
      expect(apiGetUsersMock).not.toHaveBeenCalled();
    });

    // Unchecking every location option matches zero rows without querying the server.
    it("unchecking every location option matches zero rows without querying the server", async () => {
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      apiGetUsersMock.mockClear();

      fireEvent.click(screen.getByRole("button", { name: "Filter by Location" }));
      fireEvent.click(screen.getByLabelText("(Select All)"));

      await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());
      expect(apiGetUsersMock).not.toHaveBeenCalled();
    });

    // The team checklist includes an always-present Unassigned option alongside loaded teams.
    it("the team checklist includes an always-present Unassigned option alongside loaded teams", async () => {
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");

      fireEvent.click(screen.getByRole("button", { name: "Filter by Team" }));
      expect(screen.getByText("Accounts Receivable")).toBeInTheDocument();
      // "Unassigned" also appears as the row's own Team cell value (this
      // row has no team) -- scope to the filter popover's checkbox label.
      expect(screen.getByLabelText("Unassigned")).toBeInTheDocument();
    });
  });

  describe("request deduplication", () => {
    // Skips a redundant fetch when the lookups finish loading without changing the resolved query.
    it("skips a redundant fetch when the roles lookup resolves after the initial identical-shaped request", async () => {
      // Initial load fires once (roles/locations/teams not yet loaded, so
      // role/location aren't sent; team defaults to just "Unassigned").
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      // Lookups resolving seeds roleFilter/locationFilter/teamFilter to
      // "fully selected" -- a fresh-but-equivalent array reference, so
      // loadUsers's params serialize identically and the dedup guard must
      // skip the follow-up request rather than double-fetching.
      expect(apiGetUsersMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("stale response ordering", () => {
    // A stale response for an older, superseded filter does not overwrite a newer filter's results.
    it("a stale response for an older, superseded filter does not overwrite a newer filter's results", async () => {
      // Two distinct in-flight requests, resolved deliberately out of issue
      // order: the second (newer) filter's response arrives first, the
      // first (older, now-superseded) filter's response arrives after.
      // loadUsers claims a requestId per call and discards a response
      // whose id is no longer the latest one by the time it resolves.
      let resolveFirst!: (value: unknown) => void;
      let resolveSecond!: (value: unknown) => void;
      apiGetUsersMock
        .mockResolvedValueOnce({ items: [makeRow()], total: 1 }) // initial load
        .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));

      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");

      fireEvent.click(screen.getByRole("button", { name: "Filter by Status" }));
      fireEvent.click(screen.getByLabelText("active")); // issues the "first" (older) request
      fireEvent.click(screen.getByLabelText("suspended")); // issues the "second" (newer) request

      resolveSecond({ items: [makeRow({ id: "newer", username: "newer-user" })], total: 1 });
      await screen.findByText("newer-user");

      resolveFirst({ items: [makeRow({ id: "stale", username: "stale-user" })], total: 1 });

      await waitFor(() => expect(screen.queryByText("stale-user")).not.toBeInTheDocument());
      expect(screen.getByText("newer-user")).toBeInTheDocument();
    });
  });

  describe("permissions", () => {
    // Hides the add user button without user.create.
    it("hides the add user button without user.create", async () => {
      useAuthMock.mockReturnValue({ currentUser: makeUser([EDIT_PERMISSION]) });
      render(<UserManagementTable />);
      await screen.findByText("Grace Hopper");
      expect(screen.queryByRole("button", { name: /Add user/ })).not.toBeInTheDocument();
    });

    // Renders null before currentUser resolves.
    it("renders null before currentUser resolves", async () => {
      useAuthMock.mockReturnValue({ currentUser: null });
      const { container } = render(<UserManagementTable />);
      expect(container).toBeEmptyDOMElement();

      // The data hooks sit above the currentUser guard, so mounting still
      // fires the users request and the three lookups; their state updates
      // land regardless of what gets rendered. Let them settle inside the
      // test rather than after it, and re-assert: it's the guard, not an
      // unresolved load, that keeps the table off the page.
      await waitFor(() => {
        expect(apiGetUsersMock).toHaveBeenCalledTimes(1);
        expect(apiGetMock).toHaveBeenCalledTimes(3); // /roles, /locations, /teams
      });
      expect(container).toBeEmptyDOMElement();
    });
  });
});
