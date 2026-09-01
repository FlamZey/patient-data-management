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

Two things are deliberately owned by different sides, and `app/bootstrap.py` enforces the split:

- **Which permissions exist** is owned by the code. A permission is only real because some line of code enforces it, so `app/core/permissions.py` is authoritative: the sync inserts, refreshes, and deletes rows to match it, and a code retired from the catalog takes its grants with it via the `role_permissions` cascade. A permission inserted directly into the table is removed on the next run.
- **Which roles hold which permissions** is owned by the database. `DEFAULT_ROLE_PERMISSIONS` supplies *defaults*, applied when a role is first created and never again — so a grant added or revoked at runtime survives every later sync, and the claim above holds literally.

The cost of that second rule is worth stating: a permission newly added to the catalog is **not** back-filled onto existing roles, because doing so would mean overwriting operator decisions. Someone has to grant it. `python -m app.bootstrap --reset-grants` forces every seeded role back to its catalog defaults when that drift isn't wanted.

Permissions name *actions*, not resources. `user.edit` covers profile data only; assigning a role (`role.assign`) and changing an account's status (`user.suspend`) are separate permissions, because each is a distinct authorization decision — the alternative, one broad "can edit users" permission, made every profile editor a de-facto administrator via the request body. Which fields need which permission is declared once, in `PRIVILEGED_USER_FIELDS` (`app/core/authz.py`), rather than re-checked in each router.

`roles.parent_role_id` (admin ← manager ← user) is also consulted at request time, not just stored: a caller may only modify accounts whose role is strictly *below* their own, and may not assign a role more senior than their own. Authority runs downward only — peers are excluded, since two managers are not each other's supervisor and a lateral edit is not something any permission is meant to authorize. The one exception is your own record, which you can always edit (bounded by the separate rules forbidding changes to your own role or status). That makes escalation structurally impossible rather than dependent on which permissions happen to be granted — even a role wrongly given `role.assign` still cannot hand out admin.

The same principle extends to `Location` and `Team`: both are tables, not enums, so new locations or teams don't require a code change either.

## Soft delete for users

`DELETE /users/{id}` never removes a row — it sets `status = "suspended"`. Patient-data-adjacent systems generally need an audit trail of who existed and what they did, even after their access is revoked; a hard delete would break that trail and any foreign keys (audit log entries, refresh token history) pointing at the user. Suspending is also reversible by an admin re-activating the account, where a hard delete is not.

## Frontend: permission-aware navigation, not just route guards

Beyond the standard "redirect to `/login` if not authenticated" guard, pages, navigation links, and individual table controls check the current user's actual permission list (`currentUser.role.permissions`) rather than their role name. The user-management table gates its Role select on `role.assign` and its Status select on `user.suspend` separately from its profile inputs (`user.edit`), mirroring the backend's field-level rules — so the UI never offers a control whose only possible outcome is a `403`. These checks decide what is *offered*; the backend decides what *happens*. A nav link checking `role.name === "admin"` would silently break the moment a `manager` role was also granted `user.view` in the database; checking for the permission code directly stays correct regardless of how roles are reconfigured, consistent with the database-driven authorization model above.

## Rate limiting and account lockout

`POST /auth/login` is rate-limited (10 requests/minute per IP) to slow down a single high-volume attacker. Separately, 5 consecutive failed password attempts against one account lock it out for 15 minutes — but scoped to the *(account, source IP)* pair (`login_lockouts`, see `docs/database-schema.md`), not the account alone.

That scoping was a deliberate reversal of the original design, which locked the account outright regardless of who was asking. The original version stopped a low-and-slow attacker rotating across many IPs to guess one account's password — but it also meant anyone else's wrong guesses against your email, from their own network, locked *you* out of your own login for 15 minutes, since a lockout keyed only on the account can't distinguish the real owner from whoever's guessing. Keying on the pair fixes that: someone else's failures accumulate on their own IP's row, never yours. The trade-off kept deliberately, in exchange: this app no longer stops a distributed attacker who rotates IPs — each new IP gets its own fresh budget — and an owner who happens to share an IP with whoever's guessing (the same office NAT, for instance) is still blocked, since no per-IP scheme can tell those two apart. Given the alternative was locking out the legitimate user on every single occurrence, that trade was judged worth making.

## Patient search: a SQL fast path around encrypted fields

Patient PHI (first name, last name, date of birth, gender) is encrypted at the application layer before storage, with a fresh random nonce generated per value (see `docs/security.md`). That's what makes the encryption secure, but it also means the ciphertext carries no relationship to the plaintext's order or equality — those fields fundamentally cannot be filtered or sorted by the database. Only `patient_code`, kept unencrypted specifically to support lookup and indexing (see the `Patient` model docstring), can be.

`GET /patients` handles this with two paths rather than one:

- **Fast path** — when the request sorts by `patient_code` and applies no PHI filter, filtering, sorting, and pagination all happen in SQL, and only the page actually being returned gets decrypted.
- **Fallback path** — any request that filters or sorts by a PHI field decrypts the SQL-narrowed candidate set (still scoped to the uploader, and to any `patient_code` filter) and finishes filtering/sorting/pagination in application code, the same way every request used to work before the fast path existed.

This was chosen over making PHI fields searchable in SQL directly — a blind-index (deterministic HMAC) column, or deterministic encryption of the fields themselves — because both trade away real confidentiality guarantees (a blind index only supports exact match, not the substring search the UI offers, and would need a second column per searchable field; deterministic encryption leaks which rows share a value even to someone without the key) for a scale this app doesn't operate at. Even the fallback path — full decrypt-then-filter, exactly as it worked before this optimization — stays fast enough to not be user-visible at the target scale (up to 10,000 patient records); it's kept only because it's the correct behavior for the minority of requests the fast path can't cover, not because it's slow enough to need replacing.

## Patient scoping: per-uploader visibility, not per-role

A `manager`'s `GET /patients` (and every other read/write endpoint under `/patients`) only ever returns rows where `uploaded_by == current_user.id`. This wasn't modeled as another RBAC permission check (e.g. "can view patients") because visibility here isn't about a role at all — two managers with an identical role and permission set still shouldn't see each other's uploads by default. Instead, scoping is a row filter applied per-request in `backend/app/routers/patients.py`, and the escape hatches are `patient.view_all` (reads) and `patient.manage_all` (writes), granted to `admin` only — see `backend/app/core/permissions.py`. They drop the filter entirely rather than expanding it to "your team" or similar; there was no requirement for anything between "your own uploads" and "everything." Read and write are two permissions rather than one because an auditor who should see every uploader's records should not thereby be able to delete them.

## De-identified analytics dataset, not raw export

`GET /patients/analytics-dataset` (`backend/app/routers/patients.py`) exists because the dashboard needs aggregate/distributional views (age, geography, conditions) across potentially thousands of patients, and decrypting+shipping full `PatientRead` objects for all of them just to compute chart buckets client-side would both be slow and hand the browser far more PHI than any chart needs. Instead the endpoint projects to a fixed, narrow set of columns server-side — no id, `patient_code`, name, contact info, or exact dates — before it ever leaves the database layer (`load_only` on the SQLAlchemy query), and dictionary-encodes categorical values into small integer codes rather than repeating strings per row. The three fields still decrypted (name × 2, date of birth) exist only to compute aggregate data-quality counts (possible duplicate identities, implausible dates) that are emitted as numbers, never as the values themselves.
