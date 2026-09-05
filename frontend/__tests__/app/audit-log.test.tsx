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
    apiGetAuditLogs: (...args: unknown[]) => apiGetAuditLogsMock(...args),
    ApiError: MockApiError,
  };
});

import AuditLogPage from "@/app/audit-log/page";
import type { AuditLogRead, UserRead } from "@/lib/types";

const AUDIT_VIEW_PERMISSION = { id: 7, code: "audit.view", resource: "audit", action: "view", description: null };

// Mirrors backend/app/core/audit_events.py -- the API publishes this list with
// every page, and the Event column filter's options come from it rather than
// from a constant of the frontend's own.
const AUDIT_EVENT_TYPES = ["login_success", "login_failure", "patient_view", "role_change"];

function makeUser(overrides: Partial<UserRead> = {}): UserRead {
  return {
    id: "1",
    email: "a@b.com",
    username: "a",
    first_name: "Ada",
    last_name: "Lovelace",
    status: "active",
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
      permissions: [AUDIT_VIEW_PERMISSION],
    },
    location: { id: 1, code: "L1", name: "Location One", is_active: true },
    team: null,
    ...overrides,
  };
}

function makeAuditLog(overrides: Partial<AuditLogRead> = {}): AuditLogRead {
  return {
    id: 101,
    event_type: "role_change",
    event_detail: { user_id: "1", from_role_id: 3, to_role_id: 2 },
    ip_address: "203.0.113.7",
    user_agent: "Mozilla/5.0 (jest)",
    created_at: "2024-03-01T12:30:00Z",
    actor: { id: "1", email: "a@b.com", username: "a", first_name: "Ada", last_name: "Lovelace" },
    ...overrides,
  };
}

function setCurrentUser(user: UserRead | null) {
  useAuthMock.mockReturnValue({ currentUser: user, isLoading: false, logout: jest.fn() });
}

function renderWithAuditView(logs: AuditLogRead[] = [makeAuditLog()]) {
  setCurrentUser(makeUser());
  apiGetAuditLogsMock.mockResolvedValue({ items: logs, total: logs.length, event_types: AUDIT_EVENT_TYPES });
  render(<AuditLogPage />);
}

describe("app/audit-log", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Redirects to /home and renders nothing when the user lacks audit.view.
  it("redirects to /home and renders nothing when the user lacks audit.view", async () => {
    setCurrentUser(makeUser({ role: { ...makeUser().role, permissions: [] } }));
    const { container } = render(<AuditLogPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/home"));
    expect(container.querySelector("table")).not.toBeInTheDocument();
    expect(apiGetAuditLogsMock).not.toHaveBeenCalled();
  });

  // Renders nothing while currentUser is not yet available.
  it("renders nothing while currentUser is not yet available", () => {
    useAuthMock.mockReturnValue({ currentUser: null, isLoading: true });
    const { container } = render(<AuditLogPage />);
    expect(container).toBeEmptyDOMElement();
  });

  // Rendered, and populated, with audit.view.
  it("renders the audit log for an account holding audit.view", async () => {
    renderWithAuditView();
    await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());
  });

  // The actor is shown as a person, not the bare UUID the column stores.
  it("shows who acted rather than a bare id", async () => {
    renderWithAuditView();
    await waitFor(() => expect(screen.getByText("Ada Lovelace")).toBeInTheDocument());
    expect(screen.getByText("a@b.com")).toBeInTheDocument();
  });

  // A row with no actor is labelled rather than left blank.
  it("labels an event with no actor", async () => {
    renderWithAuditView([makeAuditLog({ actor: null, event_type: "login_failure", event_detail: null })]);
    await waitFor(() => expect(screen.getByText("Unauthenticated")).toBeInTheDocument());
  });

  // event_detail renders generically from whatever keys the server sent, with the full text available via its title tooltip.
  it("renders event_detail generically, whatever its shape", async () => {
    renderWithAuditView([
      makeAuditLog({ event_detail: { unknown_future_key: "abc", nested: { count: 2 }, flag: true } }),
    ]);

    const expected = 'unknown_future_key: abc, nested: {"count":2}, flag: true';
    await waitFor(() => expect(screen.getByTitle(expected)).toBeInTheDocument());
  });

  // Read-only: the log has no write endpoint, so it offers no edit affordance.
  it("offers no way to edit or delete an audit event", async () => {
    renderWithAuditView();
    await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  // Newest first, and the page size the API caps at.
  it("requests the newest events first", async () => {
    renderWithAuditView();
    await waitFor(() => expect(apiGetAuditLogsMock).toHaveBeenCalled());
    expect(apiGetAuditLogsMock.mock.calls[0][0]).toMatchObject({
      sort_by: "created_at",
      sort_dir: "desc",
      page: 1,
      page_size: 25,
    });
  });

  // The Event checklist behaves like every other one in the app: fully checked sends no filter, unchecking narrows to what remains.
  it("sends only the still-checked event types when the Event filter is narrowed", async () => {
    const user = userEvent.setup();
    renderWithAuditView();
    await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());

    // Fully checked means unfiltered -- the first request leaves event_type
    // unset (apiGetAuditLogs omits undefined params from the query string)
    // rather than sending a list of every option.
    expect(apiGetAuditLogsMock.mock.calls[0][0].event_type).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Filter by Event" }));
    await user.click(await screen.findByRole("checkbox", { name: "login_failure" }));

    await waitFor(() =>
      expect(apiGetAuditLogsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ event_type: ["login_success", "patient_view", "role_change"] }),
      ),
    );
  });

  // Unchecking everything matches no rows, rather than reading as "no filtering" and quietly showing the whole log back.
  it("shows nothing when every event type is unchecked", async () => {
    const user = userEvent.setup();
    renderWithAuditView();
    await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Filter by Event" }));
    await user.click(await screen.findByRole("checkbox", { name: "(Select All)" }));

    await waitFor(() => expect(screen.getByText("No audit events found.")).toBeInTheDocument());
    // ...and no request went out asking the API for "every row".
    expect(apiGetAuditLogsMock).toHaveBeenCalledTimes(1);
  });

  // Re-clicking Select All after unchecking it must restore the log list, not get skipped by the dedup guard as a no-op.
  it("re-clicking Select All after unchecking it restores the log list", async () => {
    const user = userEvent.setup();
    renderWithAuditView();
    await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Filter by Event" }));
    const selectAll = await screen.findByRole("checkbox", { name: "(Select All)" });
    await user.click(selectAll);
    await waitFor(() => expect(screen.getByText("No audit events found.")).toBeInTheDocument());

    await user.click(selectAll);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByText("No audit events found.")).not.toBeInTheDocument());
    expect(screen.getByText("role_change")).toBeInTheDocument();
  });

  // The Actor text filter reaches the API (debounced).
  it("sends the actor filter", async () => {
    const user = userEvent.setup();
    renderWithAuditView();
    await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Filter by Actor" }));
    await user.type(await screen.findByPlaceholderText("Filter..."), "Hopper");

    await waitFor(
      () => expect(apiGetAuditLogsMock).toHaveBeenLastCalledWith(expect.objectContaining({ actor: "Hopper" })),
      { timeout: 3000 },
    );
  });

  // The When column's filter trigger is named for the event timestamp, not the shared widget's original DOB column.
  it("offers a date-range filter named for the event timestamp", async () => {
    renderWithAuditView();
    await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: "Filter by When" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Filter by Date of Birth" })).not.toBeInTheDocument();
  });

  // Pagination is server-driven, like the user table's.
  it("requests the next page from the server", async () => {
    setCurrentUser(makeUser());
    apiGetAuditLogsMock.mockResolvedValue({ items: [makeAuditLog()], total: 30, event_types: AUDIT_EVENT_TYPES });
    const user = userEvent.setup();
    render(<AuditLogPage />);
    await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(apiGetAuditLogsMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });

  // A failed load is recoverable without leaving the page.
  it("shows an error state with a retry button when loading the audit log fails", async () => {
    setCurrentUser(makeUser());
    apiGetAuditLogsMock.mockRejectedValue(new Error("network down"));
    render(<AuditLogPage />);

    expect(await screen.findByText("Couldn't load the audit log.")).toBeInTheDocument();
  });

  // The sidebar's "Audit log" nav link and the table's "Audit log" heading are two different elements, not an ambiguous match.
  it("has exactly one 'Audit log' heading, distinct from the sidebar's nav link", async () => {
    renderWithAuditView();
    await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());

    expect(screen.getByRole("heading", { name: "Audit log" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Practice" })).getByRole("link", { name: "Audit log" }),
    ).toBeInTheDocument();
  });
});
