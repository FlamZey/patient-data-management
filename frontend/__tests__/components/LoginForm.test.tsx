import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: jest.fn() }),
}));

const loginMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ login: loginMock }),
}));

jest.mock("@/lib/api", () => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`Request failed with status ${status}`);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return { ApiError: MockApiError };
});

import LoginForm from "@/components/LoginForm";
import { ApiError } from "@/lib/api";

// Most of LoginForm's branches (error-status mapping, spinner, password
// toggle) are already exercised end to end via __tests__/app/login.test.tsx,
// which renders this component through the real login page. This file
// covers LoginForm in isolation plus its two adversarial/UX-specific
// behaviors that the page test doesn't reach.

describe("components/LoginForm", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Renders the email and password fields and a sign in button.
  it("renders the email and password fields and a sign in button", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  // Requires both fields before the browser allows a submit.
  it("marks both fields as required", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("Email")).toBeRequired();
    expect(screen.getByLabelText("Password")).toBeRequired();
  });

  // Keeps a previous error visible (rather than flashing it away) while a resubmit is in flight.
  it("keeps a previous error visible while a resubmit is in flight", async () => {
    const user = userEvent.setup();
    loginMock.mockRejectedValueOnce(new ApiError(401, null));
    let resolveSecond!: () => void;
    loginMock.mockReturnValueOnce(new Promise<void>((resolve) => (resolveSecond = resolve)));

    render(<LoginForm />);
    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");

    // Resubmitting: the deliberate design (see the component's own comment)
    // is that the old message stays on screen -- not cleared -- until the
    // new attempt resolves, so the card never wiggles from the message
    // disappearing and reappearing.
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid email or password");

    resolveSecond();
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard"));
  });

  // Disabling the button while submitting prevents a second in-flight request from a rapid double click.
  it("disables the button while submitting so a rapid double click cannot fire twice", async () => {
    const user = userEvent.setup();
    let resolveLogin!: () => void;
    loginMock.mockReturnValueOnce(new Promise<void>((resolve) => (resolveLogin = resolve)));

    render(<LoginForm />);
    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "password123");

    const button = screen.getByRole("button", { name: "Sign in" });
    await user.click(button);
    // The button is now disabled and shows "Signing in..." -- user-event
    // respects `disabled` and will not fire a second click through it.
    await user.click(screen.getByRole("button", { name: "Signing in..." }));

    expect(loginMock).toHaveBeenCalledTimes(1);
    resolveLogin();
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard"));
  });
});
