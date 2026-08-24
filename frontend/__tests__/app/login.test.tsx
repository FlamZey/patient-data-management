import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const pushMock = jest.fn();
const replaceMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

const loginMock = jest.fn();
const useAuthMock = jest.fn();
jest.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuthMock(),
}));

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
  return { ApiError: MockApiError };
});

import LoginPage from "@/app/login/page";

const { ApiError: MockApiError } = jest.requireMock("@/lib/api") as {
  ApiError: new (status: number, body: unknown) => Error;
};

function setAuth(overrides: Partial<{ currentUser: unknown; isLoading: boolean }> = {}) {
  useAuthMock.mockReturnValue({
    currentUser: null,
    isLoading: false,
    login: loginMock,
    ...overrides,
  });
}

describe("app/login", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders nothing before showing a loading indicator while the session check is in flight", async () => {
    setAuth({ isLoading: true });
    const { container } = render(<LoginPage />);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();

    await waitFor(() => expect(container.querySelector(".animate-spin")).toBeInTheDocument());
  });

  it("redirects to /home when already authenticated", async () => {
    setAuth({ isLoading: false, currentUser: { id: "1" } });
    render(<LoginPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/home"));
  });

  it("does not redirect while there is no user and loading has resolved", () => {
    setAuth();
    render(<LoginPage />);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Sign in to continue" })).toBeInTheDocument();
  });

  it("submits credentials and navigates to /home on success", async () => {
    const user = userEvent.setup();
    setAuth();
    loginMock.mockResolvedValueOnce(undefined);
    render(<LoginPage />);

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/home"));
    expect(loginMock).toHaveBeenCalledWith("a@b.com", "password123");
  });

  it.each([
    [401, "Invalid email or password"],
    [423, "Account locked. Try again later."],
    [403, "User account is not active"],
  ])("shows the mapped message for a %s response", async (status, message) => {
    const user = userEvent.setup();
    setAuth();
    loginMock.mockRejectedValueOnce(new MockApiError(status, null));
    render(<LoginPage />);

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("shows a generic error message for an unmapped ApiError status", async () => {
    const user = userEvent.setup();
    setAuth();
    loginMock.mockRejectedValueOnce(new MockApiError(500, null));
    render(<LoginPage />);

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "x");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
  });

  it("shows a generic error message for a non-ApiError failure", async () => {
    const user = userEvent.setup();
    setAuth();
    loginMock.mockRejectedValueOnce(new Error("network down"));
    render(<LoginPage />);

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "x");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
  });

  it("disables the submit button and shows a spinner while submitting", async () => {
    const user = userEvent.setup();
    setAuth();
    let resolveLogin!: () => void;
    loginMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveLogin = resolve;
      }),
    );
    render(<LoginPage />);

    await user.type(screen.getByLabelText("Email"), "a@b.com");
    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("button", { name: "Signing in..." })).toBeDisabled();

    resolveLogin();
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/home"));
  });

  it("toggles the password field between masked and revealed", async () => {
    const user = userEvent.setup();
    setAuth();
    render(<LoginPage />);

    const passwordInput = screen.getByLabelText("Password");
    expect(passwordInput).toHaveAttribute("type", "password");

    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(passwordInput).toHaveAttribute("type", "text");

    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(passwordInput).toHaveAttribute("type", "password");
  });
});
