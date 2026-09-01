# Security

## Password storage

Passwords are hashed with `bcrypt` (via the `bcrypt` package directly, not stored or compared in plaintext at any point). `UserCreate.password` is validated on input: at least 8 characters, at least one letter, at least one digit, at least one special character.

## Authentication tokens

See `docs/architecture.md` for the reasoning behind the split; this section covers the mechanics.

- **Access token**: a JWT (`HS256`, signed with `SECRET_KEY`), 15-minute default lifetime, holding only the user's id (`sub`) and standard `iat`/`exp` claims. Sent as `Authorization: Bearer <token>`, validated on every request by decoding and verifying the signature — no database lookup required.
- **Refresh token**: a 32-byte random value (`secrets.token_urlsafe`), 7-day default lifetime. The raw value is set as an `httponly`, `secure`, `SameSite=Lax` cookie scoped to path `/auth`, so it is never readable from JavaScript and is only ever sent to the `/auth/*` endpoints that need it. Only a SHA-256 hash of the token is stored in `refresh_tokens.token_hash` — the raw token exists nowhere in the database, so a database read alone cannot be used to impersonate a session. Each use rotates it (the old row is marked `revoked_at`, `replaced_by` points at the new row), so a stolen and reused refresh token invalidates the legitimate session it was stolen from, giving the real user a signal something is wrong.

## Login abuse protection

- **Rate limiting**: `POST /auth/login` is limited to 10 requests/minute per IP (`slowapi`). See "Known limitations" below for the caveats on how this is keyed and stored.
- **Account lockout, scoped to (account, source IP)**: 5 consecutive failed password attempts against one account, from one IP, lock that *pair* for 15 minutes (`login_lockouts` — see `docs/database-schema.md`). Deliberately not a flat per-account counter: that design (the original implementation) blocked the real account owner exactly as hard as whoever was guessing against them, since a lockout keyed only on the account can't tell them apart. Keying on the pair means someone else's wrong guesses, from their own network, never lock the owner out of their own login. The trade-off, kept deliberately: an owner who shares an IP with whoever's guessing (e.g. the same office NAT) is still blocked, and a distributed attacker rotating across many IPs gets a fresh budget on each one — no per-IP scheme closes either of those.
- **No email enumeration, including by timing**: an unknown email and a wrong password for a known email return an identical `401 Invalid email or password` body — but a response that only *looks* identical is not enough if it arrives faster for one case than the other. The password hash is verified unconditionally, against a fixed dummy hash when no account matches, so an unknown email costs the same ~200ms of `bcrypt` work as a real one instead of returning in a few milliseconds — closing a side channel that let a single request classify any address by response time alone, independent of the (already-identical) response body.
- Every login attempt, successful or not, and every reason for failure (bad credentials, inactive account, lockout) is written to `audit_logs`.

## Authorization

Role-based access control backed by database tables (`roles`, `permissions`, `role_permissions`) rather than hardcoded role checks — see `docs/architecture.md`. Authorization is enforced in three distinct layers, all defined in `backend/app/core/` and never re-implemented inside a router:

1. **Permission authorization** — `require_permission(*codes)` / `require_any_permission(*codes)` (`app/core/deps.py`) gate each endpoint on the caller's actual granted permissions, not their role name. A deactivated role (`roles.is_active = false`) grants nothing.
2. **Field-level authorization** — a caller allowed to edit a user is not thereby allowed to change that user's role or account status. `PRIVILEGED_USER_FIELDS` in `app/core/authz.py` maps each privileged request-body field to the permission it needs (`role_id` → `role.assign`, `status` → `user.suspend`), and `authorize_user_update` checks the exact set of fields a request carries. A schema that *accepts* a field is never treated as permission to *set* it.
3. **Resource-level authorization** — whether the caller may act on this particular row. For users that is the role hierarchy (`roles.parent_role_id`): nobody may modify an account more senior than their own, assign a role more senior than their own, or change their own role or status. For patients it is upload ownership (below).

The permission catalog itself lives in `app/core/permissions.py` and is the single source of truth for *which permissions exist*: `app/bootstrap.py` reconciles the `permissions` table against it, deleting codes the application no longer enforces so a dead code can never be granted to anyone. That sync runs automatically on backend startup (`backend/docker-entrypoint.sh`), so the enforced catalog and the database cannot drift apart across a deploy. *Which roles hold which permissions* is owned by the database instead — the catalog's grants are defaults applied at role creation, and a later change made directly in `role_permissions` is durable (see `docs/architecture.md`). `backend/tests/test_authorization.py` asserts that every catalogued permission is actually referenced by enforcement code, so a permission that is defined but never checked fails the test suite.

Frontend permission checks (`frontend/lib/permissions.ts`) decide what the UI *offers*; they are never the security boundary. Every control they hide has a matching server-side check, and `backend/tests/test_authorization.py` drives those checks over real HTTP.

## Input validation

All request bodies are validated by Pydantic schemas before any endpoint code runs — type mismatches, missing required fields, and invalid email formats are rejected with `422` automatically. `UserCreate.password` additionally enforces the strength rule described above.

## API design

RESTful API design, using standard HTTP status codes to convey outcome.

## Data access

All database queries go through SQLAlchemy's ORM query builder, which parameterizes every value; no endpoint builds SQL from string interpolation or user input, so standard SQL injection is not applicable to this codebase's current query patterns.

## Cross-origin and cross-site protections

- **CORS**: only origins listed in `CORS_ORIGINS` (the frontend's own origin) may call the API from a browser.
- **CSRF**: the refresh cookie's `SameSite=Lax` attribute prevents it from being attached to cross-site `POST` requests, which covers `/auth/refresh` and `/auth/logout`, the only two endpoints that rely on the cookie. Every other endpoint is authenticated via the `Authorization` header instead of a cookie, which a cross-site page cannot make the browser attach automatically — so CSRF does not apply to the rest of the API by construction, not by an additional CSRF token.

## Cross-site scripting (XSS)

- **Token storage**: the access token is kept in a plain in-memory JS variable (`frontend/lib/api.ts`) — never written to `localStorage` or `sessionStorage` — so a page reload requires a fresh silent refresh via the `httponly` cookie rather than reading a persisted token.
- **Output escaping**: every place user-supplied data is rendered (names, emails, role/location/team names across `dashboard/page.tsx`, `settings/page.tsx`, `UserFormDialog.tsx`, `NavBar.tsx`, `ConfirmDialog.tsx`) goes through plain JSX `{value}` interpolation, which React escapes automatically. A full pass over the frontend found no use of `dangerouslySetInnerHTML`, `innerHTML`, `eval(`, or `document.write` anywhere in the app's own code.

## HTTP security headers

Applied to every response by one middleware (`backend/app/main.py: add_security_headers`), mirrored on the frontend's own responses (`frontend/next.config.ts`) so both origins this app serves from carry the same set. None of these stop an attack on their own — each limits how bad a *different* bug becomes (a stray XSS, a hostile page framing this app, a plain-HTTP link) — which is exactly why they're worth having regardless of whether that other bug currently exists:

| Header | Value | What it limits |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | A browser reinterpreting a response as a different content type than declared |
| `X-Frame-Options` | `DENY` | Clickjacking — another site framing this app and overlaying controls on it |
| `Referrer-Policy` | `no-referrer` | This app's URLs (which can carry patient/user ids) leaking to other sites via the `Referer` header |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | The first plain-HTTP request before HTTPS is enforced — pairs with the refresh cookie's own `secure=True` |

## Soft delete and audit trail

User deletion is a soft delete (`status = "suspended"`, row retained) so account history and audit log references remain intact. `user_created` and `user_deleted` events are written to `audit_logs` with the acting user's id, the affected user's id, and the requester's IP/user agent.

## Patient PHI encryption

Patient `first_name`, `last_name`, `date_of_birth`, and `gender` are encrypted at the application level (AES-256-GCM, `backend/app/core/encryption.py`) before being written to the database — the database never holds this data in plaintext. Each value is encrypted with its own randomly generated nonce, and the stored token (`v{key_version}:{nonce}:{ciphertext}`) is versioned so keys can be rotated without breaking previously stored data. Only `patient_code` is stored unencrypted, since it's the sole lookup/dedupe key and doesn't itself carry PHI (see the `Patient` model docstring). Every read decrypts on the way out; nothing is ever decrypted and cached at rest.

**Search fast path vs. fallback.** The random-per-value nonce that makes the encryption secure also means the ciphertext carries no relationship to the plaintext's order or equality, so PHI fields cannot be filtered or sorted by the database — only decrypted and compared in application code. `GET /patients` (`backend/app/routers/patients.py`) splits on this:

- **Fast path** — a request that sorts by `patient_code` (the one unencrypted field) and applies no PHI filter is filtered, sorted, and paginated entirely in SQL; only the page actually being returned is decrypted.
- **Fallback path** — a request that filters or sorts by a PHI field decrypts the SQL-narrowed candidate set (any `patient_code` filter already applied) and finishes filtering/sorting/pagination in application code.

Making PHI fields searchable in SQL directly was deliberately ruled out: a blind-index (deterministic HMAC) column only supports exact match, not the substring search the UI offers, and deterministic encryption of the fields themselves leaks which rows share a value even to someone without the key. Both trade away confidentiality guarantees for a scale this app doesn't operate at. See `docs/architecture.md` for the full reasoning.

## Patient data access scoping

`GET /patients`, `GET /patients/{id}`, `GET /patients/analytics-dataset`, `PATCH /patients/{id}`, and `DELETE /patients/{id}` all scope results to `Patient.uploaded_by == current_user.id` — a caller sees only the patients *they* uploaded. Two separate permissions lift that filter, and the split matters: `patient.view_all` lifts it for **reads** only, while editing or deleting another uploader's row requires `patient.manage_all`. Being allowed to see every uploader's records is not authority to change them. Both are granted to `admin` only (per `backend/app/core/permissions.py`). The scope is resolved centrally by `authz.patient_owner_scope` and applied per-request in `backend/app/routers/patients.py`, not by a database-level policy. An out-of-scope row returns `404`, not `403`, so a caller cannot probe which ids exist.

## Patient upload validation

`POST /patients/upload` (`backend/app/services/patient_import.py`) rejects a workbook outright (before any row is imported) for a missing/extra required column, an unsupported file extension, more than 50,000 data rows, or a declared size over 10MB (checked against the size the multipart parser already tracked while streaming the upload in, before the body is read into memory — not after). The row cap exists because the 10MB limit alone doesn't bound it: `.xlsx` is compressed XML, and a plain patient roster compresses around 15x, so a file well under 10MB can still carry hundreds of thousands of rows — the cap is enforced inside the read itself (stopping the moment it's crossed), not by reading the whole file first and rejecting afterward. Per-row validation then applies to every field, accepted or rejected independently per row:

- **Formula-injection guard**: any cell value beginning with `=`, `+`, `-`, or `@` — the characters that make a cell a formula in Excel/Sheets/LibreOffice — is rejected. Without this, a malicious upload could plant a formula (e.g. one that shells out or calls a remote URL) that fires when a downstream operator later opens the exported/re-opened spreadsheet.
- **Duplicate `Patient ID` (`patient_code`)**: checked both within the file being uploaded and against the caller's own existing patients (the field is globally unique, but the pre-upload check is scoped to what the caller can already see) — see `docs/database-schema.md`. A code already claimed by a *different* uploader passes that pre-check but still fails the database's global uniqueness constraint once the write is attempted; rather than crash the stream (the `201` has already gone out by that point, since the response streams progress as it works), the upload transaction rolls back in full and the stream ends with an explicit `{"type": "error", ...}` line instead of the connection just dying — see `docs/api-documentation.md`.
- Type/format checks per field: date of birth and the two visit/registration dates must parse as valid dates, `Gender` and the other enum-like optional fields (blood type, marital status, race/ethnicity, smoking status, alcohol use, care department, emergency contact relationship) must match a known value, numeric fields (height, weight, blood pressure) must parse as integers in a plausible range.

`PATCH /patients/{id}` runs the same field validators as the upload path (`app/schemas.py: PatientUpdate`), so a manual edit is held to the same formula-injection and format rules as a bulk import — a gap fixed after the update endpoint originally skipped them.

## Concurrent writes

Every insert guarded by a uniqueness check (`POST /users`, `PATCH /users/{id}`'s email/username check, and the patient upload collision above) follows the same pattern: a plain `SELECT` first, for a fast, field-specific `409`/error on the common case, *and* a caught `IntegrityError` around the actual write, for the rare case where two requests race the same check and both pass it. The second layer matters because the first one, alone, has a real gap — two concurrent requests can both query before either has written, both see "not taken," and both attempt the write; the loser hits the database's unique constraint instead of the check. Without the second layer that surfaced as an unhandled `500` (verified live: 6 truly concurrent signups for one email returned `[500, 500, 500, 500, 201, 500]` before this existed); with it, the loser rolls back and re-runs the same check against the now-visible winner, returning the correct `409`/error response instead.

The account-lockout counter (`login_lockouts.failed_login_count` above) has the same class of bug in a different shape: incrementing it as `count += 1` in Python is a read-then-write, and two concurrent failed attempts against the same `(account, IP)` pair can both read the same value and each write back the same "+1" — silently losing an attempt rather than crashing (verified: 8 concurrent failures left the count at 2, not 8). It's incremented with an atomic SQL `UPDATE ... SET count = count + 1` instead, which Postgres serializes correctly under concurrency without the application needing its own locking.

## Rate limits

| Endpoint                          | Limit            | Why                                                                             |
| --------------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `POST /auth/login`                | 10/minute per IP | Slows credential-stuffing; see "Login abuse protection" above                   |
| `POST /users`                     | 10/minute per IP | Same reasoning, applied to account creation                                     |
| `POST /patients/upload`           | 5/minute per IP  | Upload is the most expensive endpoint (per-row encryption of up to 10,000 rows) |
| `GET /patients/analytics-dataset` | 10/minute per IP | Decrypts and streams the caller's entire patient set                            |

## Audit logging

Every security- or data-relevant action writes a row to `audit_logs` (`user_id`, `event_type`, a JSON `event_detail`, requester IP/user agent, timestamp — see `docs/database-schema.md`). Event types in use: `login_success`, `login_failure`, `user_created`, `user_deleted`, `patient_upload`, `patient_view`, `patient_edit`, `patient_delete`, `patient_analytics_view`.

`patient_edit` and `patient_analytics_view` deliberately log only metadata (field names changed; row counts) and never the underlying PHI values, so the audit trail itself never becomes a second place patient data leaks from.

## Known limitations

Documented here rather than left implicit, since a security document that only lists what is implemented is incomplete:

- No multi-factor authentication.
- No CAPTCHA or device fingerprinting on login, beyond the rate limit and account lockout described above.
- Encrypted PHI fields (name, date of birth, gender) cannot be searched, filtered, or sorted at the database layer — only decrypted and compared in application code after being read (see "Search fast path vs. fallback" above). This is a direct consequence of using a random nonce per value, the property that makes the encryption secure, not an oversight: a blind index or deterministic encryption could make these fields DB-searchable, but both trade away confidentiality guarantees this app prioritizes at its current scale.
- **Interactive API docs are unauthenticated.** `/docs` and `/openapi.json` (FastAPI's defaults) answer with no login required, and the root path (`/`) redirects a bare visit straight to `/docs`. Neither exposes data — it's the API's shape (routes, parameters, schemas), not any row of it — but for a system holding PHI, publishing that shape to anyone who finds the host is more than a typical deployment would choose to leave open. Not yet gated behind a settings flag.
- **The rate limiter assumes a deployment topology this app doesn't have yet.** `backend/app/core/limiter.py` keys each caller by the direct TCP peer address and counts in the current process's own memory — both correct for the single, directly-reachable process this runs as today, and both wrong the moment either changes: behind a reverse proxy/load balancer, every caller would share one address (the proxy's) and so one shared bucket; running more than one worker or replica, each gets its own counter, so `10/minute` silently becomes `10/minute × process count`. The fix (`storage_uri` pointed at a shared store, plus `--proxy-headers --forwarded-allow-ips=<the proxy>` so only a specifically trusted hop's forwarding header is believed) is noted in the file but not built, since it depends on a real answer to "what's in front of this app," which doesn't exist yet. Today's behavior is the safe failure mode in the meantime: `X-Forwarded-For` is not read at all, so nothing can currently spoof a different rate-limit identity via that header.
