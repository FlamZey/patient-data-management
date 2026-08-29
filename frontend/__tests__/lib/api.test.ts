import {
  ApiError,
  apiDelete,
  apiGet,
  apiLogin,
  apiLogout,
  apiPatch,
  apiPost,
  getAccessToken,
  refreshAccessToken,
  setAccessToken,
  setAuthFailureListener,
  setTokenChangeListener,
} from "@/lib/api";

const API_URL = "https://api.example.test";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("lib/api", () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.NEXT_PUBLIC_API_URL;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_URL = API_URL;
    global.fetch = jest.fn();
    setAccessToken(null);
    setTokenChangeListener(null);
    setAuthFailureListener(null);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.NEXT_PUBLIC_API_URL = originalEnv;
    jest.clearAllMocks();
  });

  describe("apiUrl / env guard", () => {
    // Throws if NEXT_PUBLIC_API_URL is not set.
    it("throws if NEXT_PUBLIC_API_URL is not set", async () => {
      delete process.env.NEXT_PUBLIC_API_URL;
      await expect(apiGet("/users")).rejects.toThrow("NEXT_PUBLIC_API_URL is not set");
    });
  });

  describe("apiGet", () => {
    // Performs a GET without an Authorization header when no token is set.
    it("performs a GET without an Authorization header when no token is set", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { ok: true }));

      const result = await apiGet<{ ok: boolean }>("/users");

      expect(result).toEqual({ ok: true });
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe(`${API_URL}/users`);
      expect(init.headers).toEqual({});
    });

    // Attaches a Bearer token when one is set.
    it("attaches a Bearer token when one is set", async () => {
      setAccessToken("token-123");
      (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, []));

      await apiGet("/users");

      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(init.headers.Authorization).toBe("Bearer token-123");
    });

    // Returns undefined for a 204 response without parsing a body.
    it("returns undefined for a 204 response without parsing a body", async () => {
      const json = jest.fn();
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 204, json });

      const result = await apiGet("/users/1");

      expect(result).toBeUndefined();
      expect(json).not.toHaveBeenCalled();
    });

    // Throws ApiError with parsed body on a non-401/non-2xx response.
    it("throws ApiError with parsed body on a non-401/non-2xx response", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(404, { detail: "not found" }));

      await expect(apiGet("/users/missing")).rejects.toMatchObject({
        name: "ApiError",
        status: 404,
        body: { detail: "not found" },
      });
    });

    // Falls back to a null body when the error response isn't valid JSON.
    it("falls back to a null body when the error response isn't valid JSON", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      });

      await expect(apiGet("/boom")).rejects.toMatchObject({ status: 500, body: null });
    });
  });

  describe("apiPost / apiPatch / apiDelete", () => {
    // ApiPost sends JSON body and Content-Type header.
    it("apiPost sends JSON body and Content-Type header", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { id: 1 }));

      await apiPost("/users", { email: "a@b.com" });

      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe(`${API_URL}/users`);
      expect(init.method).toBe("POST");
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(init.body).toBe(JSON.stringify({ email: "a@b.com" }));
    });

    // ApiPatch sends a PATCH request.
    it("apiPatch sends a PATCH request", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { id: 1 }));

      await apiPatch("/users/1", { first_name: "A" });

      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(init.method).toBe("PATCH");
    });

    // ApiDelete sends no body and omits Content-Type.
    it("apiDelete sends no body and omits Content-Type", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 204, json: jest.fn() });

      await apiDelete("/users/1");

      const [, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(init.method).toBe("DELETE");
      expect(init.body).toBeUndefined();
      expect(init.headers["Content-Type"]).toBeUndefined();
    });
  });

  describe("401 handling and silent refresh", () => {
    // Retries the request once after a successful refresh and succeeds.
    it("retries the request once after a successful refresh and succeeds", async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: false, status: 401, json: async () => null }) // initial request
        .mockResolvedValueOnce(jsonResponse(200, { access_token: "new-token", token_type: "bearer", expires_in: 900 })) // refresh
        .mockResolvedValueOnce(jsonResponse(200, { id: 1 })); // retried request

      const result = await apiGet<{ id: number }>("/users/1");

      expect(result).toEqual({ id: 1 });
      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(getAccessToken()).toBe("new-token");

      const refreshCall = (global.fetch as jest.Mock).mock.calls[1];
      expect(refreshCall[0]).toBe(`${API_URL}/auth/refresh`);
      expect(refreshCall[1]).toMatchObject({ method: "POST", credentials: "include" });

      const retryCall = (global.fetch as jest.Mock).mock.calls[2];
      expect(retryCall[1].headers.Authorization).toBe("Bearer new-token");
    });

    // Notifies the token-change listener when a silent refresh succeeds.
    it("notifies the token-change listener when a silent refresh succeeds", async () => {
      const onTokenChange = jest.fn();
      setTokenChangeListener(onTokenChange);

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: false, status: 401, json: async () => null })
        .mockResolvedValueOnce(jsonResponse(200, { access_token: "new-token", token_type: "bearer", expires_in: 900 }))
        .mockResolvedValueOnce(jsonResponse(200, {}));

      await apiGet("/users/1");

      expect(onTokenChange).toHaveBeenCalledWith("new-token");
    });

    // Clears the token and fires the auth-failure listener when refresh fails outright.
    it("clears the token and fires the auth-failure listener when refresh fails outright", async () => {
      const onTokenChange = jest.fn();
      const onAuthFailure = jest.fn();
      setTokenChangeListener(onTokenChange);
      setAuthFailureListener(onAuthFailure);
      setAccessToken("stale-token");

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: false, status: 401, json: async () => null }) // initial request
        .mockResolvedValueOnce({ ok: false, status: 401, json: async () => null }); // refresh fails

      await expect(apiGet("/users/1")).rejects.toMatchObject({ status: 401 });

      expect(getAccessToken()).toBeNull();
      expect(onTokenChange).toHaveBeenCalledWith(null);
      expect(onAuthFailure).toHaveBeenCalled();
    });

    // Clears auth and fails when the retried request is still unauthorized.
    it("clears auth and fails when the retried request is still unauthorized", async () => {
      const onAuthFailure = jest.fn();
      setAuthFailureListener(onAuthFailure);

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: false, status: 401, json: async () => null }) // initial request
        .mockResolvedValueOnce(jsonResponse(200, { access_token: "new-token", token_type: "bearer", expires_in: 900 })) // refresh succeeds
        .mockResolvedValueOnce({ ok: false, status: 401, json: async () => null }); // retry still 401

      await expect(apiGet("/users/1")).rejects.toMatchObject({ status: 401 });

      expect(getAccessToken()).toBeNull();
      expect(onAuthFailure).toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    // Coalesces concurrent refresh attempts into a single in-flight request.
    it("coalesces concurrent refresh attempts into a single in-flight request", async () => {
      let resolveRefresh!: (res: Response) => void;
      const refreshPromise = new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });

      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ ok: false, status: 401, json: async () => null }) // request 1
        .mockResolvedValueOnce({ ok: false, status: 401, json: async () => null }) // request 2
        .mockImplementationOnce(() => refreshPromise) // the single shared refresh call
        .mockResolvedValueOnce(jsonResponse(200, { ok: 1 })) // retry 1
        .mockResolvedValueOnce(jsonResponse(200, { ok: 2 })); // retry 2

      const call1 = apiGet("/a");
      const call2 = apiGet("/b");

      resolveRefresh(
        jsonResponse(200, { access_token: "shared-token", token_type: "bearer", expires_in: 900 }),
      );

      await Promise.all([call1, call2]);

      const refreshCalls = (global.fetch as jest.Mock).mock.calls.filter(
        ([url]) => url === `${API_URL}/auth/refresh`,
      );
      expect(refreshCalls).toHaveLength(1);
    });
  });

  describe("refreshAccessToken", () => {
    // Returns null if the refresh request throws.
    it("returns null if the refresh request throws", async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("network down"));

      const token = await refreshAccessToken();

      expect(token).toBeNull();
    });

    // Returns null and does not update state when the refresh response is not ok.
    it("returns null and does not update state when the refresh response is not ok", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 401, json: async () => null });

      const token = await refreshAccessToken();

      expect(token).toBeNull();
      expect(getAccessToken()).toBeNull();
    });
  });

  describe("apiLogin / apiLogout", () => {
    // ApiLogin posts credentials with cookies and stores the access token.
    it("apiLogin posts credentials with cookies and stores the access token", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        jsonResponse(200, { access_token: "login-token", token_type: "bearer", expires_in: 900 }),
      );

      const result = await apiLogin({ email: "a@b.com", password: "hunter2pass" });

      expect(result.access_token).toBe("login-token");
      expect(getAccessToken()).toBe("login-token");
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe(`${API_URL}/auth/login`);
      expect(init.credentials).toBe("include");
    });

    // ApiLogin throws ApiError on failure without touching the token.
    it("apiLogin throws ApiError on failure without touching the token", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse(401, { detail: "bad creds" }));

      await expect(apiLogin({ email: "a@b.com", password: "wrong" })).rejects.toBeInstanceOf(ApiError);
      expect(getAccessToken()).toBeNull();
    });

    // ApiLogout clears the access token even though it returns void.
    it("apiLogout clears the access token even though it returns void", async () => {
      setAccessToken("some-token");
      (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, status: 204, json: jest.fn() });

      await apiLogout();

      expect(getAccessToken()).toBeNull();
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe(`${API_URL}/auth/logout`);
      expect(init.credentials).toBe("include");
    });
  });
});
