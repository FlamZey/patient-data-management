# API Documentation

REST API served by the FastAPI backend. Full interactive documentation, generated from the same code as this file, is available at `/docs` (Swagger UI) once the backend is running.

All request/response bodies are JSON. Authenticated endpoints expect `Authorization: Bearer <access_token>` unless noted otherwise.

## Authentication — `/auth`

### `POST /auth/login`

Rate-limited to 10 requests/minute per IP.

Request body:

```json
{ "email": "admin.us@example.com", "password": "ChangeMe123!" }
```

Response `200`:

```json
{ "access_token": "<jwt>", "token_type": "bearer", "expires_in": 900 }
```

Also sets an `httponly`, `secure`, `SameSite=Lax` refresh token cookie (path `/auth`).

| Status | Meaning                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `401`  | Invalid email or password (also returned for an unknown email — the two are indistinguishable to prevent email enumeration) |
| `403`  | Credentials were correct, but the account's `status` is not `active`                                                        |
| `423`  | Account is locked (5+ consecutive failed attempts); also returned if this attempt is the one that triggers the lock         |
| `429`  | Rate limit exceeded                                                                                                         |

### `POST /auth/refresh`

No request body. Reads the refresh token from the cookie, rotates it (issues a new one, revokes the old one), and returns a new access token in the same shape as `/auth/login`. Also re-sets the refresh cookie.

| Status | Meaning                                                                         |
| ------ | ------------------------------------------------------------------------------- |
| `401`  | No refresh cookie present, or the token is missing, expired, or already revoked |

### `POST /auth/logout`

No request body. Revokes the refresh token identified by the cookie (idempotent — calling it again, or with no cookie, still succeeds) and clears the cookie. Always returns `204`.

### `GET /auth/me`

Returns the current user, in the same shape as the user objects under `/users` below.

| Status | Meaning                                             |
| ------ | --------------------------------------------------- |
| `401`  | Missing, invalid, expired, or tampered access token |
| `403`  | Token is valid, but the account is not `active`     |

### `PATCH /auth/me`

Lets the current user update their own `first_name`/`last_name` — a much smaller surface than `PATCH /users/{id}`, which is admin-only and can also change email/username/role/location/team/status.

Request body:

```json
{ "first_name": "New", "last_name": "Name" }
```

Response `200` returns the updated user, same shape as `GET /auth/me`.

| Status | Meaning                                              |
| ------ | ---------------------------------------------------- |
| `401`  | Missing, invalid, expired, or tampered access token  |
| `422`  | Missing field                                        |

### `POST /auth/me/password`

Changes the current user's own password. Requires the current password to confirm identity. On success, every refresh token for this account is revoked server-side and the refresh cookie is cleared — every session, including the one making this request, must sign in again.

Request body:

```json
{ "current_password": "ChangeMe123!", "new_password": "NewPass456!" }
```

| Status | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| `204`  | Password changed                                               |
| `400`  | `new_password` is the same as the current password             |
| `401`  | Missing/invalid access token, or `current_password` was wrong  |
| `422`  | `new_password` fails the strength rule (see `POST /users`)     |

## Reference data — lookups

Read-only reference data used to populate role/location/team dropdowns in the UI. Each requires only that the caller be authenticated — no specific permission.

- `GET /roles` → active roles, each including its granted `permissions` array (`code`, `resource`, `action`, `description`).
- `GET /locations` → active locations.
- `GET /teams` → active teams.

## User management — `/users`

Every endpoint requires authentication plus the specific permission noted. Permissions are checked against the caller's role, not their role name — see `docs/architecture.md`.

### `GET /users`

Requires `user.view`. Returns every user (all statuses).

### `GET /users/{id}`

Requires `user.view`.

| Status | Meaning              |
| ------ | -------------------- |
| `404`  | No user with that id |

### `POST /users`

Requires `user.create`. Writes an `audit_logs` row (`event_type: "user_created"`) on success.

Request body:

```json
{
  "email": "new.hire@example.com",
  "username": "new.hire",
  "password": "AtLeast8Chars1",
  "first_name": "New",
  "last_name": "Hire",
  "role_id": 3,
  "location_id": 1,
  "team_id": null
}
```

`password` must be at least 8 characters and contain at least one letter and one digit. Response `201` returns the created user (password never included).

| Status | Meaning                                                                 |
| ------ | ----------------------------------------------------------------------- |
| `409`  | Email or username already in use                                        |
| `422`  | Validation failure (missing field, weak password, invalid email format) |

### `PATCH /users/{id}`

Requires `user.edit`. All fields optional — only fields present in the request body are updated. `password` cannot be changed through this endpoint (there is no password-reset flow yet).

| Status | Meaning                                             |
| ------ | --------------------------------------------------- |
| `404`  | No user with that id                                |
| `409`  | Email or username already in use by another account |

### `DELETE /users/{id}`

Requires `user.delete`. Soft-deletes: sets `status = "suspended"`, does not remove the row. Writes an `audit_logs` row (`event_type: "user_deleted"`). Returns `204`. Idempotent — deleting an already-suspended user still succeeds.

| Status | Meaning              |
| ------ | -------------------- |
| `404`  | No user with that id |

## User object shape

Returned by `GET /auth/me` and every `/users` endpoint that returns a user:

```json
{
  "id": "uuid",
  "email": "string",
  "username": "string",
  "first_name": "string",
  "last_name": "string",
  "status": "active | suspended | locked | pending",
  "failed_login_count": 0,
  "locked_until": "datetime | null",
  "last_login_at": "datetime | null",
  "password_changed_at": "datetime | null",
  "created_at": "datetime",
  "updated_at": "datetime",
  "role": { "id": 1, "name": "admin", "display_name": "Administrator", "permissions": ["..."] },
  "location": { "id": 1, "code": "US", "name": "United States" },
  "team": null
}
```

## Health check

`GET /health` — unauthenticated, returns `{"status": "ok"}`. Used for container liveness checks.
