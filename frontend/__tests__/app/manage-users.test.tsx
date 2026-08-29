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
import type { UserRead } from "@/lib/types";

const { ApiError: MockApiError } = jest.requireMock("@/lib/api") as {
  ApiError: new (status: number, body: unknown) => Error;
};

const VIEW_PERMISSION = { id: 1, code: "user.view", resource: "user", action: "view", description: null };
const CREATE_PERMISSION = { id: 2, code: "user.create", resource: "user", action: "create", description: null };
const EDIT_PERMISSION = { id: 3, code: "user.edit", resource: "user", action: "edit", description: null };
const DELETE_PERMISSION = { id: 4, code: "user.delete", resource: "user", action: "delete", description: null };

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
      permissions: [VIEW_PERMISSION, CREATE_PERMISSION, EDIT_PERMISSION, DELETE_PERMISSION],
    },
    location: { id: 1, code: "L1", name: "Location One", is_active: true },
    team: null,
    ...overrides,
  };
}

const NEW_USER = makeUser({ id: "2", first_name: "Grace", last_name: "Hopper" });
const SECOND_USER = makeUser({ id: "3", email: "c@d.com", first_name: "Marie", last_name: "Curie" });

function setCurrentUser(user: UserRead | null) {
  useAuthMock.mockReturnValue({ currentUser: user, isLoading: false, logout: jest.fn() });
}

describe("app/manage-users", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiGetUsersMock.mockResolvedValue({ items: [], total: 0 });
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
    setCurrentUser(makeUser());
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
    setCurrentUser(makeUser());
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
    setCurrentUser(makeUser());
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
    setCurrentUser(makeUser());
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
    setCurrentUser(makeUser());
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
    setCurrentUser(makeUser());
    apiGetUsersMock.mockResolvedValue({ items: [makeUser()], total: 1 });

    render(<ManageUsersPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const firstNameInput = screen.getByPlaceholderText("First name");
    await user.clear(firstNameInput);
    await user.type(firstNameInput, "Changed");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Scoped to the table -- NavBar also renders the current user's own
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
});
