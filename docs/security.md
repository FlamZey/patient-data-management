# Security

## Password storage

Passwords are hashed with `bcrypt` (via the `bcrypt` package directly, not stored or compared in plaintext at any point). `UserCreate.password` is validated on input: at least 8 characters, at least one letter, at least one digit, at least one special character.

## Authentication tokens

See `docs/architecture.md` for the reasoning behind the split; this section covers the mechanics.

- **Access token**: a JWT (`HS256`, signed with `SECRET_KEY`), 15-minute default lifetime, holding only the user's id (`sub`) and standard `iat`/`exp` claims. Sent as `Authorization: Bearer <token>`, validated on every request by decoding and verifying the signature — no database lookup required.
- **Refresh token**: a 32-byte random value (`secrets.token_urlsafe`), 7-day default lifetime. The raw value is set as an `httponly`, `secure`, `SameSite=Lax` cookie scoped to path `/auth`, so it is never readable from JavaScript and is only ever sent to the `/auth/*` endpoints that need it. Only a SHA-256 hash of the token is stored in `refresh_tokens.token_hash` — the raw token exists nowhere in the database, so a database read alone cannot be used to impersonate a session. Each use rotates it (the old row is marked `revoked_at`, `replaced_by` points at the new row), so a stolen and reused refresh token invalidates the legitimate session it was stolen from, giving the real user a signal something is wrong.

## Login abuse protection

- **Rate limiting**: `POST /auth/login` is limited to 10 requests/minute per IP (`slowapi`).
- **Account lockout**: 5 consecutive failed password attempts against one account lock it for 15 minutes (`locked_until`), independent of which IP the attempts came from.
- **No email enumeration**: an unknown email and a wrong password for a known email both return an identical `401 Invalid email or password` — an attacker cannot use the login endpoint to discover which emails have accounts.
- Every login attempt, successful or not, and every reason for failure (bad credentials, inactive account, lockout) is written to `audit_logs`.

## Authorization

Role-based access control backed by database tables (`roles`, `permissions`, `role_permissions`) rather than hardcoded role checks — see `docs/architecture.md`. Every mutating endpoint under `/users` requires a specific permission (`user.view`, `user.create`, `user.edit`, `user.delete`), checked by the `require_permission(code)` FastAPI dependency against the caller's actual granted permissions, not their role name.

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

## Soft delete and audit trail

User deletion is a soft delete (`status = "suspended"`, row retained) so account history and audit log references remain intact. `user_created` and `user_deleted` events are written to `audit_logs` with the acting user's id, the affected user's id, and the requester's IP/user agent.

## Patient PHI encryption

Patient `first_name`, `last_name`, `date_of_birth`, and `gender` are encrypted at the application level (AES-256-GCM, `backend/app/core/encryption.py`) before being written to the database — the database never holds this data in plaintext. Each value is encrypted with its own randomly generated nonce, and the stored token (`v{key_version}:{nonce}:{ciphertext}`) is versioned so keys can be rotated without breaking previously stored data. Only `patient_code` is stored unencrypted, since it's the sole lookup/dedupe key and doesn't itself carry PHI (see the `Patient` model docstring). Every read decrypts on the way out; nothing is ever decrypted and cached at rest.

**Search fast path vs. fallback.** The random-per-value nonce that makes the encryption secure also means the ciphertext carries no relationship to the plaintext's order or equality, so PHI fields cannot be filtered or sorted by the database — only decrypted and compared in application code. `GET /patients` (`backend/app/routers/patients.py`) splits on this:

- **Fast path** — a request that sorts by `patient_code` (the one unencrypted field) and applies no PHI filter is filtered, sorted, and paginated entirely in SQL; only the page actually being returned is decrypted.
- **Fallback path** — a request that filters or sorts by a PHI field decrypts the SQL-narrowed candidate set (any `patient_code` filter already applied) and finishes filtering/sorting/pagination in application code.

Making PHI fields searchable in SQL directly was deliberately ruled out: a blind-index (deterministic HMAC) column only supports exact match, not the substring search the UI offers, and deterministic encryption of the fields themselves leaks which rows share a value even to someone without the key. Both trade away confidentiality guarantees for a scale this app doesn't operate at. See `docs/architecture.md` for the full reasoning.

## Known limitations

Documented here rather than left implicit, since a security document that only lists what is implemented is incomplete:

- No multi-factor authentication.
- No CAPTCHA or device fingerprinting on login, beyond the rate limit and account lockout described above.
- Encrypted PHI fields (name, date of birth, gender) cannot be searched, filtered, or sorted at the database layer — only decrypted and compared in application code after being read (see "Search fast path vs. fallback" above). This is a direct consequence of using a random nonce per value, the property that makes the encryption secure, not an oversight: a blind index or deterministic encryption could make these fields DB-searchable, but both trade away confidentiality guarantees this app prioritizes at its current scale.
