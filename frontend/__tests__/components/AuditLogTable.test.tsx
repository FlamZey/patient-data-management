import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiGetAuditLogsMock = jest.fn();
jest.mock("@/lib/api", () => ({
  apiGetAuditLogs: (...args: unknown[]) => apiGetAuditLogsMock(...args),
}));

import AuditLogTable from "@/components/AuditLogTable";
import type { AuditLogRead } from "@/lib/types";

// __tests__/app/audit-log.test.tsx already covers this component end to end
// through the real page for the common paths (permission gating, rendering,
// filters, sorting, pagination). This file covers what that leaves untested:
// the request-dedup guard, stale-response ordering, the retry dedup-guard
// reset, and the malformed-timestamp fallback -- mirroring
// UserManagementTable.test.tsx's split from manage-users.test.tsx.

const AUDIT_EVENT_TYPES = ["login_success", "role_change"];

function makeAuditLog(overrides: Partial<AuditLogRead> = {}): AuditLogRead {
  return {
    id: 101,
    event_type: "role_change",
    event_detail: null,
    ip_address: "203.0.113.7",
    user_agent: "Mozilla/5.0 (jest)",
    created_at: "2024-03-01T12:30:00Z",
    actor: { id: "1", email: "a@b.com", username: "a", first_name: "Ada", last_name: "Lovelace" },
    ...overrides,
  };
}

describe("components/AuditLogTable", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  // Renders an unparseable timestamp as-is rather than crashing.
  it("renders an unparseable timestamp as-is rather than crashing", async () => {
    apiGetAuditLogsMock.mockResolvedValue({
      items: [makeAuditLog({ created_at: "not-a-date" })],
      total: 1,
      event_types: AUDIT_EVENT_TYPES,
    });
    render(<AuditLogTable />);
    await waitFor(() => expect(screen.getByText("not-a-date")).toBeInTheDocument());
  });

  describe("request deduplication", () => {
    // Skips a redundant fetch when the event-type seed resolves without changing the resolved query.
    it("skips a redundant fetch when the event-type seed resolves without changing the resolved query", async () => {
      apiGetAuditLogsMock.mockResolvedValue({ items: [makeAuditLog()], total: 1, event_types: AUDIT_EVENT_TYPES });
      render(<AuditLogTable />);
      await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());
      // Seeding eventTypeFilter fully-checked recreates loadLogs with a
      // fresh-but-equivalent array, which must not trigger a second fetch.
      expect(apiGetAuditLogsMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("stale response ordering", () => {
    // A stale response for an older, superseded filter does not overwrite a newer filter's results.
    it("a stale response for an older, superseded filter does not overwrite a newer filter's results", async () => {
      let resolveFirst!: (value: unknown) => void;
      let resolveSecond!: (value: unknown) => void;
      apiGetAuditLogsMock
        .mockResolvedValueOnce({ items: [makeAuditLog()], total: 1, event_types: AUDIT_EVENT_TYPES }) // initial load
        .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
        .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)));

      render(<AuditLogTable />);
      await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());

      // Two distinct filters, each issuing its own real request -- unlike
      // unchecking every event type, which short-circuits without a fetch.
      fireEvent.click(screen.getByRole("button", { name: "Filter by Event" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "login_success" })); // issues the "first" (older) request
      fireEvent.click(screen.getByRole("button", { name: "Filter by Actor" }));
      fireEvent.change(screen.getByPlaceholderText("Filter..."), { target: { value: "Hopper" } }); // issues the "second" (newer) request

      resolveSecond({
        items: [makeAuditLog({ event_type: "newer_event" })],
        total: 1,
        event_types: AUDIT_EVENT_TYPES,
      });
      await screen.findByText("newer_event", {}, { timeout: 3000 }); // clears the real 300ms debounce on the actor filter

      resolveFirst({
        items: [makeAuditLog({ event_type: "stale_event" })],
        total: 1,
        event_types: AUDIT_EVENT_TYPES,
      });

      await waitFor(() => expect(screen.queryByText("stale_event")).not.toBeInTheDocument());
      expect(screen.getByText("newer_event")).toBeInTheDocument();
    });
  });

  describe("retry", () => {
    // Retrying after a failure re-fetches even though the request params haven't changed.
    it("retrying after a failure re-fetches even though the request params haven't changed", async () => {
      apiGetAuditLogsMock.mockRejectedValueOnce(new Error("network down"));
      apiGetAuditLogsMock.mockResolvedValueOnce({
        items: [makeAuditLog()],
        total: 1,
        event_types: AUDIT_EVENT_TYPES,
      });

      render(<AuditLogTable />);
      expect(await screen.findByText("Couldn't load the audit log.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.getByText("role_change")).toBeInTheDocument());
      expect(apiGetAuditLogsMock).toHaveBeenCalledTimes(2);
    });
  });
});
