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

  // A name consisting only of an invisible zero-width space passes required-field validation.
  it("a name consisting only of an invisible zero-width space passes required-field validation", async () => {
    // Flagged, not treated as correct: JS String.prototype.trim() strips
    // ordinary whitespace and most Unicode space separators, but NOT the
    // zero-width space (U+200B) -- so validate()'s `!form.first_name.trim()`
    // check doesn't catch a "name" made only of one. The form accepts and
    // submits it as if it were a real value. See the batch summary.
    const user = userEvent.setup();
    apiPostMock.mockResolvedValue({ id: "1" });
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

    expect(screen.queryByText("First name is required.")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith("/users", expect.objectContaining({ first_name: zeroWidthSpace })),
    );
  });
});
