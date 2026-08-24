import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiPostMock = jest.fn();
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
    apiPost: (...args: unknown[]) => apiPostMock(...args),
    apiPatch: (...args: unknown[]) => apiPatchMock(...args),
    ApiError: MockApiError,
  };
});

const { ApiError: MockApiError } = jest.requireMock("@/lib/api") as { ApiError: new (status: number, body: unknown) => Error };

import UserFormDialog from "@/components/UserFormDialog";
import type { LocationRead, RoleRead, TeamRead, UserRead } from "@/lib/types";

const ROLES: RoleRead[] = [
  { id: 1, name: "admin", display_name: "Admin", parent_role_id: null, description: null, is_active: true, permissions: [] },
];
const LOCATIONS: LocationRead[] = [{ id: 1, code: "L1", name: "Location One", is_active: true }];
const TEAMS: TeamRead[] = [{ id: 1, code: "T1", name: "Team One", description: null, is_active: true }];

const EXISTING_USER: UserRead = {
  id: "abcdef12-3456-7890-abcd-ef1234567890",
  email: "existing@b.com",
  username: "existing",
  first_name: "Grace",
  last_name: "Hopper",
  status: "active",
  failed_login_count: 0,
  locked_until: null,
  last_login_at: null,
  password_changed_at: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  role: ROLES[0],
  location: LOCATIONS[0],
  team: TEAMS[0],
};

function setup(overrides: Partial<React.ComponentProps<typeof UserFormDialog>> = {}) {
  const onClose = jest.fn();
  const onSaved = jest.fn();
  const utils = render(
    <UserFormDialog
      mode="create"
      roles={ROLES}
      locations={LOCATIONS}
      teams={TEAMS}
      onClose={onClose}
      onSaved={onSaved}
      {...overrides}
    />,
  );
  return { onClose, onSaved, ...utils };
}

// The Field component doesn't wire htmlFor/id, so getByLabelText won't
// resolve -- fall back to locating inputs by their preceding label text.
function getFieldInput(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  const field = label.parentElement!;
  const input = field.querySelector("input, select");
  if (!input) throw new Error(`No input found for field "${labelText}"`);
  return input as HTMLElement;
}

async function fillCreateForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(getFieldInput("First name"), "Ada");
  await user.type(getFieldInput("Last name"), "Lovelace");
  await user.type(getFieldInput("Email"), "ada@example.com");
  await user.type(getFieldInput("Username"), "ada");
  await user.type(getFieldInput("Password"), "password1!");
  await user.selectOptions(getFieldInput("Role"), "1");
  await user.selectOptions(getFieldInput("Location"), "1");
}

describe("components/UserFormDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders create-mode fields including password, with correct title and eyebrow", () => {
    setup();
    expect(screen.getByText("Add user")).toBeInTheDocument();
    expect(screen.getByText("New record")).toBeInTheDocument();
    expect(getFieldInput("Password")).toBeInTheDocument();
  });

  it("renders edit-mode fields without a password field, prefilled from the user", () => {
    setup({ mode: "edit", user: EXISTING_USER });
    expect(screen.getByText("Edit Grace Hopper")).toBeInTheDocument();
    expect(screen.getByText("Editing record #abcdef12")).toBeInTheDocument();
    expect(screen.queryByText("Password")).not.toBeInTheDocument();
    expect(getFieldInput("Email")).toHaveValue("existing@b.com");
    expect(getFieldInput("Team")).toHaveValue("1");
  });

  it("defaults Team to Unassigned when the user has none", () => {
    setup({ mode: "edit", user: { ...EXISTING_USER, team: null } });
    expect(getFieldInput("Team")).toHaveValue("");
  });

  it("shows validation errors and does not submit when required fields are empty", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: "Create user" }));

    expect(screen.getByText("Email is required.")).toBeInTheDocument();
    expect(screen.getByText("Username is required.")).toBeInTheDocument();
    expect(screen.getByText("First name is required.")).toBeInTheDocument();
    expect(screen.getByText("Last name is required.")).toBeInTheDocument();
    expect(screen.getByText("Role is required.")).toBeInTheDocument();
    expect(screen.getByText("Location is required.")).toBeInTheDocument();
    expect(screen.getByText("Must be at least 8 characters.")).toBeInTheDocument();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid email address", async () => {
    const user = userEvent.setup();
    setup();
    await user.type(getFieldInput("Email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Create user" }));
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
  });

  it.each([
    ["short1", "Must be at least 8 characters."],
    ["longenough", "Must contain at least one number."],
    ["12345678", "Must contain at least one letter."],
    ["longenough1", "Must contain at least one special character."],
  ])("rejects password %s with %s", async (password, message) => {
    const user = userEvent.setup();
    setup();
    await user.type(getFieldInput("Password"), password);
    await user.click(screen.getByRole("button", { name: "Create user" }));
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("does not validate password in edit mode", async () => {
    const user = userEvent.setup();
    apiPatchMock.mockResolvedValueOnce(EXISTING_USER);
    setup({ mode: "edit", user: EXISTING_USER });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(apiPatchMock).toHaveBeenCalled());
  });

  it("clears a field's error as soon as it is edited", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Create user" }));
    expect(screen.getByText("Email is required.")).toBeInTheDocument();

    await user.type(getFieldInput("Email"), "a");
    expect(screen.queryByText("Email is required.")).not.toBeInTheDocument();
  });

  it("submits a create request with trimmed values and null team when unset", async () => {
    const user = userEvent.setup();
    const saved = { ...EXISTING_USER, id: "new-id" };
    apiPostMock.mockResolvedValueOnce(saved);
    const { onSaved } = setup();

    await user.type(getFieldInput("First name"), "  Ada ");
    await user.type(getFieldInput("Last name"), "  Lovelace ");
    await user.type(getFieldInput("Email"), " ada@example.com ");
    await user.type(getFieldInput("Username"), " ada ");
    await user.type(getFieldInput("Password"), "password1!");
    await user.selectOptions(getFieldInput("Role"), "1");
    await user.selectOptions(getFieldInput("Location"), "1");

    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(apiPostMock).toHaveBeenCalledWith("/users", {
      email: "ada@example.com",
      username: "ada",
      password: "password1!",
      first_name: "Ada",
      last_name: "Lovelace",
      role_id: 1,
      location_id: 1,
      team_id: null,
    });
  });

  it("submits an edit request (no password) to the user-specific endpoint", async () => {
    const user = userEvent.setup();
    const saved = { ...EXISTING_USER, first_name: "Grace2" };
    apiPatchMock.mockResolvedValueOnce(saved);
    const { onSaved } = setup({ mode: "edit", user: EXISTING_USER });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(apiPatchMock).toHaveBeenCalledWith(`/users/${EXISTING_USER.id}`, {
      email: "existing@b.com",
      username: "existing",
      first_name: "Grace",
      last_name: "Hopper",
      role_id: 1,
      location_id: 1,
      team_id: 1,
    });
  });

  it("shows a field-level error on a 409 email conflict", async () => {
    const user = userEvent.setup();
    apiPostMock.mockRejectedValueOnce(new MockApiError(409, { detail: "Email already exists" }));
    setup();
    await fillCreateForm(user);

    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() =>
      expect(screen.getByText("This email is already in use.")).toBeInTheDocument(),
    );
  });

  it("shows a field-level error on a 409 username conflict", async () => {
    const user = userEvent.setup();
    apiPostMock.mockRejectedValueOnce(new MockApiError(409, { detail: "Username already exists" }));
    setup();
    await fillCreateForm(user);

    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() =>
      expect(screen.getByText("This username is already taken.")).toBeInTheDocument(),
    );
  });

  it("shows a generic conflict message on a 409 with an unrecognized detail", async () => {
    const user = userEvent.setup();
    apiPostMock.mockRejectedValueOnce(new MockApiError(409, { detail: "something else" }));
    setup();
    await fillCreateForm(user);

    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() =>
      expect(screen.getByText("That email or username is already in use.")).toBeInTheDocument(),
    );
  });

  it("handles a 409 with no detail body", async () => {
    const user = userEvent.setup();
    apiPostMock.mockRejectedValueOnce(new MockApiError(409, null));
    setup();
    await fillCreateForm(user);

    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() =>
      expect(screen.getByText("That email or username is already in use.")).toBeInTheDocument(),
    );
  });

  it("shows a not-found message on a 404", async () => {
    const user = userEvent.setup();
    apiPatchMock.mockRejectedValueOnce(new MockApiError(404, null));
    setup({ mode: "edit", user: EXISTING_USER });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(
        screen.getByText("This user no longer exists. Close this form and refresh the list."),
      ).toBeInTheDocument(),
    );
  });

  it("shows a generic error message for other API failures", async () => {
    const user = userEvent.setup();
    apiPostMock.mockRejectedValueOnce(new MockApiError(500, null));
    setup();
    await fillCreateForm(user);

    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() =>
      expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument(),
    );
  });

  it("shows a generic error message for a non-ApiError failure", async () => {
    const user = userEvent.setup();
    apiPostMock.mockRejectedValueOnce(new Error("network down"));
    setup();
    await fillCreateForm(user);

    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() =>
      expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument(),
    );
  });

  it("disables the submit and cancel buttons while submitting", async () => {
    const user = userEvent.setup();
    let resolveSave!: (value: UserRead) => void;
    apiPostMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    setup();
    await fillCreateForm(user);

    await user.click(screen.getByRole("button", { name: "Create user" }));

    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    resolveSave(EXISTING_USER);
    await waitFor(() => expect(screen.queryByText("Saving...")).not.toBeInTheDocument());
  });

  it("calls onClose when the Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicking the backdrop", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the dialog panel", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByText("Add user"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores non-Escape key presses", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.keyboard("{Enter}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders the Unassigned option and allows leaving team unset", () => {
    setup();
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("submits the selected team's id when a team is chosen", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValueOnce(EXISTING_USER);
    setup();
    await fillCreateForm(user);

    await user.selectOptions(getFieldInput("Team"), "1");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    expect(apiPostMock.mock.calls[0][1]).toMatchObject({ team_id: 1 });
  });
});
