import { useEffect, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";

const pushMock = jest.fn();
const replaceMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
}));

// Deliberately NOT mocking @/lib/api or @/lib/auth-context -- this file
// tests the real interaction between them (AuthProvider wiring its
// listeners into api.ts's module-level token state) via a mocked fetch at
// the network boundary, which unit tests of either module in isolation
// can't exercise.
import { apiGet, setAccessToken } from "@/lib/api";
import { AuthProvider, useAuth } from "@/lib/auth-context";

const API_URL = "https://api.example.test";

function jsonResponse(status: number, body: unknown, init: ResponseInit = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    ...init,
  } as Response;
}

// A minimal consumer that fetches a protected resource on mount, the way
// any real page (PatientTable, UserManagementTable, ...) does -- it knows
// nothing about auth/refresh machinery, which is exactly the point: that
// machinery has to work transparently underneath it.
function ProtectedResource() {
  const { currentUser, isLoading } = useAuth();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    if (isLoading) return;
    apiGet("/patients/some-resource")
      .then(() => setState("ok"))
      .catch(() => setState("error"));
  }, [isLoading]);

  return (
    <div>
      <p data-testid="user">{currentUser ? currentUser.email : "anonymous"}</p>
      <p data-testid="resource-state">{state}</p>
    </div>
  );
}

describe("integration: session expiry across auth-context and api", () => {
  const originalEnv = process.env.NEXT_PUBLIC_API_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = API_URL;
    setAccessToken(null);
    pushMock.mockClear();
    replaceMock.mockClear();
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_API_URL = originalEnv;
  });

  // A request that hits a 401 mid-session transparently retries after a silent refresh, with no visible failure.
  it("a request that hits a 401 mid session transparently retries after a silent refresh", async () => {
    let patientsCallCount = 0;
    global.fetch = jest.fn((url: string) => {
      if (url === `${API_URL}/auth/refresh`) {
        return Promise.resolve(jsonResponse(200, { access_token: "new-token", expires_in: 900 }));
      }
      if (url === `${API_URL}/auth/me`) {
        return Promise.resolve(
          jsonResponse(200, { id: "1", email: "a@b.com", role: { permissions: [] } }),
        );
      }
      if (url === `${API_URL}/patients/some-resource`) {
        patientsCallCount += 1;
        // First call: still holding a token that's since expired server-side.
        // Second call (after the silent refresh above): succeeds.
        if (patientsCallCount === 1) return Promise.resolve(jsonResponse(401, null));
        return Promise.resolve(jsonResponse(200, { ok: true }));
      }
      return Promise.reject(new Error(`Unexpected fetch to ${url}`));
    }) as unknown as typeof fetch;

    render(
      <AuthProvider>
        <ProtectedResource />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("a@b.com"));
    await waitFor(() => expect(screen.getByTestId("resource-state")).toHaveTextContent("ok"));
    expect(patientsCallCount).toBe(2);
    // The transparent retry must never surface as a redirect or logout.
    expect(pushMock).not.toHaveBeenCalledWith("/login");
  });

  // When the refresh cookie itself has expired, the app clears the session and redirects to login instead of hanging in a broken state.
  it("clears the session and redirects to login when the refresh cookie has also expired", async () => {
    global.fetch = jest.fn((url: string) => {
      if (url === `${API_URL}/auth/refresh`) {
        return Promise.resolve(jsonResponse(401, null));
      }
      if (url === `${API_URL}/patients/some-resource`) {
        return Promise.resolve(jsonResponse(401, null));
      }
      return Promise.reject(new Error(`Unexpected fetch to ${url}`));
    }) as unknown as typeof fetch;

    render(
      <AuthProvider>
        <ProtectedResource />
      </AuthProvider>,
    );

    // Initial session-restore attempt fails (no valid refresh cookie) --
    // starts logged out, not stuck loading forever.
    await waitFor(() => expect(screen.getByTestId("user")).toHaveTextContent("anonymous"));

    // The protected resource's own request then also 401s, retries via
    // another refresh attempt, which also fails -- this is the path that
    // must end in a clean redirect, not a silent hang or thrown error.
    await waitFor(() => expect(screen.getByTestId("resource-state")).toHaveTextContent("error"));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/login"));
  });

  // Two components independently hitting a 401 at the same time coalesce into a single refresh call, not two racing ones.
  it("two components independently hitting a 401 at the same time coalesce into a single refresh call", async () => {
    let refreshCallCount = 0;
    global.fetch = jest.fn((url: string) => {
      if (url === `${API_URL}/auth/refresh`) {
        refreshCallCount += 1;
        return Promise.resolve(jsonResponse(200, { access_token: "new-token", expires_in: 900 }));
      }
      if (url === `${API_URL}/auth/me`) {
        return Promise.resolve(
          jsonResponse(200, { id: "1", email: "a@b.com", role: { permissions: [] } }),
        );
      }
      if (url.includes("/patients/resource-a") || url.includes("/patients/resource-b")) {
        // Both endpoints look expired on their first hit.
        const seen = (global.fetch as jest.Mock).mock.calls.filter(
          ([calledUrl]) => calledUrl === url,
        ).length;
        return Promise.resolve(jsonResponse(seen === 1 ? 401 : 200, seen === 1 ? null : { ok: true }));
      }
      return Promise.reject(new Error(`Unexpected fetch to ${url}`));
    }) as unknown as typeof fetch;

    function TwoConsumers() {
      const { isLoading } = useAuth();
      const [a, setA] = useState("loading");
      const [b, setB] = useState("loading");
      useEffect(() => {
        if (isLoading) return;
        apiGet("/patients/resource-a").then(() => setA("ok"));
        apiGet("/patients/resource-b").then(() => setB("ok"));
      }, [isLoading]);
      return (
        <>
          <p data-testid="a">{a}</p>
          <p data-testid="b">{b}</p>
        </>
      );
    }

    render(
      <AuthProvider>
        <TwoConsumers />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("a")).toHaveTextContent("ok"));
    await waitFor(() => expect(screen.getByTestId("b")).toHaveTextContent("ok"));
    // 2, not 3: one from AuthProvider's own initial session-restore on
    // mount, plus exactly one shared refresh for both concurrent 401
    // retries -- if resource-a and resource-b's retries didn't coalesce,
    // this would be 3.
    expect(refreshCallCount).toBe(2);
  });
});
