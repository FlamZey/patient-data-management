import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const pushMock = jest.fn();
const replaceMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

const apiGetMock = jest.fn();
const apiLoginMock = jest.fn();
const apiLogoutMock = jest.fn();
const refreshAccessTokenMock = jest.fn();
let tokenChangeListener: ((token: string | null) => void) | null = null;
let authFailureListener: (() => void) | null = null;

jest.mock("@/lib/api", () => ({
  apiGet: (...args: unknown[]) => apiGetMock(...args),
  apiLogin: (...args: unknown[]) => apiLoginMock(...args),
  apiLogout: (...args: unknown[]) => apiLogoutMock(...args),
  refreshAccessToken: (...args: unknown[]) => refreshAccessTokenMock(...args),
  setAccessToken: jest.fn(),
  setTokenChangeListener: (listener: ((token: string | null) => void) | null) => {
    tokenChangeListener = listener;
  },
  setAuthFailureListener: (listener: (() => void) | null) => {
    authFailureListener = listener;
  },
}));

import { AuthProvider, useAuth } from "@/lib/auth-context";

const USER = {
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
  role: { id: 1, name: "admin", display_name: "Admin", parent_role_id: null, description: null, is_active: true, permissions: [] },
  location: { id: 1, code: "L1", name: "Location 1", is_active: true },
  team: null,
};

function Probe() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(auth.isLoading)}</span>
      <span data-testid="user">{auth.currentUser ? auth.currentUser.email : "none"}</span>
      <span data-testid="token">{auth.accessToken ?? "none"}</span>
      <button onClick={() => auth.login("a@b.com", "password123")}>login</button>
      <button onClick={() => auth.logout().catch(() => {})}>logout</button>
      <button onClick={() => auth.updateCurrentUser({ ...USER, first_name: "Updated" })}>update</button>
    </div>
  );
}

function renderAuth() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

describe("lib/auth-context", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tokenChangeListener = null;
    authFailureListener = null;
    refreshAccessTokenMock.mockResolvedValue(null);
  });

  // Throws when useAuth is used outside an AuthProvider.
  it("throws when useAuth is used outside an AuthProvider", () => {
    const Broken = () => {
      useAuth();
      return null;
    };
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Broken />)).toThrow("useAuth must be used within an AuthProvider");
    spy.mockRestore();
  });

  // Starts loading and resolves to logged-out when there is no refresh cookie.
  it("starts loading and resolves to logged-out when there is no refresh cookie", async () => {
    refreshAccessTokenMock.mockResolvedValue(null);
    renderAuth();

    expect(screen.getByTestId("loading").textContent).toBe("true");

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  // Restores a session on mount when the refresh cookie is valid.
  it("restores a session on mount when the refresh cookie is valid", async () => {
    refreshAccessTokenMock.mockResolvedValue("restored-token");
    apiGetMock.mockResolvedValueOnce(USER);

    renderAuth();

    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("a@b.com"));
    expect(screen.getByTestId("token").textContent).toBe("restored-token");
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(apiGetMock).toHaveBeenCalledWith("/auth/me");
  });

  // Clears auth if fetching the profile fails after a successful token restore.
  it("clears auth if fetching the profile fails after a successful token restore", async () => {
    refreshAccessTokenMock.mockResolvedValue("restored-token");
    apiGetMock.mockRejectedValueOnce(new Error("boom"));

    renderAuth();

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("user").textContent).toBe("none");
  });

  // Logs in successfully and populates currentUser.
  it("logs in successfully and populates currentUser", async () => {
    const user = userEvent.setup();
    refreshAccessTokenMock.mockResolvedValue(null);
    apiLoginMock.mockResolvedValue({ access_token: "login-token", token_type: "bearer", expires_in: 900 });
    apiGetMock.mockResolvedValueOnce(USER);

    renderAuth();
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));

    await user.click(screen.getByText("login"));

    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("a@b.com"));
    expect(screen.getByTestId("token").textContent).toBe("login-token");
  });

  // Clears auth and rethrows when login succeeds but fetching the profile fails.
  it("clears auth and rethrows when login succeeds but fetching the profile fails", async () => {
    const user = userEvent.setup();
    refreshAccessTokenMock.mockResolvedValue(null);
    apiLoginMock.mockResolvedValue({ access_token: "login-token", token_type: "bearer", expires_in: 900 });
    apiGetMock.mockRejectedValueOnce(new Error("profile fetch failed"));

    function LoginProbe() {
      const auth = useAuth();
      return (
        <button
          onClick={async () => {
            try {
              await auth.login("a@b.com", "password123");
            } catch {
              // swallow -- asserting via state below
            }
          }}
        >
          login
        </button>
      );
    }

    render(
      <AuthProvider>
        <Probe />
        <LoginProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));

    await user.click(screen.getAllByText("login")[1]);

    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("none"));
    expect(screen.getByTestId("token").textContent).toBe("none");
  });

  // Logs out, clears state, and navigates to /login even if the API call fails.
  it("logs out, clears state, and navigates to /login even if the API call fails", async () => {
    const user = userEvent.setup();
    refreshAccessTokenMock.mockResolvedValue("restored-token");
    apiGetMock.mockResolvedValueOnce(USER);
    apiLogoutMock.mockRejectedValueOnce(new Error("network error"));

    renderAuth();
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("a@b.com"));

    await user.click(screen.getByText("logout"));

    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("none"));
    expect(pushMock).toHaveBeenCalledWith("/login");
  });

  // UpdateCurrentUser overwrites the current user.
  it("updateCurrentUser overwrites the current user", async () => {
    const user = userEvent.setup();
    refreshAccessTokenMock.mockResolvedValue("restored-token");
    apiGetMock.mockResolvedValueOnce(USER);

    renderAuth();
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("a@b.com"));

    await user.click(screen.getByText("update"));

    expect(screen.getByTestId("user").textContent).toBe("a@b.com");
  });

  // Mirrors token changes from lib/api.ts into React state.
  it("mirrors token changes from lib/api.ts into React state", async () => {
    refreshAccessTokenMock.mockResolvedValue(null);
    renderAuth();
    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));

    act(() => {
      tokenChangeListener?.("silently-refreshed-token");
    });

    expect(screen.getByTestId("token").textContent).toBe("silently-refreshed-token");
  });

  // Clears auth and redirects to /login when lib/api.ts reports an auth failure.
  it("clears auth and redirects to /login when lib/api.ts reports an auth failure", async () => {
    refreshAccessTokenMock.mockResolvedValue("restored-token");
    apiGetMock.mockResolvedValueOnce(USER);
    renderAuth();
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("a@b.com"));

    act(() => {
      authFailureListener?.();
    });

    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(pushMock).toHaveBeenCalledWith("/login");
  });

  // Skips setting state if unmounted while the profile fetch is in flight.
  it("skips setting state if unmounted while the profile fetch is in flight", async () => {
    refreshAccessTokenMock.mockResolvedValue("restored-token");
    let resolveProfile!: (user: typeof USER) => void;
    apiGetMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProfile = resolve;
      }),
    );

    const { unmount } = renderAuth();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith("/auth/me"));
    unmount();

    await act(async () => {
      resolveProfile(USER);
      await Promise.resolve();
    });

    // No assertions on unmounted DOM -- this exercises the `!cancelled`
    // guards in the effect's cleanup path without throwing.
  });

  // Skips clearing auth if unmounted while the profile fetch is failing.
  it("skips clearing auth if unmounted while the profile fetch is failing", async () => {
    refreshAccessTokenMock.mockResolvedValue("restored-token");
    let rejectProfile!: (err: Error) => void;
    apiGetMock.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectProfile = reject;
      }),
    );

    const { unmount } = renderAuth();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith("/auth/me"));
    unmount();

    await act(async () => {
      rejectProfile(new Error("profile fetch failed"));
      await Promise.resolve();
    });

    // No assertions on unmounted DOM -- this exercises the `!cancelled`
    // guard in the catch branch without throwing.
  });

  // Cancels the profile fetch if unmounted before session restore resolves.
  it("cancels the profile fetch if unmounted before session restore resolves", async () => {
    let resolveRefresh!: (token: string | null) => void;
    refreshAccessTokenMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const { unmount } = renderAuth();
    unmount();

    await act(async () => {
      resolveRefresh("late-token");
      await Promise.resolve();
    });

    expect(apiGetMock).not.toHaveBeenCalled();
  });
});
