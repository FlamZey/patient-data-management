import type {
  LoginRequest,
  PatientListResponse,
  PatientRead,
  PatientUpdate,
  TokenResponse,
} from "./types";

// Checked lazily (not at module load) so importing this module never
// crashes prerendering if the env var happens to be unset at build time --
// it only throws if code actually tries to make a request.
function apiUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_API_URL;
  if (!base) {
    throw new Error("NEXT_PUBLIC_API_URL is not set");
  }
  return `${base}${path}`;
}

export class ApiError extends Error {
  status: number;
  body: unknown;

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

async function parseBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

interface RequestOptions {
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
  isRetry = false,
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
    return undefined as T;
  }

  return (await res.json()) as T;
}

export const apiGet = <T>(path: string, options?: RequestOptions) =>
  request<T>("GET", path, options);

export const apiPost = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>("POST", path, { ...options, body });

export const apiPatch = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>("PATCH", path, { ...options, body });

export const apiDelete = <T>(path: string, options?: RequestOptions) =>
  request<T>("DELETE", path, options);

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

// request() always JSON-encodes via fetch, which has no upload-progress
// event -- this one goes through XMLHttpRequest instead so onProgress can
// be wired to xhr.upload.onprogress.
export function apiUploadFile<T>(
  path: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl(path));

    const token = getAccessToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
      } else {
        reject(new ApiError(xhr.status, body));
      }
    };

    // A network-level failure (no response at all) -- status 0 has no HTTP
    // meaning of its own, it just distinguishes this from a real HTTP error.
    xhr.onerror = () => reject(new ApiError(0, null));

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
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
    credentials: "include",
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
    credentials: "include",
  });
  accessToken = null;
}

// Exported for auth-context.tsx to call once on mount, to restore a
// session from the refresh cookie after a page reload (the in-memory
// access token doesn't survive one).
export { refreshAccessToken };
