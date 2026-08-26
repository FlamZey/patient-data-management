import type {
  AnalyticsDataset,
  LoginRequest,
  PatientListResponse,
  PatientRead,
  PatientUpdate,
  TokenResponse,
  UserListResponse,
} from "./types";

// Checked lazily (not at module load) so importing this module never
// crashes prerendering if the env var happens to be unset at build time --
// it only throws if code actually tries to make a request.
function apiUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_API_URL; // e.g. "http://localhost:8000"
  if (!base) {
    throw new Error("NEXT_PUBLIC_API_URL is not set");
  }
  return `${base}${path}`;
}

// Thrown for any non-2xx response; callers check `.status` to branch on
// specific error codes (401, 404, 409, ...).
export class ApiError extends Error {
  status: number; // HTTP status code
  body: unknown; // parsed JSON error body, if any

  constructor(status: number, body: unknown) {
    super(`Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// In-memory only -- never persisted to localStorage/sessionStorage, so it
// can't be read by an XSS payload after the fact and doesn't survive a
// page reload (the refresh cookie is what restores a session on reload).
let accessToken: string | null = null;

// Lets auth-context.tsx mirror token changes into React state for
// re-renders, without this module needing to import React/hooks.
let onTokenChange: ((token: string | null) => void) | null = null;
// Fired when a refresh attempt fails (or a retried request is still
// unauthorized) -- auth-context.tsx uses this to clear currentUser and
// redirect to /login.
let onAuthFailure: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setTokenChangeListener(
  listener: ((token: string | null) => void) | null,
): void {
  onTokenChange = listener;
}

export function setAuthFailureListener(listener: (() => void) | null): void {
  onAuthFailure = listener;
}

// Coalesces concurrent refresh attempts into a single in-flight request.
// Without this, two requests failing with 401 at the same time would each
// call /auth/refresh independently -- since the backend rotates (revokes)
// the refresh token on every call, the second call would race the first
// and fail against an already-revoked cookie.
let refreshPromise: Promise<string | null> | null = null;

// Exchanges the httponly refresh cookie for a new access token; null if
// the cookie is missing/expired/revoked.
async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(apiUrl("/auth/refresh"), {
        method: "POST",
        // Only /auth/* needs the refresh cookie (path="/auth" on the
        // backend) -- this is the one call in this file that needs it.
        credentials: "include",
      });
      if (!res.ok) return null;

      const data: TokenResponse = await res.json();
      accessToken = data.access_token;
      onTokenChange?.(accessToken);
      return accessToken;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// Best-effort JSON parse of a response body -- null if it isn't JSON (or
// is empty), so callers never have to try/catch this themselves.
async function parseBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

interface RequestOptions {
  body?: unknown; // JSON-serialized and sent as the request body
  signal?: AbortSignal; // lets a caller cancel the request
}

// Core fetch wrapper: attaches the bearer token, retries once through a
// silent refresh on 401, and throws ApiError for any other failure.
async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
  isRetry = false, // true on the second attempt, after a refresh -- prevents infinite retry loops
): Promise<T> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(apiUrl(path), {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (res.status === 401) {
    if (!isRetry) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        return request<T>(method, path, options, true);
      }
    }

    // Either the refresh itself failed, or the retried request was still
    // unauthorized -- in both cases the session can't be recovered here.
    accessToken = null;
    onTokenChange?.(null);
    onAuthFailure?.();
    throw new ApiError(401, await parseBody(res));
  }

  if (!res.ok) {
    throw new ApiError(res.status, await parseBody(res));
  }

  if (res.status === 204) {
    return undefined as T; // no-content responses (e.g. DELETE) have nothing to parse
  }

  return (await res.json()) as T;
}

// Thin per-verb wrappers around request() -- what most call sites use.
export const apiGet = <T>(path: string, options?: RequestOptions) =>
  request<T>("GET", path, options);

export const apiPost = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>("POST", path, { ...options, body });

export const apiPatch = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>("PATCH", path, { ...options, body });

export const apiDelete = <T>(path: string, options?: RequestOptions) =>
  request<T>("DELETE", path, options);

// GET /patients with optional filter/sort/pagination query params --
// undefined values are simply omitted, array values (gender) repeat the
// key once per item.
export function apiGetPatients(params?: {
  patient_code?: string;
  first_name?: string;
  last_name?: string;
  gender?: string[];
  date_of_birth_from?: string;
  date_of_birth_to?: string;
  sort_by?: "patient_code" | "first_name" | "last_name" | "date_of_birth";
  sort_dir?: "asc" | "desc";
  page?: number;
  page_size?: number;
}): Promise<PatientListResponse> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else {
      query.set(key, String(value));
    }
  }
  const qs = query.toString();
  return apiGet<PatientListResponse>(`/patients${qs ? `?${qs}` : ""}`);
}

export const apiPatchPatient = (id: string, body: PatientUpdate) =>
  apiPatch<PatientRead>(`/patients/${id}`, body);

// GET /users with optional filter/sort/pagination query params -- same
// query-building shape as apiGetPatients above.
export function apiGetUsers(params?: {
  name?: string;
  email?: string;
  role?: string[];
  location?: string[];
  team?: string[];
  status?: string[];
  sort_by?: "name" | "email" | "role" | "location" | "team" | "status";
  sort_dir?: "asc" | "desc";
  page?: number;
  page_size?: number;
}): Promise<UserListResponse> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else {
      query.set(key, String(value));
    }
  }
  const qs = query.toString();
  return apiGet<UserListResponse>(`/users${qs ? `?${qs}` : ""}`);
}

// One tick of live server-side upload progress -- mirrors a "progress" line
// from backend/app/routers/patients.py's upload_patients, which processes
// (and reports on) a file in two phases: validating every row, then saving
// (encrypting + inserting) the accepted ones. `total` is scoped to whichever
// phase is current, not a single upload-wide total -- see that endpoint's
// docstring/comments for why (the combined total isn't knowable until
// validation finishes, since it depends on how many rows get accepted).
export interface UploadProgress {
  phase: "validating" | "saving";
  processed: number;
  total: number;
}

// Uploads a file and streams back live server-side progress as the backend
// works through it, instead of blocking silently until one response at the
// end. The backend returns newline-delimited JSON (NDJSON): repeated
// {"type":"progress",...} lines, then one {"type":"done",...} line whose
// other fields (accepted/rejected/upload_id) become the resolved value.
//
// Built on fetch()+ReadableStream rather than XMLHttpRequest or native
// EventSource/SSE specifically so the Authorization header can be set the
// same way every other call in this file already does -- EventSource can't
// set custom headers at all, and this app's auth token is an in-memory JS
// value attached manually, not a cookie EventSource could ride along with.
// The tradeoff: fetch has no reliable cross-browser upload-progress event,
// so onProgress only starts firing once the server begins streaming back
// results, not during the (brief, previously not very informative) file
// transfer itself.
export async function apiUploadFileWithProgress<T>(
  path: string,
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<T> {
  const token = getAccessToken();
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });

  if (!res.ok || !res.body) {
    throw new ApiError(res.status, await parseBody(res));
  }

  return readNdjsonStream(res, (event) => {
    if (event.type === "progress") {
      onProgress?.({
        phase: event.phase as UploadProgress["phase"],
        processed: event.processed as number,
        total: event.total as number,
      });
      return undefined;
    }
    return {
      accepted: event.accepted,
      rejected: event.rejected,
      upload_id: event.upload_id,
    } as T;
  });
}

// Drains an NDJSON response body, parsing one JSON object per line and handing
// each to `onEvent`. Whatever `onEvent` returns non-undefined becomes the
// resolved value -- i.e. the caller decides which line is terminal and how to
// shape it, while the chunk-buffering/line-splitting (identical for every
// NDJSON endpoint) lives here once.
async function readNdjsonStream<T>(
  res: Response,
  onEvent: (event: Record<string, unknown>) => T | undefined,
): Promise<T> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: T | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line.trim()) continue;

      const returned = onEvent(JSON.parse(line) as Record<string, unknown>);
      if (returned !== undefined) result = returned;
    }
  }

  if (result === undefined) {
    // The stream ended without a terminal line -- a dropped connection, not a
    // clean HTTP error (those already threw before this was called).
    throw new ApiError(0, null);
  }
  return result;
}

// Progress while the server decrypts the patient table for the analytics
// dashboard. Single-phase (unlike UploadProgress), since there's only one
// slow step: decrypting every in-scope row.
export interface AnalyticsProgress {
  processed: number;
  total: number;
}

// Fetches the de-identified analytics projection, streaming progress the same
// way apiUploadFileWithProgress does -- decrypting the whole patient table
// takes long enough on a large dataset that a silent wait would look frozen.
export async function apiGetAnalyticsDataset(
  onProgress?: (progress: AnalyticsProgress) => void,
): Promise<AnalyticsDataset> {
  const token = getAccessToken();
  const res = await fetch(apiUrl("/patients/analytics-dataset"), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok || !res.body) {
    throw new ApiError(res.status, await parseBody(res));
  }

  return readNdjsonStream<AnalyticsDataset>(res, (event) => {
    if (event.type === "progress") {
      onProgress?.({ processed: event.processed as number, total: event.total as number });
      return undefined;
    }
    return {
      total: event.total,
      categories: event.categories,
      multi_value_categories: event.multi_value_categories,
      columns: event.columns,
      quality: event.quality,
    } as AnalyticsDataset;
  });
}

// Auth endpoints below are deliberately not routed through request() --
// they're cookie-authenticated (credentials: "include"), not
// bearer-token-authenticated, and login must work with no access token
// set yet.

export async function apiLogin(payload: LoginRequest): Promise<TokenResponse> {
  const res = await fetch(apiUrl("/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include", // lets the backend set the refresh cookie
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new ApiError(res.status, await parseBody(res));
  }
  const data: TokenResponse = await res.json();
  accessToken = data.access_token;
  return data;
}

export async function apiLogout(): Promise<void> {
  await fetch(apiUrl("/auth/logout"), {
    method: "POST",
    credentials: "include", // sends the refresh cookie so the backend can revoke it
  });
  accessToken = null;
}

// Exported for auth-context.tsx to call once on mount, to restore a
// session from the refresh cookie after a page reload (the in-memory
// access token doesn't survive one).
export { refreshAccessToken };
