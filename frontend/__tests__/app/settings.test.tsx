import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
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

const logoutMock = jest.fn();
const updateCurrentUserMock = jest.fn();
const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

const apiPatchMock = jest.fn();
const apiPostMock = jest.fn();
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
    apiPatch: (...args: unknown[]) => apiPatchMock(...args),
    apiPost: (...args: unknown[]) => apiPostMock(...args),
    ApiError: MockApiError,
  };
});

import SettingsPage from "@/app/settings/page";
import type { UserRead } from "@/lib/types";

const { ApiError: MockApiError } = jest.requireMock("@/lib/api") as {
  ApiError: new (status: number, body: unknown) => Error;
};

jest.useFakeTimers({ advanceTimers: true });

const CURRENT_USER: UserRead = {
  id: "abcdef12-3456-7890-abcd-ef1234567890",
  email: "ada@example.com",
  username: "ada",
  first_name: "Ada",
  last_name: "Lovelace",
  status: "active",
  failed_login_count: 0,
  locked_until: null,
  last_login_at: "2024-06-01T12:00:00Z",
  password_changed_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  role: { id: 1, name: "admin", display_name: "Admin", parent_role_id: null, description: null, is_active: true, permissions: [] },
  location: { id: 1, code: "L1", name: "Location One", is_active: true },
  team: { id: 1, code: "T1", name: "Team One", description: null, is_active: true },
};

function renderSettings(user: UserRead | null = CURRENT_USER) {
  useAuthMock.mockReturnValue({
    currentUser: user,
    isLoading: false,
    logout: logoutMock,
    updateCurrentUser: updateCurrentUserMock,
  });
  return render(<SettingsPage />);
}

function getFieldInput(container: HTMLElement, labelText: string): HTMLElement {
  const label = within(container).getByText(labelText);
  const field = label.parentElement!;
  const input = field.querySelector("input, select");
  if (!input) throw new Error(`No input found for field "${labelText}"`);
  return input as HTMLElement;
}

// Opens the Edit name / Edit password dialog from its pencil trigger and
// returns the dialog element -- the shared first step almost every test
// below needs, now that the forms live behind a dialog instead of being
// permanently on screen.
async function openDialog(user: ReturnType<typeof userEvent.setup>, triggerLabel: string) {
  await user.click(screen.getByRole("button", { name: triggerLabel }));
  return screen.getByRole("dialog");
}

describe("app/settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe("SettingsCard", () => {
    // Renders profile fields and formatted dates.
    it("renders profile fields and formatted dates", () => {
      renderSettings();
      expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
      expect(screen.getByText("Record #abcdef12")).toBeInTheDocument();
      expect(screen.getByText("ada@example.com")).toBeInTheDocument();
      expect(screen.getByText("Team One")).toBeInTheDocument();
      // Sidebar's own avatar shows the same initials, so there are two.
      expect(screen.getAllByText("AL").length).toBeGreaterThan(0);
      expect(screen.getAllByText("active").length).toBeGreaterThan(0);
      // The password field never shows a real value, masked or otherwise.
      expect(screen.getByText("••••••••")).toBeInTheDocument();
    });

    // Shows Unassigned when the user has no team.
    it("shows Unassigned when the user has no team", () => {
      renderSettings({ ...CURRENT_USER, team: null });
      expect(screen.getByText("Unassigned")).toBeInTheDocument();
    });

    // Shows a dash for null last-login / member-since values.
    it("shows a dash for null last-login / member-since values", () => {
      renderSettings({ ...CURRENT_USER, last_login_at: null, created_at: null as unknown as string });
      expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    });

    // Falls back to a muted style for an unrecognized status.
    it("falls back to a muted style for an unrecognized status", () => {
      renderSettings({ ...CURRENT_USER, status: "archived" });
      expect(screen.getByText("archived").className).toContain("bg-muted/15");
    });

    // Falls back to an empty initial when a name part is blank.
    it("falls back to an empty initial when a name part is blank", () => {
      renderSettings({ ...CURRENT_USER, first_name: "", last_name: "" });
      expect(screen.queryByText("AL")).not.toBeInTheDocument();
    });

    // Renders nothing -- the whole card, including both edit triggers --
    // when there is no current user.
    it("renders nothing when there is no current user", () => {
      renderSettings(null);
      expect(screen.queryByText("Record #abcdef12")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Edit name" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Edit password" })).not.toBeInTheDocument();
    });
  });

  describe("EditNameDialog", () => {
    // Opens from the pencil trigger next to the name, seeded with the current values.
    it("opens from the pencil trigger, seeded with the current first/last name", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const dialog = await openDialog(user, "Edit name");
      expect(within(dialog).getByDisplayValue("Ada")).toBeInTheDocument();
      expect(within(dialog).getByDisplayValue("Lovelace")).toBeInTheDocument();
    });

    // Closes without saving via Cancel (also reachable via the × button or the backdrop).
    it("closes via Cancel without saving", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      await openDialog(user, "Edit name");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(apiPatchMock).not.toHaveBeenCalled();
    });

    // Validates required first/last name.
    it("validates required first/last name", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const dialog = await openDialog(user, "Edit name");
      await user.clear(getFieldInput(dialog, "First name"));
      await user.clear(getFieldInput(dialog, "Last name"));

      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

      expect(within(dialog).getByText("First name is required.")).toBeInTheDocument();
      expect(within(dialog).getByText("Last name is required.")).toBeInTheDocument();
      expect(apiPatchMock).not.toHaveBeenCalled();
    });

    // Submits trimmed name changes and shows a success message.
    it("submits trimmed name changes and shows a success message", async () => {
      const user = userEvent.setup({ delay: null });
      apiPatchMock.mockResolvedValueOnce({ ...CURRENT_USER, first_name: "Grace" });
      renderSettings();
      const dialog = await openDialog(user, "Edit name");

      await user.clear(getFieldInput(dialog, "First name"));
      await user.type(getFieldInput(dialog, "First name"), " Grace ");
      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(within(dialog).getByText("Profile updated.")).toBeInTheDocument());
      expect(apiPatchMock).toHaveBeenCalledWith("/auth/me", { first_name: "Grace", last_name: "Lovelace" });
      expect(updateCurrentUserMock).toHaveBeenCalledWith({ ...CURRENT_USER, first_name: "Grace" });
      // The dialog stays open showing the confirmation -- the Cancel button
      // relabels to Close rather than the dialog dismissing itself.
      expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    });

    // Clears a field error as soon as it's edited.
    it("clears a field error as soon as it's edited", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const dialog = await openDialog(user, "Edit name");
      await user.clear(getFieldInput(dialog, "First name"));
      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
      expect(within(dialog).getByText("First name is required.")).toBeInTheDocument();

      await user.type(getFieldInput(dialog, "First name"), "A");
      expect(within(dialog).queryByText("First name is required.")).not.toBeInTheDocument();
    });

    // Shows a generic error message when the update fails.
    it("shows a generic error message when the update fails", async () => {
      const user = userEvent.setup({ delay: null });
      apiPatchMock.mockRejectedValueOnce(new Error("network down"));
      renderSettings();
      const dialog = await openDialog(user, "Edit name");

      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

      expect(await within(dialog).findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    });

    // Disables the submit button while submitting.
    it("disables the submit button while submitting", async () => {
      const user = userEvent.setup({ delay: null });
      let resolveSave!: (value: UserRead) => void;
      apiPatchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
      );
      renderSettings();
      const dialog = await openDialog(user, "Edit name");

      await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
      expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeDisabled();

      resolveSave(CURRENT_USER);
      await waitFor(() => expect(within(dialog).queryByText("Saving...")).not.toBeInTheDocument());
    });
  });

  describe("ChangePasswordDialog", () => {
    // Opens from the pencil trigger next to the masked password.
    it("opens from the pencil trigger next to the password field", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      expect(within(dialog).getByRole("heading", { name: "Change password" })).toBeInTheDocument();
    });

    // Closes without saving via Cancel.
    it("closes via Cancel without saving", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      await openDialog(user, "Edit password");
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    // Requires the current password.
    it("requires the current password", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      await user.type(getFieldInput(dialog, "New password"), "password1");
      await user.type(getFieldInput(dialog, "Confirm new password"), "password1");

      await user.click(within(dialog).getByRole("button", { name: "Change password" }));

      expect(within(dialog).getByText("Current password is required.")).toBeInTheDocument();
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    // Each weak password is rejected with its specific missing-rule message.
    it.each([
      ["short1", "Must be at least 8 characters."],
      ["longenough", "Must contain at least one number."],
      ["12345678", "Must contain at least one letter."],
      ["longenough1", "Must contain at least one special character."],
    ])("rejects a weak new password %s", async (password, message) => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      await user.type(getFieldInput(dialog, "Current password"), "oldpassword1");
      await user.type(getFieldInput(dialog, "New password"), password);
      await user.type(getFieldInput(dialog, "Confirm new password"), password);

      await user.click(within(dialog).getByRole("button", { name: "Change password" }));

      expect(within(dialog).getByText(message)).toBeInTheDocument();
    });

    // Rejects a new password identical to the current password.
    it("rejects a new password identical to the current password", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      await user.type(getFieldInput(dialog, "Current password"), "samepassword1!");
      await user.type(getFieldInput(dialog, "New password"), "samepassword1!");
      await user.type(getFieldInput(dialog, "Confirm new password"), "samepassword1!");

      await user.click(within(dialog).getByRole("button", { name: "Change password" }));

      expect(
        within(dialog).getByText("New password must be different from your current password."),
      ).toBeInTheDocument();
    });

    // Requires the confirmation to match the new password.
    it("requires the confirmation to match the new password", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      await user.type(getFieldInput(dialog, "Current password"), "oldpassword1");
      await user.type(getFieldInput(dialog, "New password"), "newpassword1!");
      await user.type(getFieldInput(dialog, "Confirm new password"), "different1");

      await user.click(within(dialog).getByRole("button", { name: "Change password" }));

      expect(within(dialog).getByText("Passwords do not match.")).toBeInTheDocument();
    });

    // Clears field errors as they're edited.
    it("clears field errors as they're edited", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      await user.click(within(dialog).getByRole("button", { name: "Change password" }));
      expect(within(dialog).getByText("Current password is required.")).toBeInTheDocument();

      await user.type(getFieldInput(dialog, "Current password"), "x");
      expect(within(dialog).queryByText("Current password is required.")).not.toBeInTheDocument();

      await user.type(getFieldInput(dialog, "New password"), "y");
      await user.type(getFieldInput(dialog, "Confirm new password"), "z");
    });

    // Submits, shows a success message, and logs out after a delay.
    it("submits, shows a success message, and logs out after a delay", async () => {
      const user = userEvent.setup({ delay: null });
      apiPostMock.mockResolvedValueOnce(undefined);
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      await user.type(getFieldInput(dialog, "Current password"), "oldpassword1");
      await user.type(getFieldInput(dialog, "New password"), "newpassword1!");
      await user.type(getFieldInput(dialog, "Confirm new password"), "newpassword1!");

      await user.click(within(dialog).getByRole("button", { name: "Change password" }));

      await waitFor(() =>
        expect(
          within(dialog).getByText("Password changed. Signing you out for security — please sign in again."),
        ).toBeInTheDocument(),
      );
      expect(apiPostMock).toHaveBeenCalledWith("/auth/me/password", {
        current_password: "oldpassword1",
        new_password: "newpassword1!",
      });
      expect(within(dialog).getByRole("button", { name: "Change password" })).toBeDisabled();

      jest.advanceTimersByTime(1800);
      await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1));
    });

    // Shows a field error when the current password is wrong (401).
    it("shows a field error when the current password is wrong (401)", async () => {
      const user = userEvent.setup({ delay: null });
      apiPostMock.mockRejectedValueOnce(new MockApiError(401, null));
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      await user.type(getFieldInput(dialog, "Current password"), "wrongpassword1");
      await user.type(getFieldInput(dialog, "New password"), "newpassword1!");
      await user.type(getFieldInput(dialog, "Confirm new password"), "newpassword1!");

      await user.click(within(dialog).getByRole("button", { name: "Change password" }));

      expect(await within(dialog).findByText("Current password is incorrect.")).toBeInTheDocument();
    });

    // Shows a field error on a 400 (server-side reuse check).
    it("shows a field error on a 400 (server-side reuse check)", async () => {
      const user = userEvent.setup({ delay: null });
      apiPostMock.mockRejectedValueOnce(new MockApiError(400, null));
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      await user.type(getFieldInput(dialog, "Current password"), "oldpassword1");
      await user.type(getFieldInput(dialog, "New password"), "newpassword1!");
      await user.type(getFieldInput(dialog, "Confirm new password"), "newpassword1!");

      await user.click(within(dialog).getByRole("button", { name: "Change password" }));

      expect(
        await within(dialog).findByText("New password must be different from your current password."),
      ).toBeInTheDocument();
    });

    // Shows a generic error message for other failures.
    it("shows a generic error message for other failures", async () => {
      const user = userEvent.setup({ delay: null });
      apiPostMock.mockRejectedValueOnce(new MockApiError(500, null));
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      await user.type(getFieldInput(dialog, "Current password"), "oldpassword1");
      await user.type(getFieldInput(dialog, "New password"), "newpassword1!");
      await user.type(getFieldInput(dialog, "Confirm new password"), "newpassword1!");

      await user.click(within(dialog).getByRole("button", { name: "Change password" }));

      expect(await within(dialog).findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    });

    // Disables the submit button while submitting.
    it("disables the submit button while submitting", async () => {
      const user = userEvent.setup({ delay: null });
      let resolveSubmit!: () => void;
      apiPostMock.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
      );
      renderSettings();
      const dialog = await openDialog(user, "Edit password");
      await user.type(getFieldInput(dialog, "Current password"), "oldpassword1");
      await user.type(getFieldInput(dialog, "New password"), "newpassword1!");
      await user.type(getFieldInput(dialog, "Confirm new password"), "newpassword1!");

      await user.click(within(dialog).getByRole("button", { name: "Change password" }));
      expect(within(dialog).getByRole("button", { name: "Saving..." })).toBeDisabled();

      resolveSubmit();
      await waitFor(() => expect(within(dialog).queryByText("Saving...")).not.toBeInTheDocument());
    });
  });
});
