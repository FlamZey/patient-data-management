import { render, screen, waitFor, within } from "@testing-library/react";
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

const apiGetMock = jest.fn();
const apiDeleteMock = jest.fn();
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
    apiDelete: (...args: unknown[]) => apiDeleteMock(...args),
    ApiError: MockApiError,
  };
});

// UserFormDialog pulls in its own apiPost/apiPatch and a fair amount of
// form machinery already covered by its own unit tests -- stub it here so
// dashboard tests only exercise the dashboard's own wiring (open/close,
// which callback fires, save-merges-into-table).
jest.mock("@/components/UserFormDialog", () => {
  const MockUserFormDialog = (props: {
    mode: string;
    user?: { id: string; first_name: string; last_name: string };
    onClose: () => void;
    onSaved: (user: unknown) => void;
  }) => (
    <div data-testid="user-form-dialog">
      <span>mode:{props.mode}</span>
      <button onClick={props.onClose}>dialog-close</button>
      <button
        onClick={() =>
          props.onSaved(
            props.mode === "edit" && props.user
              ? { ...props.user, first_name: "Updated" }
              : { ...NEW_USER },
          )
        }
      >
        dialog-save
      </button>
    </div>
  );
  MockUserFormDialog.displayName = "UserFormDialog";
  return MockUserFormDialog;
});

import DashboardPage from "@/app/dashboard/page";
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

describe("app/dashboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([]);
      if (path === "/roles") return Promise.resolve([]);
      if (path === "/locations") return Promise.resolve([]);
      if (path === "/teams") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  it("redirects to /home and renders nothing when the user lacks user.view", async () => {
    setCurrentUser(makeUser({ role: { ...makeUser().role, permissions: [] } }));
    const { container } = render(<DashboardPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/home"));
    expect(container.querySelector("table")).not.toBeInTheDocument();
  });

  it("shows a loading pulse then an empty state when there are no users", async () => {
    setCurrentUser(makeUser());
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());
  });

  it("shows an error state with a retry button when loading users fails", async () => {
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.reject(new Error("network down"));
      return Promise.resolve([]);
    });

    render(<DashboardPage />);

    expect(await screen.findByText("Couldn't load users.")).toBeInTheDocument();
  });

  it("retries loading users when Retry is clicked", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    let usersCallCount = 0;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") {
        usersCallCount += 1;
        return usersCallCount === 1 ? Promise.reject(new Error("down")) : Promise.resolve([makeUser()]);
      }
      return Promise.resolve([]);
    });

    render(<DashboardPage />);
    await screen.findByText("Couldn't load users.");

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());
  });

  it("renders a table of users with role, location, team, and status", async () => {
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser({ team: { id: 1, code: "T1", name: "Team One", description: null, is_active: true } })]);
      return Promise.resolve([]);
    });

    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());
    const row = within(screen.getByRole("table"));
    expect(row.getByText("a@b.com")).toBeInTheDocument();
    expect(row.getByText("Admin")).toBeInTheDocument();
    expect(row.getByText("Location One")).toBeInTheDocument();
    expect(row.getByText("Team One")).toBeInTheDocument();
    expect(row.getByText("active")).toBeInTheDocument();
  });

  it("shows Unassigned for a user with no team", async () => {
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser({ team: null })]);
      return Promise.resolve([]);
    });

    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText("Unassigned")).toBeInTheDocument());
  });

  it("hides the Add user button and Actions column without create/edit/delete permissions", async () => {
    setCurrentUser(makeUser({ role: { ...makeUser().role, permissions: [VIEW_PERMISSION] } }));
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser()]);
      return Promise.resolve([]);
    });

    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Add user" })).not.toBeInTheDocument();
    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
  });

  it("opens the create dialog and merges the saved user into the table", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(screen.getByText("mode:create")).toBeInTheDocument();

    await user.click(screen.getByText("dialog-save"));

    await waitFor(() => expect(screen.getByText("Grace Hopper")).toBeInTheDocument());
    expect(screen.queryByTestId("user-form-dialog")).not.toBeInTheDocument();
  });

  it("closes the dialog without saving when onClose fires", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add user" }));
    await user.click(screen.getByText("dialog-close"));

    expect(screen.queryByTestId("user-form-dialog")).not.toBeInTheDocument();
  });

  it("replaces the existing row in place when editing and saving", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser(), SECOND_USER]);
      return Promise.resolve([]);
    });

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(screen.getByText("mode:edit")).toBeInTheDocument();

    await user.click(screen.getByText("dialog-save"));

    // The edited row updates in place; the untouched second row (matched
    // by the map's `: row` branch) is left exactly as it was.
    await waitFor(() => expect(screen.getByText("Updated Lovelace")).toBeInTheDocument());
    expect(screen.getByText("Marie Curie")).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 data rows, not appended
  });

  it("prepends a newly created user to the table", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser()]);
      return Promise.resolve([]);
    });

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Add user" }));
    await user.click(screen.getByText("dialog-save"));

    await waitFor(() => expect(screen.getByText("Grace Hopper")).toBeInTheDocument());
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 data rows
  });

  it("suspends a user via the confirm dialog and updates their status in place", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser(), SECOND_USER]);
      return Promise.resolve([]);
    });
    apiDeleteMock.mockResolvedValueOnce(undefined);

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getAllByRole("button", { name: "Suspend" })[0]);
    expect(screen.getByText("Suspend this user?")).toBeInTheDocument();

    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Suspend" }));

    await waitFor(() => expect(apiDeleteMock).toHaveBeenCalledWith("/users/1"));
    // The suspended row's status flips; the other row (the map's `: row`
    // branch) keeps its original status untouched.
    await waitFor(() => expect(screen.getByText("suspended")).toBeInTheDocument());
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.queryByText("Suspend this user?")).not.toBeInTheDocument();
  });

  it("hides the Suspend action for a user who is already suspended", async () => {
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser({ status: "suspended" })]);
      return Promise.resolve([]);
    });

    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Suspend" })).not.toBeInTheDocument();
  });

  it("shows a delete error and keeps the dialog open when suspension fails", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser()]);
      return Promise.resolve([]);
    });
    apiDeleteMock.mockRejectedValueOnce(new MockApiError(500, null));

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Suspend" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Suspend" }));

    expect(await screen.findByText("Could not suspend this user. Please try again.")).toBeInTheDocument();
  });

  it("shows a delete error for a non-ApiError failure", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser()]);
      return Promise.resolve([]);
    });
    apiDeleteMock.mockRejectedValueOnce(new Error("network down"));

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Suspend" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Suspend" }));

    expect(await screen.findByText("Could not suspend this user. Please try again.")).toBeInTheDocument();
  });

  it("closes and reloads the list when suspension 404s (user already gone)", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    let usersCallCount = 0;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") {
        usersCallCount += 1;
        return Promise.resolve(usersCallCount === 1 ? [makeUser()] : []);
      }
      return Promise.resolve([]);
    });
    apiDeleteMock.mockRejectedValueOnce(new MockApiError(404, null));

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Suspend" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Suspend" }));

    await waitFor(() => expect(screen.queryByText("Suspend this user?")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());
  });

  it("cancels the suspend confirmation without deleting", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser()]);
      return Promise.resolve([]);
    });

    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("a@b.com")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Suspend" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Suspend this user?")).not.toBeInTheDocument();
    expect(apiDeleteMock).not.toHaveBeenCalled();
  });

  it("swallows failures loading roles/locations/teams without a page-level error", async () => {
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([]);
      return Promise.reject(new Error("dropdown data unavailable"));
    });

    render(<DashboardPage />);

    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());
    expect(screen.queryByText("Couldn't load users.")).not.toBeInTheDocument();
  });

  it("falls back to a muted style for an unrecognized status", async () => {
    setCurrentUser(makeUser());
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") return Promise.resolve([makeUser({ status: "archived" })]);
      return Promise.resolve([]);
    });

    render(<DashboardPage />);

    const badge = await screen.findByText("archived");
    expect(badge.className).toContain("bg-muted/15");
  });

  it("does not error when saving a new user before the list has finished loading", async () => {
    const user = userEvent.setup();
    setCurrentUser(makeUser());
    let resolveUsers!: (users: UserRead[]) => void;
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/users") {
        return new Promise((resolve) => {
          resolveUsers = resolve;
        });
      }
      return Promise.resolve([]);
    });

    render(<DashboardPage />);
    await user.click(screen.getByRole("button", { name: "Add user" }));
    await user.click(screen.getByText("dialog-save"));

    expect(screen.queryByTestId("user-form-dialog")).not.toBeInTheDocument();

    resolveUsers([]);
    await waitFor(() => expect(screen.getByText("No users found.")).toBeInTheDocument());
  });

  it("renders nothing while currentUser is not yet available", () => {
    useAuthMock.mockReturnValue({ currentUser: null, isLoading: true });
    const { container } = render(<DashboardPage />);
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });
});
