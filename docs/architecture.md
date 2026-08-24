# Architecture Decisions

## Technology choices

| Layer            | Choice                          | Why                                                                                                  |
| ---------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Frontend         | Next.js + TypeScript + Tailwind | Type safety, responsive UI, and a fast development experience                                        |
| Backend          | FastAPI + SQLAlchemy            | Fast API development, automatic OpenAPI docs, and an easy way to work with the database using an ORM |
| Database         | PostgreSQL                      | Reliable relational database for users, roles, permissions, teams, and locations                     |
| Containerization | Docker Compose                  | Single-command local setup and a consistent environment across machines                              |

## Authentication: split token model

Sessions are two tokens with different lifetimes and different revocation guarantees, not one:

- **Access token** — a stateless JWT, short-lived (15 minutes by default), sent as `Authorization: Bearer <token>` on every API request and kept only in frontend memory (never `localStorage`). Stateless means the backend never has to look it up in the database to validate it, but also means it cannot be revoked before it expires.
- **Refresh token** — a long-lived (7 days by default), high-entropy opaque token, stored in the browser only as an `httponly` cookie scoped to `/auth`, and recorded server-side (hashed, never in plaintext) in the `refresh_tokens` table. Because the server holds a record of it, it can be revoked instantly on logout, and reused/stolen tokens can be detected.

The frontend never has to prompt for credentials again during a session: shortly before an access token expires, it silently calls `POST /auth/refresh`, which validates the refresh token, rotates it (issues a new one and revokes the old one), and returns a new access token. This is what makes the short access-token lifetime practical without constantly re-authenticating the user.

## Authorization: database-driven RBAC

Roles and permissions are rows, not code. `Role`, `Permission`, and the `role_permissions` join table define who can do what, and `require_permission("user.edit")` (a FastAPI dependency) checks a user's role's permission set at request time. The alternative — hardcoding `if user.role == "admin"` checks throughout the codebase — was rejected because it means a code change and a deploy every time access rules change; with this model, granting a role a new permission is a database write.

The same principle extends to `Location` and `Team`: both are tables, not enums, so new locations or teams don't require a code change either.

## Soft delete for users

`DELETE /users/{id}` never removes a row — it sets `status = "suspended"`. Patient-data-adjacent systems generally need an audit trail of who existed and what they did, even after their access is revoked; a hard delete would break that trail and any foreign keys (audit log entries, refresh token history) pointing at the user. Suspending is also reversible by an admin re-activating the account, where a hard delete is not.

## Frontend: permission-aware navigation, not just route guards

Beyond the standard "redirect to `/login` if not authenticated" guard, pages and navigation links individually check the current user's actual permission list (`currentUser.role.permissions`) rather than their role name. A nav link checking `role.name === "admin"` would silently break the moment a `manager` role was also granted `user.view` in the database; checking for the permission code directly stays correct regardless of how roles are reconfigured, consistent with the database-driven authorization model above.

## Rate limiting and account lockout

`POST /auth/login` is rate-limited (10 requests/minute per IP) to slow down credential-stuffing attempts, and independently, an account locks for 15 minutes after 5 consecutive failed password attempts against it, regardless of IP. These address different attackers: the rate limit slows down a single high-volume attacker; the lockout stops a low-and-slow attacker rotating IPs to guess one specific account's password.

## Patient search: a SQL fast path around encrypted fields

Patient PHI (first name, last name, date of birth, gender) is encrypted at the application layer before storage, with a fresh random nonce generated per value (see `docs/security.md`). That's what makes the encryption secure, but it also means the ciphertext carries no relationship to the plaintext's order or equality — those fields fundamentally cannot be filtered or sorted by the database. Only `patient_code`, kept unencrypted specifically to support lookup and indexing (see the `Patient` model docstring), can be.

`GET /patients` handles this with two paths rather than one:

- **Fast path** — when the request sorts by `patient_code` and applies no PHI filter, filtering, sorting, and pagination all happen in SQL, and only the page actually being returned gets decrypted.
- **Fallback path** — any request that filters or sorts by a PHI field decrypts the SQL-narrowed candidate set (still scoped to the uploader, and to any `patient_code` filter) and finishes filtering/sorting/pagination in application code, the same way every request used to work before the fast path existed.

This was chosen over making PHI fields searchable in SQL directly — a blind-index (deterministic HMAC) column, or deterministic encryption of the fields themselves — because both trade away real confidentiality guarantees (a blind index only supports exact match, not the substring search the UI offers, and would need a second column per searchable field; deterministic encryption leaks which rows share a value even to someone without the key) for a scale this app doesn't operate at. Even the fallback path — full decrypt-then-filter, exactly as it worked before this optimization — stays fast enough to not be user-visible at the target scale (up to 10,000 patient records); it's kept only because it's the correct behavior for the minority of requests the fast path can't cover, not because it's slow enough to need replacing.
