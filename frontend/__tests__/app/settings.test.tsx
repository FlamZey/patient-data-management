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

describe("app/settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  describe("ProfileCard", () => {
    it("renders profile fields and formatted dates", () => {
      renderSettings();
      expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
      expect(screen.getByText("Record #abcdef12")).toBeInTheDocument();
      expect(screen.getByText("ada@example.com")).toBeInTheDocument();
      expect(screen.getByText("Team One")).toBeInTheDocument();
      expect(screen.getByText("AL")).toBeInTheDocument(); // initials
      expect(screen.getAllByText("active").length).toBeGreaterThan(0);
    });

    it("shows Unassigned when the user has no team", () => {
      renderSettings({ ...CURRENT_USER, team: null });
      expect(screen.getByText("Unassigned")).toBeInTheDocument();
    });

    it("shows a dash for null last-login / member-since values", () => {
      renderSettings({ ...CURRENT_USER, last_login_at: null, created_at: null as unknown as string });
      expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
    });

    it("falls back to a muted style for an unrecognized status", () => {
      renderSettings({ ...CURRENT_USER, status: "archived" });
      expect(screen.getByText("archived").className).toContain("bg-muted/15");
    });

    it("falls back to an empty initial when a name part is blank", () => {
      renderSettings({ ...CURRENT_USER, first_name: "", last_name: "" });
      expect(screen.queryByText("AL")).not.toBeInTheDocument();
    });

    it("renders nothing when there is no current user", () => {
      const { container } = renderSettings(null);
      // ProfileCard bails out; EditProfileForm/ChangePasswordForm still render
      // their own Card shells, so just assert the profile-specific bits are gone.
      expect(screen.queryByText("Record #abcdef12")).not.toBeInTheDocument();
      expect(container).toBeTruthy();
    });
  });

  describe("EditProfileForm", () => {
    it("validates required first/last name", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const card = screen.getByRole("heading", { name: "Edit name" }).closest("div")!.parentElement!;
      await user.clear(getFieldInput(card, "First name"));
      await user.clear(getFieldInput(card, "Last name"));

      await user.click(within(card).getByRole("button", { name: "Save changes" }));

      expect(within(card).getByText("First name is required.")).toBeInTheDocument();
      expect(within(card).getByText("Last name is required.")).toBeInTheDocument();
      expect(apiPatchMock).not.toHaveBeenCalled();
    });

    it("submits trimmed name changes and shows a success message", async () => {
      const user = userEvent.setup({ delay: null });
      apiPatchMock.mockResolvedValueOnce({ ...CURRENT_USER, first_name: "Grace" });
      renderSettings();
      const card = screen.getByRole("heading", { name: "Edit name" }).closest("div")!.parentElement!;

      await user.clear(getFieldInput(card, "First name"));
      await user.type(getFieldInput(card, "First name"), " Grace ");
      await user.click(within(card).getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(within(card).getByText("Profile updated.")).toBeInTheDocument());
      expect(apiPatchMock).toHaveBeenCalledWith("/auth/me", { first_name: "Grace", last_name: "Lovelace" });
      expect(updateCurrentUserMock).toHaveBeenCalledWith({ ...CURRENT_USER, first_name: "Grace" });
    });

    it("clears a field error as soon as it's edited", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const card = screen.getByRole("heading", { name: "Edit name" }).closest("div")!.parentElement!;
      await user.clear(getFieldInput(card, "First name"));
      await user.click(within(card).getByRole("button", { name: "Save changes" }));
      expect(within(card).getByText("First name is required.")).toBeInTheDocument();

      await user.type(getFieldInput(card, "First name"), "A");
      expect(within(card).queryByText("First name is required.")).not.toBeInTheDocument();
    });

    it("shows a generic error message when the update fails", async () => {
      const user = userEvent.setup({ delay: null });
      apiPatchMock.mockRejectedValueOnce(new Error("network down"));
      renderSettings();
      const card = screen.getByRole("heading", { name: "Edit name" }).closest("div")!.parentElement!;

      await user.click(within(card).getByRole("button", { name: "Save changes" }));

      expect(await within(card).findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    });

    it("disables the submit button while submitting", async () => {
      const user = userEvent.setup({ delay: null });
      let resolveSave!: (value: UserRead) => void;
      apiPatchMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
      );
      renderSettings();
      const card = screen.getByRole("heading", { name: "Edit name" }).closest("div")!.parentElement!;

      await user.click(within(card).getByRole("button", { name: "Save changes" }));
      expect(within(card).getByRole("button", { name: "Saving..." })).toBeDisabled();

      resolveSave(CURRENT_USER);
      await waitFor(() => expect(within(card).queryByText("Saving...")).not.toBeInTheDocument());
    });
  });

  describe("ChangePasswordForm", () => {
    function getPasswordCard() {
      return screen.getByRole("heading", { name: "Change password" }).closest("div")!.parentElement!;
    }

    it("requires the current password", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const card = getPasswordCard();
      await user.type(getFieldInput(card, "New password"), "password1");
      await user.type(getFieldInput(card, "Confirm new password"), "password1");

      await user.click(within(card).getByRole("button", { name: "Change password" }));

      expect(within(card).getByText("Current password is required.")).toBeInTheDocument();
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    it.each([
      ["short1", "Must be at least 8 characters."],
      ["longenough", "Must contain at least one number."],
      ["12345678", "Must contain at least one letter."],
    ])("rejects a weak new password %s", async (password, message) => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const card = getPasswordCard();
      await user.type(getFieldInput(card, "Current password"), "oldpassword1");
      await user.type(getFieldInput(card, "New password"), password);
      await user.type(getFieldInput(card, "Confirm new password"), password);

      await user.click(within(card).getByRole("button", { name: "Change password" }));

      expect(within(card).getByText(message)).toBeInTheDocument();
    });

    it("rejects a new password identical to the current password", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const card = getPasswordCard();
      await user.type(getFieldInput(card, "Current password"), "samepassword1");
      await user.type(getFieldInput(card, "New password"), "samepassword1");
      await user.type(getFieldInput(card, "Confirm new password"), "samepassword1");

      await user.click(within(card).getByRole("button", { name: "Change password" }));

      expect(
        within(card).getByText("New password must be different from your current password."),
      ).toBeInTheDocument();
    });

    it("requires the confirmation to match the new password", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const card = getPasswordCard();
      await user.type(getFieldInput(card, "Current password"), "oldpassword1");
      await user.type(getFieldInput(card, "New password"), "newpassword1");
      await user.type(getFieldInput(card, "Confirm new password"), "different1");

      await user.click(within(card).getByRole("button", { name: "Change password" }));

      expect(within(card).getByText("Passwords do not match.")).toBeInTheDocument();
    });

    it("clears field errors as they're edited", async () => {
      const user = userEvent.setup({ delay: null });
      renderSettings();
      const card = getPasswordCard();
      await user.click(within(card).getByRole("button", { name: "Change password" }));
      expect(within(card).getByText("Current password is required.")).toBeInTheDocument();

      await user.type(getFieldInput(card, "Current password"), "x");
      expect(within(card).queryByText("Current password is required.")).not.toBeInTheDocument();

      await user.type(getFieldInput(card, "New password"), "y");
      await user.type(getFieldInput(card, "Confirm new password"), "z");
    });

    it("submits, shows a success message, and logs out after a delay", async () => {
      const user = userEvent.setup({ delay: null });
      apiPostMock.mockResolvedValueOnce(undefined);
      renderSettings();
      const card = getPasswordCard();
      await user.type(getFieldInput(card, "Current password"), "oldpassword1");
      await user.type(getFieldInput(card, "New password"), "newpassword1");
      await user.type(getFieldInput(card, "Confirm new password"), "newpassword1");

      await user.click(within(card).getByRole("button", { name: "Change password" }));

      await waitFor(() =>
        expect(
          within(card).getByText(
            "Password changed. Signing you out for security — please sign in again.",
          ),
        ).toBeInTheDocument(),
      );
      expect(apiPostMock).toHaveBeenCalledWith("/auth/me/password", {
        current_password: "oldpassword1",
        new_password: "newpassword1",
      });
      expect(within(card).getByRole("button", { name: "Change password" })).toBeDisabled();

      jest.advanceTimersByTime(1800);
      await waitFor(() => expect(logoutMock).toHaveBeenCalledTimes(1));
    });

    it("shows a field error when the current password is wrong (401)", async () => {
      const user = userEvent.setup({ delay: null });
      apiPostMock.mockRejectedValueOnce(new MockApiError(401, null));
      renderSettings();
      const card = getPasswordCard();
      await user.type(getFieldInput(card, "Current password"), "wrongpassword1");
      await user.type(getFieldInput(card, "New password"), "newpassword1");
      await user.type(getFieldInput(card, "Confirm new password"), "newpassword1");

      await user.click(within(card).getByRole("button", { name: "Change password" }));

      expect(await within(card).findByText("Current password is incorrect.")).toBeInTheDocument();
    });

    it("shows a field error on a 400 (server-side reuse check)", async () => {
      const user = userEvent.setup({ delay: null });
      apiPostMock.mockRejectedValueOnce(new MockApiError(400, null));
      renderSettings();
      const card = getPasswordCard();
      await user.type(getFieldInput(card, "Current password"), "oldpassword1");
      await user.type(getFieldInput(card, "New password"), "newpassword1");
      await user.type(getFieldInput(card, "Confirm new password"), "newpassword1");

      await user.click(within(card).getByRole("button", { name: "Change password" }));

      expect(
        await within(card).findByText("New password must be different from your current password."),
      ).toBeInTheDocument();
    });

    it("shows a generic error message for other failures", async () => {
      const user = userEvent.setup({ delay: null });
      apiPostMock.mockRejectedValueOnce(new MockApiError(500, null));
      renderSettings();
      const card = getPasswordCard();
      await user.type(getFieldInput(card, "Current password"), "oldpassword1");
      await user.type(getFieldInput(card, "New password"), "newpassword1");
      await user.type(getFieldInput(card, "Confirm new password"), "newpassword1");

      await user.click(within(card).getByRole("button", { name: "Change password" }));

      expect(await within(card).findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    });

    it("disables the submit button while submitting", async () => {
      const user = userEvent.setup({ delay: null });
      let resolveSubmit!: () => void;
      apiPostMock.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
      );
      renderSettings();
      const card = getPasswordCard();
      await user.type(getFieldInput(card, "Current password"), "oldpassword1");
      await user.type(getFieldInput(card, "New password"), "newpassword1");
      await user.type(getFieldInput(card, "Confirm new password"), "newpassword1");

      await user.click(within(card).getByRole("button", { name: "Change password" }));
      expect(within(card).getByRole("button", { name: "Saving..." })).toBeDisabled();

      resolveSubmit();
      await waitFor(() => expect(within(card).queryByText("Saving...")).not.toBeInTheDocument());
    });
  });
});
