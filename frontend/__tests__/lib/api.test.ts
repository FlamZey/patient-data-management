import {
  ApiError,
  apiDelete,
  apiGet,
  apiGetAnalyticsDataset,
  apiGetPatients,
  apiGetUsers,
  apiLogin,
  apiLogout,
  apiPatch,
  apiPatchPatient,
  apiPost,
  apiUploadFileWithProgress,
  getAccessToken,
  refreshAccessToken,
  setAccessToken,
  setAuthFailureListener,
  setTokenChangeListener,
} from "@/lib/api";

const API_URL = "https://api.example.test";

// An NDJSON response whose reader yields exactly the given chunks. Chunk
// boundaries are the interesting variable: readNdjsonStream buffers partial
// lines, so an object split across two reads must still parse.
function ndjsonResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: encoder.encode(chunks[index++]) }
            : { done: true, value: undefined },
      }),
    },
    json: async () => ({}),
  } as unknown as Response;
}

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

  // Query-string construction for the two list endpoints. Both drive
  // server-side filtering, so an omitted or mis-encoded param silently
  // changes which rows come back rather than failing loudly.
  describe("list endpoint query building", () => {
    function urlOf(): string {
      return (global.fetch as jest.Mock).mock.calls[0][0] as string;
    }

    // Undefined values are omitted rather than serialized as "undefined".
    it("omits undefined params", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
      await apiGetPatients({ patient_code: "P-1", first_name: undefined, page: undefined });

      expect(urlOf()).toContain("patient_code=P-1");
      expect(urlOf()).not.toContain("first_name");
      expect(urlOf()).not.toContain("page");
    });

    // Array values repeat the key once per item, which is how the backend
    // reads a multi-select filter.
    it("repeats the key for array params", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
      await apiGetPatients({ gender: ["Male", "Female"] });

      const url = urlOf();
      expect(url).toContain("gender=Male");
      expect(url).toContain("gender=Female");
    });

    // Values are URL-encoded, so a filter containing & or = can't smuggle in
    // an extra parameter.
    it("encodes special characters in a filter value", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
      await apiGetPatients({ last_name: "O'Neill & Sons=x" });

      const url = urlOf();
      expect(url).not.toContain("& Sons");
      expect(url).toContain("last_name=");
    });

    // No params means no trailing question mark.
    it("omits the question mark entirely when there are no params", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
      await apiGetUsers();

      expect(urlOf()).toBe(`${API_URL}/users`);
    });

    // apiGetUsers builds the same shape against its own endpoint.
    it("apiGetUsers builds repeated and scalar params", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { items: [], total: 0 }));
      await apiGetUsers({ role: ["Admin", "Manager"], page: 2, sort_dir: "desc" });

      const url = urlOf();
      expect(url).toContain("/users?");
      expect(url).toContain("role=Admin");
      expect(url).toContain("role=Manager");
      expect(url).toContain("page=2");
      expect(url).toContain("sort_dir=desc");
    });

    // apiPatchPatient targets the right row with the right verb.
    it("apiPatchPatient PATCHes the patient by id", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { id: "p1" }));
      await apiPatchPatient("p1", { first_name: "Ada" });

      expect(urlOf()).toBe(`${API_URL}/patients/p1`);
      expect((global.fetch as jest.Mock).mock.calls[0][1].method).toBe("PATCH");
    });
  });

  // The NDJSON reader shared by the upload and analytics endpoints. Both
  // stream progress and end with one terminal line, so the buffering has to
  // survive arbitrary chunk boundaries -- the network decides those, not the
  // server.
  describe("NDJSON streaming", () => {
    const file = new File(["x"], "patients.xlsx");

    // Progress events fire in order and the terminal line resolves the call.
    it("reports each progress event and resolves with the done payload", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        ndjsonResponse([
          '{"type":"progress","phase":"validating","processed":1,"total":2}\n',
          '{"type":"progress","phase":"saving","processed":2,"total":2}\n',
          '{"type":"done","accepted":2,"rejected":[],"upload_id":"u1"}\n',
        ]),
      );
      const onProgress = jest.fn();

      const result = await apiUploadFileWithProgress("/patients/upload", file, onProgress);

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(onProgress).toHaveBeenNthCalledWith(1, { phase: "validating", processed: 1, total: 2 });
      expect(onProgress).toHaveBeenNthCalledWith(2, { phase: "saving", processed: 2, total: 2 });
      expect(result).toEqual({ accepted: 2, rejected: [], upload_id: "u1" });
    });

    // An object split across two reads still parses.
    it("reassembles a line split across chunk boundaries", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        ndjsonResponse(['{"type":"done","accep', 'ted":7,"rejected":[],"upload_id":"u2"}\n']),
      );

      const result = await apiUploadFileWithProgress("/patients/upload", file);
      expect(result).toEqual({ accepted: 7, rejected: [], upload_id: "u2" });
    });

    // Several objects arriving in one chunk are all processed.
    it("handles multiple objects in a single chunk", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        ndjsonResponse([
          '{"type":"progress","phase":"saving","processed":1,"total":3}\n' +
            '{"type":"progress","phase":"saving","processed":2,"total":3}\n' +
            '{"type":"done","accepted":3,"rejected":[],"upload_id":"u3"}\n',
        ]),
      );
      const onProgress = jest.fn();

      // apiUploadFileWithProgress is generic in its return type; the other
      // cases compare whole objects, so only this one needs the annotation.
      const result = await apiUploadFileWithProgress<{ accepted: number }>(
        "/patients/upload",
        file,
        onProgress,
      );
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(result.accepted).toBe(3);
    });

    // A stream that ends without a terminal line is a dropped connection, not
    // a clean result -- it must reject rather than resolve undefined.
    it("throws when the stream ends without a done line", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        ndjsonResponse(['{"type":"progress","phase":"saving","processed":1,"total":9}\n']),
      );

      await expect(apiUploadFileWithProgress("/patients/upload", file)).rejects.toBeInstanceOf(ApiError);
    });

    // A whole-request failure discovered mid-stream -- after the initial 2xx
    // already went out, so a status code is no longer an option (see
    // backend/app/routers/patients.py's upload_patients, which can lose a
    // uniqueness race against a concurrent upload) -- surfaces the same way
    // every other upload failure does: an ApiError whose body.detail the
    // existing UI error handling already reads, no special-casing needed.
    it("throws ApiError with the message from a mid-stream error line", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        ndjsonResponse([
          '{"type":"progress","phase":"saving","processed":1,"total":2}\n',
          '{"type":"error","message":"No rows from this file were saved."}\n',
        ]),
      );

      await expect(apiUploadFileWithProgress("/patients/upload", file)).rejects.toMatchObject({
        status: 0,
        body: { detail: "No rows from this file were saved." },
      });
    });

    // A non-2xx response throws before any streaming is attempted.
    it("throws ApiError when the upload response is not ok", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(422, { detail: "bad header" }));

      await expect(apiUploadFileWithProgress("/patients/upload", file)).rejects.toMatchObject({ status: 422 });
    });

    // The analytics endpoint uses the same reader and resolves the dataset.
    it("apiGetAnalyticsDataset streams progress then resolves the dataset", async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        ndjsonResponse([
          '{"type":"progress","processed":1,"total":2}\n',
          '{"type":"done","total":2,"categories":{},"multi_value_categories":{},"columns":{},"quality":{}}\n',
        ]),
      );
      const onProgress = jest.fn();

      const dataset = await apiGetAnalyticsDataset(onProgress);

      expect(onProgress).toHaveBeenCalledWith({ processed: 1, total: 2 });
      expect(dataset.total).toBe(2);
    });

    // The bearer token rides along on the streaming endpoints too -- they
    // bypass request(), so this is a separate code path from apiGet's.
    it("attaches the bearer token to a streaming request", async () => {
      setAccessToken("stream-token");
      (global.fetch as jest.Mock).mockResolvedValue(
        ndjsonResponse([
          '{"type":"done","total":0,"categories":{},"multi_value_categories":{},"columns":{},"quality":{}}\n',
        ]),
      );

      await apiGetAnalyticsDataset();

      const init = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(init.headers.Authorization).toBe("Bearer stream-token");
    });
  });
});
