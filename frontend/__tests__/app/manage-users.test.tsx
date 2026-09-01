import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const replaceMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: jest.fn() }),
}));

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...props }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
  MockLink.displayName = "Link";
  return MockLink;
});

const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

// apiGet still backs /roles, /locations, /teams -- the users list itself
// goes through apiGetUsers (server-driven sort/filter/pagination), and a
// saved inline edit through apiPatch, both mocked separately so they can be
// asserted on with the params/payload they were called with. No apiDelete:
// suspending is just an inline status edit like any other field now.
const apiGetMock = jest.fn();
const apiGetUsersMock = jest.fn();
const apiPatchMock = jest.fn();
// Asserted on directly to confirm this page never calls it -- audit-log.test.tsx
// covers the real fetch, now that the log has its own route.
const apiGetAuditLogsMock = jest.fn();
jest.mock("@/lib/api", () => {
  class MockApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super(`Request failed with status ${status}`);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  }
  return {
    apiGet: (...args: unknown[]) => apiGetMock(...args),
    apiGetUsers: (...args: unknown[]) => apiGetUsersMock(...args),
    apiGetAuditLogs: (...args: unknown[]) => apiGetAuditLogsMock(...args),
    apiPatch: (...args: unknown[]) => apiPatchMock(...args),
    ApiError: MockApiError,
  };
});

// UserFormDialog now only handles "Add user" (editing an existing row is
// inline, exercised directly against the real table below) -- it pulls in
// its own apiPost and a fair amount of form machinery already covered by
// its own unit tests, so it's stubbed here to just open/close/onSaved.
jest.mock("@/components/UserFormDialog", () => {
  const MockUserFormDialog = (props: { mode: string; onClose: () => void; onSaved: (user: unknown) => void }) => (
    <div data-testid="user-form-dialog">
      <span>mode:{props.mode}</span>
      <button onClick={props.onClose}>dialog-close</button>
      <button onClick={() => props.onSaved({ ...NEW_USER })}>dialog-save</button>
    </div>
  );
  MockUserFormDialog.displayName = "UserFormDialog";
  return MockUserFormDialog;
});

import ManageUsersPage from "@/app/manage-users/page";
import type { RoleSummary, UserRead } from "@/lib/types";

const { ApiError: MockApiError } = jest.requireMock("@/lib/api") as {
  ApiError: new (status: number, body: unknown) => Error;
};

const VIEW_PERMISSION = { id: 1, code: "user.view", resource: "user", action: "view", description: null };
const CREATE_PERMISSION = { id: 2, code: "user.create", resource: "user", action: "create", description: null };
const EDIT_PERMISSION = { id: 3, code: "user.edit", resource: "user", action: "edit", description: null };
const DELETE_PERMISSION = { id: 4, code: "user.delete", resource: "user", action: "delete", description: null };
// Privileged permissions, separate from user.edit: assigning a role and
// changing an account's status each gate their own control (see
// lib/permissions.ts / backend/app/core/authz.py).
const ROLE_ASSIGN_PERMISSION = { id: 5, code: "role.assign", resource: "role", action: "assign", description: null };
const SUSPEND_PERMISSION = { id: 6, code: "user.suspend", resource: "user", action: "suspend", description: null };
// Reading the audit log -- now a separate route (see audit-log.test.tsx).
// Held here only to assert this page doesn't render or fetch it even when
// the current user has the permission.
const AUDIT_VIEW_PERMISSION = { id: 7, code: "audit.view", resource: "audit", action: "view", description: null };

// What an administrator holds -- the default actor for these tests.
const ADMIN_PERMISSIONS = [
  VIEW_PERMISSION,
  CREATE_PERMISSION,
  EDIT_PERMISSION,
  DELETE_PERMISSION,
  ROLE_ASSIGN_PERMISSION,
  SUSPEND_PERMISSION,
];
// What a manager holds: profile edits only, no role assignment or suspension.
const MANAGER_PERMISSIONS = [VIEW_PERMISSION, EDIT_PERMISSION];

function makeUser(overrides: Partial<UserRead> = {}): UserRead {
  return {
    id: "1",
    email: "a@b.com",
    username: "a",
    first_name: "Ada",
    last_name: "Lovelace",
    status: "active",
    failed_login_count: 0,
    locked_until: null,
    last_login_at: null,
    password_changed_at: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    role: {
      id: 1,
      name: "admin",
      display_name: "Admin",
      parent_role_id: null,
      description: null,
      is_active: true,
      permissions: ADMIN_PERMISSIONS,
    },
    location: { id: 1, code: "L1", name: "Location One", is_active: true },
    team: null,
    ...overrides,
  };
}

// Mirrors backend/app/core/audit_events.py -- the API publishes this list with
// every page, and the Event column filter's options come from it rather than
// from a constant of the frontend's own.
const AUDIT_EVENT_TYPES = ["login_success", "login_failure", "patient_view", "role_change"];

const NEW_USER = makeUser({ id: "2", first_name: "Grace", last_name: "Hopper" });
const SECOND_USER = makeUser({ id: "3", email: "c@d.com", first_name: "Marie", last_name: "Curie" });

function setCurrentUser(user: UserRead | null) {
  useAuthMock.mockReturnValue({ currentUser: user, isLoading: false, logout: jest.fn() });
}

// The default actor for inline-edit tests, distinct from the row under
// test: this page hides the Edit button on your own row (see
// UserManagementTable's Actions cell), so exercising inline editing means
// acting on someone else, not on the makeUser() row itself. Its role's
// parent isn't in this suite's default (empty) /roles response, which
// leaves the rank check unresolvable and defers it to "allowed" the same
// way it does anywhere else in this suite (see permissions.ts's
// canAdministerUser) -- these tests aren't about rank, just about not
// tripping the same-rank refusal a literal peer would.
function makeActingUser(overrides: Partial<UserRead> = {}): UserRead {
  const base = makeUser(overrides);
  return { ...base, id: "actor", role: { ...base.role, parent_role_id: 999 } };
}

describe("app/manage-users", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiGetUsersMock.mockResolvedValue({ items: [], total: 0 });
    apiGetAuditLogsMock.mockResolvedValue({ items: [], total: 0, event_types: AUDIT_EVENT_TYPES });
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/roles") return Promise.resolve([]);
      if (path === "/locations") return Promise.resolve([]);
      if (path === "/teams") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  // Redirects to /home and renders nothing when the user lacks user.view.
  it("redirects to /home and renders nothing when the user lacks user.view", async () => {
    setCurrentUser(makeUser({ role: { ...makeUser().role, permissions: [] } }));
    const { container } = render(<ManageUsersPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/home"));
    expect(container.querySelector("table")).not.toBeInTheDocument();
  });

  // Shows a loading pulse then an empty state when there are no users.
  it("shows a loading pulse then an empty state when there are no users", async () => {
    setCurrentUser(makeUser());
    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());
  });

  // Shows an error state with a retry button when loading users fails.
  it("shows an error state with a retry button when loading users fails", async () => {
    setCurrentUser(makeUser());
    apiGetUsersMock.mockRejectedValue(new Error("network down"));

    render(<ManageUsersPage />);

    expect(await screen.findByText("Couldn't load users.")).toBeInTheDocument();
  });

  // Retries loading users when Retry is clicked.
  it("retries loading users when Retry is clicked", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    let callCount = 0;
    apiGetUsersMock.mockImplementation(() => {
      callCount += 1;
      return callCount === 1
        ? Promise.reject(new Error("down"))
        : Promise.resolve({ items: [makeUser()], total: 1 });
    });

    render(<ManageUsersPage />);
    await screen.findByText("Couldn't load users.");

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());
  });

  // Renders a table of users with role, location, team, and status.
  it("renders a table of users with role, location, team, and status", async () => {
    setCurrentUser(makeUser());
    apiGetUsersMock.mockResolvedValue({
      items: [makeUser({ team: { id: 1, code: "T1", name: "Team One", description: null, is_active: true } })],
      total: 1,
    });

    render(<ManageUsersPage />);

    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());
    const row = within(screen.getByRole("table"));
    expect(row.getByText("a@b.com")).toBeInTheDocument();
    expect(row.getByText("Admin")).toBeInTheDocument();
    expect(row.getByText("Location One")).toBeInTheDocument();
    expect(row.getByText("Team One")).toBeInTheDocument();
    expect(row.getByText("active")).toBeInTheDocument();
  });

  // Shows Unassigned for a user with no team.
  it("shows Unassigned for a user with no team", async () => {
    setCurrentUser(makeUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser({ team: null })], total: 1 });

    render(<ManageUsersPage />);

    await waitFor(() => expect(screen.getByText("Unassigned")).toBeInTheDocument());
  });

  // Hides the Add user button and Actions column without create/edit/delete permissions.
  it("hides the Add user button and Actions column without create/edit/delete permissions", async () => {
    setCurrentUser(makeUser({ role: { ...makeUser().role, permissions: [VIEW_PERMISSION] } }));
    apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });

    render(<ManageUsersPage />);

    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Add user" })).not.toBeInTheDocument();
    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
  });

  // Opens the create dialog and closes it after a successful save.
  it("opens the create dialog and closes it after a successful save", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    // Second call is the post-create refetch -- see handleCreated, which
    // always refetches rather than merging locally (a new row's position
    // under the current sort/filter isn't knowable client-side).
    apiGetUsersMock
      .mockResolvedValueOnce({ items: [], total: 0 })
      .mockResolvedValueOnce({ items: [NEW_USER], total: 1 });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(screen.getByText("mode:create")).toBeInTheDocument();

    await user.click(screen.getByText("dialog-save"));

    await waitFor(() => expect(screen.getByText("Grace Hopper")).toBeInTheDocument());
    expect(screen.queryByTestId("user-form-dialog")).not.toBeInTheDocument();
  });

  // Closes the dialog without saving when onClose fires.
  it("closes the dialog without saving when onClose fires", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add user" }));
    await user.click(screen.getByText("dialog-close"));

    expect(screen.queryByTestId("user-form-dialog")).not.toBeInTheDocument();
  });

  // Replaces the existing row in place when editing and saving inline.
  it("replaces the existing row in place when editing and saving inline", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeActingUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser(), SECOND_USER], total: 2 });
    apiPatchMock.mockResolvedValueOnce({ ...makeUser(), first_name: "Updated" });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    const firstNameInput = screen.getByPlaceholderText("First name");
    await user.clear(firstNameInput);
    await user.type(firstNameInput, "Updated");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // Only the changed field pair is sent -- last_name didn't change, but
    // Name is one column, so it's always sent together with first_name.
    expect(apiPatchMock).toHaveBeenCalledWith("/users/1", { first_name: "Updated", last_name: "Lovelace" });
    // The edited row updates in place; the untouched second row is left
    // exactly as it was.
    await waitFor(() => expect(screen.getByText("Updated Lovelace")).toBeInTheDocument());
    expect(screen.getByText("Marie Curie")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 data rows, not appended
  });

  // Shows the saving state, then rolls back and shows an error when the inline save fails.
  it("shows the saving state, then rolls back and shows an error when the inline save fails", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeActingUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });
    let rejectPatch!: (err: unknown) => void;
    apiPatchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPatch = reject;
        }),
    );

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const firstNameInput = screen.getByPlaceholderText("First name");
    await user.clear(firstNameInput);
    await user.type(firstNameInput, "Updated");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // The optimistic value is already showing, and the row reads as still
    // "in flight" (a disabled Saving... button, not a plain clickable
    // Edit) rather than looking like a normal, settled row.
    await waitFor(() => expect(screen.getByText("Updated Lovelace")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();

    rejectPatch(new MockApiError(500, null));

    // Rolls back to the pre-edit value and surfaces the failure.
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeInTheDocument());
    expect(await screen.findByText("Could not save changes. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  // Refetches the list after creating a user.
  it("refetches the list after creating a user", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    apiGetUsersMock
      .mockResolvedValueOnce({ items: [makeUser()], total: 1 })
      .mockResolvedValueOnce({ items: [makeUser(), NEW_USER], total: 2 });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add user" }));
    await user.click(screen.getByText("dialog-save"));

    await waitFor(() => expect(screen.getByText("Grace Hopper")).toBeInTheDocument());
    // Bypasses the request-dedup guard (see handleCreated) -- a real
    // second network call, not a locally-merged row.
    expect(apiGetUsersMock).toHaveBeenCalledTimes(2);
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 data rows
  });

  // Changes a user's status inline and saves.
  it("changes a user's status inline and saves", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeActingUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser(), SECOND_USER], total: 2 });
    apiPatchMock.mockResolvedValueOnce({ ...makeUser(), status: "suspended" });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    // The Status <select> has no label of its own (same as Role/Location/
    // Team) -- its current selection is what makes it findable.
    await user.selectOptions(screen.getByDisplayValue("active"), "suspended");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(apiPatchMock).toHaveBeenCalledWith("/users/1", { status: "suspended" });
    // The edited row's status flips; the untouched second row keeps its
    // original status.
    await waitFor(() => expect(screen.getByText("suspended")).toBeInTheDocument());
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  // Can reactivate a suspended user via inline status edit.
  it("can reactivate a suspended user via inline status edit", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeActingUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser({ status: "suspended" })], total: 1 });
    apiPatchMock.mockResolvedValueOnce({ ...makeUser(), status: "active" });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("suspended")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.selectOptions(screen.getByDisplayValue("suspended"), "active");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(apiPatchMock).toHaveBeenCalledWith("/users/1", { status: "active" });
    await waitFor(() => expect(screen.getByText("active")).toBeInTheDocument());
  });

  // Shows a specific message when the user was deleted elsewhere during an inline save.
  it("shows a specific message when the user was deleted elsewhere during an inline save", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeActingUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });
    apiPatchMock.mockRejectedValueOnce(new MockApiError(404, null));

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("This user no longer exists. Refresh to update the list.")).toBeInTheDocument();
  });

  // Discards changes when Cancel is clicked instead of saving.
  it("discards changes when Cancel is clicked instead of saving", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeActingUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const firstNameInput = screen.getByPlaceholderText("First name");
    await user.clear(firstNameInput);
    await user.type(firstNameInput, "Changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Scoped to the table -- Sidebar also renders the current user's own
    // name ("Ada Lovelace" here, same as the row being edited).
    expect(within(screen.getByRole("table")).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("First name")).not.toBeInTheDocument();
    expect(apiPatchMock).not.toHaveBeenCalled();
  });

  // Swallows failures loading roles/locations/teams without a page-level error.
  it("swallows failures loading roles/locations/teams without a page-level error", async () => {
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => Promise.reject(new Error(`dropdown data unavailable: ${path}`)));

    render(<ManageUsersPage />);

    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());
    expect(screen.queryByText("Couldn't load users.")).not.toBeInTheDocument();
  });

  // Falls back to a muted style for an unrecognized status.
  it("falls back to a muted style for an unrecognized status", async () => {
    setCurrentUser(makeUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser({ status: "archived" })], total: 1 });

    render(<ManageUsersPage />);

    const badge = await screen.findByText("archived");
    expect(badge.className).toContain("bg-muted/15");
  });

  // Does not error when saving a new user before the list has finished loading.
  it("does not error when saving a new user before the list has finished loading", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    let resolveUsers!: (value: { items: UserRead[]; total: number }) => void;
    apiGetUsersMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUsers = resolve;
        }),
    );

    render(<ManageUsersPage />);
    await user.click(screen.getByRole("button", { name: "Add user" }));
    await user.click(screen.getByText("dialog-save"));

    expect(screen.queryByTestId("user-form-dialog")).not.toBeInTheDocument();

    resolveUsers({ items: [], total: 0 });
    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());
  });

  // Renders nothing while currentUser is not yet available.
  it("renders nothing while currentUser is not yet available", () => {
    useAuthMock.mockReturnValue({ currentUser: null, isLoading: true });
    const { container } = render(<ManageUsersPage />);
    expect(container).toBeEmptyDOMElement();
  });

  // Sorts by a clicked column via the server.
  it("sorts by a clicked column via the server", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());
    expect(apiGetUsersMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort_by: "name", sort_dir: "asc" }),
    );

    await user.click(screen.getByRole("button", { name: "Email" }));

    await waitFor(() =>
      expect(apiGetUsersMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort_by: "email", sort_dir: "asc" }),
      ),
    );
  });

  // Sends a debounced name filter to the server.
  it("sends a debounced name filter to the server", async () => {
    jest.useFakeTimers();
    const user = userEvent.setup({ delay: null });
    setCurrentUser(makeUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Filter by Name" }));
    await user.type(screen.getByPlaceholderText("Filter..."), "grace");

    act(() => {
      jest.advanceTimersByTime(300);
    });

    await waitFor(() =>
      expect(apiGetUsersMock).toHaveBeenLastCalledWith(expect.objectContaining({ name: "grace" })),
    );
    jest.useRealTimers();
  });

  // Narrows by status via the checklist filter.
  it("narrows by status via the checklist filter", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Filter by Status" }));
    await user.click(screen.getByLabelText("suspended"));

    await waitFor(() =>
      expect(apiGetUsersMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: ["active", "locked", "pending"] }),
      ),
    );
  });

  // Requests the next page when Next is clicked.
  it("requests the next page when Next is clicked", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 50 });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(apiGetUsersMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });

  // --- permission-gated controls -------------------------------------------
  // These pin that the UI offers exactly what the API would allow. The
  // backend refuses a role/status change from a manager regardless (see
  // backend/tests/test_authorization.py) -- this is about not presenting a
  // control whose only possible outcome is a 403.
  describe("permission-gated controls", () => {
    function renderAsManager() {
      setCurrentUser(makeActingUser({ role: { ...makeUser().role, permissions: MANAGER_PERMISSIONS } }));
      apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });
      render(<ManageUsersPage />);
    }

    // Hides "Add user" without user.create.
    it("hides the Add user button for a manager", async () => {
      renderAsManager();
      await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Add user" })).not.toBeInTheDocument();
    });

    // Hides "Add user" when user.create is held without role.assign.
    it("hides the Add user button when user.create is held without role.assign", async () => {
      setCurrentUser(
        makeUser({ role: { ...makeUser().role, permissions: [VIEW_PERMISSION, CREATE_PERMISSION, EDIT_PERMISSION] } }),
      );
      apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });
      render(<ManageUsersPage />);
      await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());
      expect(screen.queryByRole("button", { name: "Add user" })).not.toBeInTheDocument();
    });

    // A manager still gets the inline edit affordance for profile fields.
    it("still offers inline editing of profile fields to a manager", async () => {
      const user = userEvent.setup();
      renderAsManager();
      await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Edit" }));
      expect(screen.getByDisplayValue("a@b.com")).toBeInTheDocument();
    });

    // The Status control stays read-only for a manager.
    it("does not turn Status into a select for a manager", async () => {
      const user = userEvent.setup();
      renderAsManager();
      await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Edit" }));
      // An admin's edit row exposes this as a <select> whose current value is
      // "active" (see "changes a user's status inline and saves" above).
      expect(screen.queryByDisplayValue("active")).not.toBeInTheDocument();
      expect(screen.getByText("active")).toBeInTheDocument();
    });

    // The Role control stays read-only for a manager.
    it("does not turn Role into a select for a manager", async () => {
      const user = userEvent.setup();
      apiGetMock.mockImplementation((path: string) => {
        if (path === "/roles") return Promise.resolve([makeUser().role]);
        if (path === "/locations") return Promise.resolve([]);
        if (path === "/teams") return Promise.resolve([]);
        return Promise.reject(new Error(`unexpected path ${path}`));
      });
      renderAsManager();
      await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Edit" }));
      expect(screen.queryByDisplayValue("Admin")).not.toBeInTheDocument();
      // "Admin" also appears as a Role checklist-filter option, so the cell's
      // plain-text rendering is one of several matches rather than the only one.
      expect(screen.getAllByText("Admin").length).toBeGreaterThan(0);
    });

    // A manager's inline save never sends role_id or status.
    it("omits role_id and status from a manager's inline save", async () => {
      const user = userEvent.setup();
      renderAsManager();
      apiPatchMock.mockResolvedValueOnce({ ...makeUser(), first_name: "Renamed" });
      await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Edit" }));
      await user.clear(screen.getByDisplayValue("Ada"));
      await user.type(screen.getByPlaceholderText("First name"), "Renamed");
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(apiPatchMock).toHaveBeenCalled());
      const [, body] = apiPatchMock.mock.calls[0];
      expect(body).not.toHaveProperty("role_id");
      expect(body).not.toHaveProperty("status");
      expect(body).toMatchObject({ first_name: "Renamed" });
    });

    // Someone holding only user.view gets no edit affordance at all.
    it("hides the Actions column entirely for a view-only account", async () => {
      setCurrentUser(makeUser({ role: { ...makeUser().role, permissions: [VIEW_PERMISSION] } }));
      apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });
      render(<ManageUsersPage />);
      await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

      expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
      expect(screen.queryByText("Actions")).not.toBeInTheDocument();
    });

    // user.suspend alone still exposes the Status select.
    it("exposes the Status select to an account holding only user.suspend", async () => {
      const user = userEvent.setup();
      setCurrentUser(
        makeActingUser({ role: { ...makeUser().role, permissions: [VIEW_PERMISSION, SUSPEND_PERMISSION] } }),
      );
      apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });
      render(<ManageUsersPage />);
      await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Edit" }));
      expect(screen.getByDisplayValue("active")).toBeInTheDocument();
      // ...but not the profile inputs, which need user.edit.
      expect(screen.queryByDisplayValue("a@b.com")).not.toBeInTheDocument();
    });
  });


  // Audit log moved to its own route (/audit-log, see audit-log.test.tsx) --
  // this page no longer renders or fetches it at all.
  it("does not render or fetch the audit log, even for an account holding audit.view", async () => {
    setCurrentUser(
      makeUser({ role: { ...makeUser().role, permissions: [...ADMIN_PERMISSIONS, AUDIT_VIEW_PERMISSION] } }),
    );
    apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });
    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    expect(screen.queryByRole("heading", { name: "Audit log" })).not.toBeInTheDocument();
    expect(apiGetAuditLogsMock).not.toHaveBeenCalled();
  });

  // --- per-row edit gating (role hierarchy) --------------------------------
  // Permission gating above is global ("may you edit users at all"); this is
  // the per-row half, mirroring authz.assert_can_administer: authority runs
  // strictly downward, so peers and seniors are refused no matter which
  // permissions the caller holds. The two compose -- the Actions column still
  // needs a permission to exist at all, and only then is each row ranked.
  describe("per-row edit gating", () => {
    // A realistic chain: Admin(1) <- Manager(2) <- User(3).
    // Typed as RoleSummary rather than inferred: the root's `parent_role_id:
    // null` would otherwise be inferred as the literal type `null`, which the
    // children (whose parent is a number) don't satisfy.
    const ADMIN_ROLE: RoleSummary = { id: 1, name: "admin", display_name: "Admin", parent_role_id: null, description: null, is_active: true };
    const MANAGER_ROLE: RoleSummary = { id: 2, name: "manager", display_name: "Manager", parent_role_id: 1, description: null, is_active: true };
    const USER_ROLE: RoleSummary = { id: 3, name: "user", display_name: "User", parent_role_id: 2, description: null, is_active: true };
    const HIERARCHY: RoleSummary[] = [ADMIN_ROLE, MANAGER_ROLE, USER_ROLE];

    function rowWith(id: string, email: string, role: RoleSummary): UserRead {
      return makeUser({ id, email, role: { ...role, permissions: [] } });
    }

    // Serves the role hierarchy so the rank walk can resolve every chain.
    function withHierarchy() {
      apiGetMock.mockImplementation((path: string) => {
        if (path === "/roles") return Promise.resolve(HIERARCHY);
        if (path === "/locations") return Promise.resolve([]);
        if (path === "/teams") return Promise.resolve([]);
        return Promise.reject(new Error(`unexpected path ${path}`));
      });
    }

    function editButtons() {
      return screen.queryAllByRole("button", { name: "Edit" });
    }

    // A manager gets no Edit on an admin's row.
    it("gives a manager no Edit button on an admin row", async () => {
      withHierarchy();
      setCurrentUser(makeUser({ id: "mgr", email: "mgr@b.com", role: { ...MANAGER_ROLE, permissions: MANAGER_PERMISSIONS } }));
      apiGetUsersMock.mockResolvedValue({ items: [rowWith("adm", "admin-row@b.com", ADMIN_ROLE)], total: 1 });

      render(<ManageUsersPage />);
      await waitFor(() => expect(screen.getByText("admin-row@b.com")).toBeInTheDocument());
      await waitFor(() => expect(editButtons()).toHaveLength(0));
    });

    // A manager gets no Edit on a peer manager's row -- lateral edits are refused.
    it("gives a manager no Edit button on a peer manager row", async () => {
      withHierarchy();
      setCurrentUser(makeUser({ id: "mgr", email: "mgr@b.com", role: { ...MANAGER_ROLE, permissions: MANAGER_PERMISSIONS } }));
      apiGetUsersMock.mockResolvedValue({ items: [rowWith("mgr2", "peer@b.com", MANAGER_ROLE)], total: 1 });

      render(<ManageUsersPage />);
      await waitFor(() => expect(screen.getByText("peer@b.com")).toBeInTheDocument());
      await waitFor(() => expect(editButtons()).toHaveLength(0));
    });

    // Authority still runs downward: a manager can edit a standard user.
    it("gives a manager an Edit button on a row below them", async () => {
      withHierarchy();
      setCurrentUser(makeUser({ id: "mgr", email: "mgr@b.com", role: { ...MANAGER_ROLE, permissions: MANAGER_PERMISSIONS } }));
      apiGetUsersMock.mockResolvedValue({ items: [rowWith("usr", "below@b.com", USER_ROLE)], total: 1 });

      render(<ManageUsersPage />);
      await waitFor(() => expect(screen.getByText("below@b.com")).toBeInTheDocument());
      await waitFor(() => expect(editButtons()).toHaveLength(1));
    });

    // canAdministerUser exempts self from the rank test, but this page hides
    // Edit on your own row regardless -- its edit bundles role/status
    // alongside profile fields, and self role/status changes are
    // unconditionally refused server-side, so offering it would just be
    // controls that always 403 (see UserManagementTable's Actions cell).
    it("gives a manager no Edit button on their own row", async () => {
      withHierarchy();
      const me = makeUser({ id: "mgr", email: "mgr@b.com", role: { ...MANAGER_ROLE, permissions: MANAGER_PERMISSIONS } });
      setCurrentUser(me);
      apiGetUsersMock.mockResolvedValue({ items: [me], total: 1 });

      render(<ManageUsersPage />);
      await waitFor(() => expect(screen.getByText("mgr@b.com")).toBeInTheDocument());
      await waitFor(() => expect(editButtons()).toHaveLength(0));
    });

    // The top role has no peers it can administer either.
    it("gives an admin no Edit button on another admin's row", async () => {
      withHierarchy();
      setCurrentUser(makeUser({ id: "adm1", email: "adm1@b.com" }));
      apiGetUsersMock.mockResolvedValue({ items: [rowWith("adm2", "other-admin@b.com", ADMIN_ROLE)], total: 1 });

      render(<ManageUsersPage />);
      await waitFor(() => expect(screen.getByText("other-admin@b.com")).toBeInTheDocument());
      await waitFor(() => expect(editButtons()).toHaveLength(0));
    });

    // Before /roles resolves the chain is unresolvable, so Edit stays offered
    // and the backend decides -- hiding it here would flicker a control away
    // from callers who are in fact allowed to use it.
    it("still offers Edit while the roles lookup is unresolved", async () => {
      apiGetMock.mockImplementation((path: string) => {
        if (path === "/roles") return new Promise(() => {}); // never resolves
        return Promise.resolve([]);
      });
      setCurrentUser(makeUser({ id: "mgr", email: "mgr@b.com", role: { ...MANAGER_ROLE, permissions: MANAGER_PERMISSIONS } }));
      apiGetUsersMock.mockResolvedValue({ items: [rowWith("mgr2", "peer@b.com", MANAGER_ROLE)], total: 1 });

      render(<ManageUsersPage />);
      await waitFor(() => expect(screen.getByText("peer@b.com")).toBeInTheDocument());
      expect(editButtons()).toHaveLength(1);
    });

    // A 403 says what went wrong instead of inviting a pointless retry.
    it("surfaces a permission-specific message when a save is refused with 403", async () => {
      const user = userEvent.setup();
      withHierarchy();
      setCurrentUser(makeUser({ id: "mgr", email: "mgr@b.com", role: { ...MANAGER_ROLE, permissions: MANAGER_PERMISSIONS } }));
      apiGetUsersMock.mockResolvedValue({ items: [rowWith("usr", "below@b.com", USER_ROLE)], total: 1 });
      apiPatchMock.mockRejectedValueOnce(new MockApiError(403, { detail: "You can only modify users whose role is below your own" }));

      render(<ManageUsersPage />);
      await waitFor(() => expect(screen.getByText("below@b.com")).toBeInTheDocument());

      await user.click(screen.getByRole("button", { name: "Edit" }));
      await user.clear(screen.getByDisplayValue("Ada"));
      await user.type(screen.getByPlaceholderText("First name"), "Changed");
      await user.click(screen.getByRole("button", { name: "Save" }));

      expect(await screen.findByText("You don't have permission to edit this user.")).toBeInTheDocument();
    });
  });

});
