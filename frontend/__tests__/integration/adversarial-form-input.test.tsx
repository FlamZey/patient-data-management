import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiPostMock = jest.fn();
const apiPatchMock = jest.fn();
jest.mock("@/lib/api", () => ({
  apiPost: (...args: unknown[]) => apiPostMock(...args),
  apiPatch: (...args: unknown[]) => apiPatchMock(...args),
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super("failed");
      this.status = status;
      this.body = body;
    }
  },
}));

// UserFormDialog reads the signed-in user's permissions to decide whether the
// Role picker is editable (role.assign) -- mocked here so these tests can run
// the dialog without an AuthProvider.
const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

const ROLE_ASSIGN_PERMISSION = {
  id: 90,
  code: "role.assign",
  resource: "role",
  action: "assign",
  description: null,
};

function authedUser(permissions = [ROLE_ASSIGN_PERMISSION]) {
  return {
    currentUser: {
      id: "actor",
      email: "actor@example.com",
      username: "actor",
      first_name: "Act",
      last_name: "Or",
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
        permissions,
      },
      location: { id: 1, code: "L1", name: "Location One", is_active: true },
      team: null,
    },
  };
}

import UserFormDialog from "@/components/UserFormDialog";
import type { LocationRead, RoleRead, TeamRead } from "@/lib/types";

const ROLES: RoleRead[] = [
  { id: 1, name: "admin", display_name: "Admin", parent_role_id: null, description: null, is_active: true, permissions: [] },
];
const LOCATIONS: LocationRead[] = [{ id: 1, code: "L1", name: "Location One", is_active: true }];
const TEAMS: TeamRead[] = [];

function getFieldInput(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  const field = label.parentElement!;
  const input = field.querySelector("input, select");
  if (!input) throw new Error(`No input found for field "${labelText}"`);
  return input as HTMLElement;
}

function setup() {
  const onClose = jest.fn();
  const onSaved = jest.fn();
  render(
    <UserFormDialog mode="create" roles={ROLES} locations={LOCATIONS} teams={TEAMS} onClose={onClose} onSaved={onSaved} />,
  );
  return { onClose, onSaved };
}

// Bad-actor-shaped text input into a real form -- this app relies on React's
// default JSX escaping plus backend validation rather than any client-side
// sanitization (see docs/security.md's "Output escaping" note), so these
// tests confirm hostile input is treated as inert literal text and never
// crashes rendering or the submit flow, not that it gets stripped/rewritten.
describe("integration: adversarial text input on UserFormDialog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default actor holds role.assign, so the Role picker renders as a
    // <select> the way it does for an administrator. Tests that care about
    // the without-role.assign case override this per test.
    useAuthMock.mockReturnValue(authedUser());
  });

  // A script tag typed into a text field is stored and submitted as literal text, never executed.
  it("a script tag typed into a text field is stored and submitted as literal text", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValue({ id: "1" });
    setup();

    const payload = "<script>window.__pwned = true</script>";
    await user.type(getFieldInput("First name"), payload);
    await user.type(getFieldInput("Last name"), "Doe");
    await user.type(getFieldInput("Email"), "a@b.com");
    await user.type(getFieldInput("Username"), "auser");
    await user.type(getFieldInput("Password"), "password1!");
    await user.selectOptions(getFieldInput("Role"), "1");
    await user.selectOptions(getFieldInput("Location"), "1");

    expect((getFieldInput("First name") as HTMLInputElement).value).toBe(payload);
    // No literal <script> element is ever parsed into the DOM -- React
    // renders the value as an input's `value` attribute/property, not as
    // markup, so nothing here can execute regardless of content.
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Create user" }));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    expect(apiPostMock).toHaveBeenCalledWith("/users", expect.objectContaining({ first_name: payload }));
  });

  // A sql-injection-shaped string is treated as an ordinary string, not special syntax.
  it("a sql injection shaped string is treated as an ordinary string", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValue({ id: "1" });
    setup();

    const payload = "Robert'); DROP TABLE users; --";
    await user.type(getFieldInput("Last name"), payload);
    await user.type(getFieldInput("First name"), "Ada");
    await user.type(getFieldInput("Email"), "a@b.com");
    await user.type(getFieldInput("Username"), "auser");
    await user.type(getFieldInput("Password"), "password1!");
    await user.selectOptions(getFieldInput("Role"), "1");
    await user.selectOptions(getFieldInput("Location"), "1");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith("/users", expect.objectContaining({ last_name: payload })));
  });

  // Whitespace-only input in a required field is treated as empty, not as a filled-in value.
  it("whitespace-only input in a required field is treated as empty", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(getFieldInput("First name"), "   ");
    await user.type(getFieldInput("Last name"), "Doe");
    await user.type(getFieldInput("Email"), "a@b.com");
    await user.type(getFieldInput("Username"), "auser");
    await user.type(getFieldInput("Password"), "password1!");
    await user.selectOptions(getFieldInput("Role"), "1");
    await user.selectOptions(getFieldInput("Location"), "1");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    expect(await screen.findByText("First name is required.")).toBeInTheDocument();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  // Emoji and non-latin unicode round trip through the field unchanged.
  it("emoji and non latin unicode round trip through the field unchanged", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValue({ id: "1" });
    setup();

    const payload = "Zoe \u{1F389} 名前 مرحبا";
    await user.type(getFieldInput("First name"), payload);
    await user.type(getFieldInput("Last name"), "Doe");
    await user.type(getFieldInput("Email"), "a@b.com");
    await user.type(getFieldInput("Username"), "auser");
    await user.type(getFieldInput("Password"), "password1!");
    await user.selectOptions(getFieldInput("Role"), "1");
    await user.selectOptions(getFieldInput("Location"), "1");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith("/users", expect.objectContaining({ first_name: payload })));
  });

  // An extremely long string pasted into a text field is accepted client side without crashing the form.
  it("an extremely long string pasted into a text field is accepted client side without crashing the form", () => {
    apiPostMock.mockResolvedValue({ id: "1" });
    setup();

    // fireEvent.change (a paste, effectively) rather than userEvent.type --
    // typing 5000 characters one simulated keystroke at a time is what a
    // real user pasting a huge string would never do, and is slow enough to
    // time out the test for no realistic benefit.
    const payload = "A".repeat(5000);
    fireEvent.change(getFieldInput("Last name"), { target: { value: payload } });

    expect((getFieldInput("Last name") as HTMLInputElement).value).toHaveLength(5000);
  });

  // Right to left script renders and submits without breaking layout or truncating.
  it("right to left script renders and submits without breaking layout or truncating", async () => {
    const user = userEvent.setup();
    apiPostMock.mockResolvedValue({ id: "1" });
    setup();

    const payload = "مرحبا بالعالم";
    await user.type(getFieldInput("Last name"), payload);
    await user.type(getFieldInput("First name"), "Ada");
    await user.type(getFieldInput("Email"), "a@b.com");
    await user.type(getFieldInput("Username"), "auser");
    await user.type(getFieldInput("Password"), "password1!");
    await user.selectOptions(getFieldInput("Role"), "1");
    await user.selectOptions(getFieldInput("Location"), "1");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith("/users", expect.objectContaining({ last_name: payload })));
  });

  // A name consisting only of an invisible zero-width space is rejected as required-field-missing.
  it("a name consisting only of an invisible zero-width space is rejected as required-field-missing", async () => {
    // validate() checks isBlank() (lib/text.ts), not a bare `!value.trim()`
    // -- trim() strips ordinary whitespace and most Unicode space
    // separators, but not the zero-width space (U+200B), so a bare trim()
    // check would let a "name" made of only one through undetected.
    const user = userEvent.setup();
    setup();

    const zeroWidthSpace = "​";
    // fireEvent.change rather than userEvent.type -- a non-printable
    // character like this isn't something a real keystroke ever produces
    // (it arrives via paste), and userEvent's keystroke simulation doesn't
    // handle it cleanly.
    fireEvent.change(getFieldInput("First name"), { target: { value: zeroWidthSpace } });
    await user.type(getFieldInput("Last name"), "Doe");
    await user.type(getFieldInput("Email"), "a@b.com");
    await user.type(getFieldInput("Username"), "auser");
    await user.type(getFieldInput("Password"), "password1!");
    await user.selectOptions(getFieldInput("Role"), "1");
    await user.selectOptions(getFieldInput("Location"), "1");
    await user.click(screen.getByRole("button", { name: "Create user" }));

    expect(await screen.findByText("First name is required.")).toBeInTheDocument();
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});
