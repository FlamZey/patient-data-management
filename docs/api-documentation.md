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

| Status | Meaning                                             |
| ------ | --------------------------------------------------- |
| `401`  | Missing, invalid, expired, or tampered access token |
| `422`  | Missing field                                       |

### `POST /auth/me/password`

Changes the current user's own password. Requires the current password to confirm identity. On success, every refresh token for this account is revoked server-side and the refresh cookie is cleared — every session, including the one making this request, must sign in again.

Request body:

```json
{ "current_password": "ChangeMe123!", "new_password": "NewPass456!" }
```

| Status | Meaning                                                       |
| ------ | ------------------------------------------------------------- |
| `204`  | Password changed                                              |
| `400`  | `new_password` is the same as the current password            |
| `401`  | Missing/invalid access token, or `current_password` was wrong |
| `422`  | `new_password` fails the strength rule (see `POST /users`)    |

## Reference data — lookups

Read-only reference data used to populate the user-management dropdowns and column filters. Each requires `user.view` — these exist only to support user management, and being merely authenticated is not enough.

- `GET /roles` → active roles (`id`, `name`, `display_name`, `parent_role_id`, `description`, `is_active`). Each role's granted `permissions` array is deliberately **not** included; a caller's own permissions come back from `GET /auth/me`.
- `GET /locations` → active locations.
- `GET /teams` → active teams.

## User management — `/users`

Every endpoint requires authentication plus the specific permission noted. Permissions are checked against the caller's role, not their role name — see `docs/architecture.md`.

### `GET /users`

Requires `user.view`. Filterable, sortable, paginated list of every user (all statuses).

Query parameters (all optional): `name`, `email` (prefix match), `role`, `location`, `team` (each repeatable, exact match against display name — `team=Unassigned` matches users with no team), `status` (repeatable), `sort_by` (`name` | `email` | `role` | `location` | `team` | `status`, default `name`), `sort_dir` (`asc` | `desc`, default `asc`), `page` (default `1`), `page_size` (default `25`, max `200`).

Response `200`:

```json
{ "items": [ /* UserRead objects, see below */ ], "total": 42 }
```

### `GET /users/{id}`

Requires `user.view`.

| Status | Meaning              |
| ------ | -------------------- |
| `404`  | No user with that id |

### `POST /users`

Requires `user.create` **and** `role.assign` — every new account is handed a `role_id`, which is a role assignment like any other. The role being assigned must not be more senior than the caller's own (by `roles.parent_role_id`), so a non-admin can never mint an admin account. Writes an `audit_logs` row (`event_type: "user_created"`) on success.

Request body:

```json
{
  "email": "new.hire@example.com",
  "username": "new.hire",
  "password": "AtLeast8Chars1!",
  "first_name": "New",
  "last_name": "Hire",
  "role_id": 3,
  "location_id": 1,
  "team_id": null
}
```

`password` must be at least 8 characters and contain at least one letter, one digit, and one special character. Response `201` returns the created user (password never included).

| Status | Meaning                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `403`  | Missing `role.assign`, or the requested role is more senior than the caller's                                               |
| `409`  | Email or username already in use                                                                                            |
| `422`  | Validation failure (missing field, weak password, invalid email format, unknown/inactive `role_id`/`location_id`/`team_id`) |

### `PATCH /users/{id}`

Requires **at least one** of `user.edit`, `role.assign`, `user.suspend`; each body field is then authorized individually against the caller's permissions (`app/core/authz.py`). All fields optional — only fields present in the request body are updated. `password` cannot be changed through this endpoint (there is no password-reset flow yet).

| Field(s)                                                                 | Permission required |
| ------------------------------------------------------------------------ | ------------------- |
| `email`, `username`, `first_name`, `last_name`, `location_id`, `team_id` | `user.edit`         |
| `role_id`                                                                | `role.assign`       |
| `status`                                                                 | `user.suspend`      |

Additional rules, enforced regardless of permissions held:

- The target's role must be strictly **below** the caller's own (`roles.parent_role_id`). Peers are refused: one manager may not edit another, and an admin may not edit another admin. Acting on your *own* record is exempt from this test.
- `role_id` may not name a role more senior than the caller's own.
- Nobody may change their **own** `role_id` or `status`.
- Authorization runs before any field is written, so a request mixing an allowed field with a forbidden one applies *neither*.
- A change to `role_id` or `status` writes an `audit_logs` row (`role_change` / `status_change`). Moving an account out of `active` also revokes its refresh tokens.

| Status | Meaning                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------- |
| `403`  | Missing the permission for a field in the body, or a seniority/self-modification rule was violated |
| `404`  | No user with that id                                                                               |
| `409`  | Email or username already in use by another account                                                |
| `422`  | Unknown or inactive `role_id`, `location_id`, or `team_id`                                         |

### `DELETE /users/{id}`

Requires `user.delete`. Soft-deletes: sets `status = "suspended"`, does not remove the row, and revokes the account's refresh tokens. Writes an `audit_logs` row (`event_type: "user_deleted"`). Returns `204`. Idempotent — deleting an already-suspended user still succeeds. A caller may not deactivate their own account, nor an account whose role is more senior than theirs.

| Status | Meaning                                                                                     |
| ------ | ------------------------------------------------------------------------------------------- |
| `403`  | Self-deactivation, or the target's role is not strictly below the caller's (peers included) |
| `404`  | No user with that id                                                                        |

## Patient records — `/patients`

Every endpoint requires authentication plus the specific permission noted. By default every endpoint scopes results to patients *they* uploaded (`uploaded_by == current_user.id`). Two separate permissions lift that filter: `patient.view_all` for **reads**, and `patient.manage_all` for **writes** (edit/delete) — being able to see every uploader's records is not authority to change them. See `docs/architecture.md` and `docs/security.md`. PHI fields are encrypted at rest and always returned decrypted in JSON responses.

### `POST /patients/upload`

Requires `patient.create`. Rate-limited to 5 requests/minute per IP. Accepts a `multipart/form-data` body with one `file` field — an `.xlsx` workbook, max 10MB, matching the columns in the `docs/samples/` template.

Header/format problems (bad extension, missing/extra required columns) fail fast with a `422` before any streaming begins. Once the file passes that check, the response streams newline-delimited JSON (`application/x-ndjson`), one JSON object per line:

```json
{"type": "progress", "phase": "validating", "processed": 500, "total": 2000}
{"type": "progress", "phase": "saving", "processed": 500, "total": 1800}
{"type": "done", "accepted": 1800, "rejected": [{"row": 12, "field": "Date of Birth", "reason": "..."}], "upload_id": "uuid"}
```

Rows are validated per-field (required columns, date/gender format, formula-injection characters, duplicate `Patient ID` — both within the file and against the caller's existing patients) and rejected individually; the accepted rows are still imported. A `patient_upload` event is written to `audit_logs` on completion.

| Status | Meaning                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------- |
| `201`  | Streamed response started (per-row outcomes are in the final `done` line, not the status code) |
| `413`  | File exceeds the 10MB limit                                                                    |
| `422`  | Missing filename, wrong extension, or missing/extra required columns                           |
| `429`  | Rate limit exceeded                                                                            |

### `GET /patients`

Requires `patient.view`. Filterable, sortable, paginated list.

Query parameters (all optional): `patient_code` (prefix match), `first_name` / `last_name` (prefix match), `gender` (repeatable), `date_of_birth_from` / `date_of_birth_to` (inclusive range, `YYYY-MM-DD`), `sort_by` (`patient_code` | `first_name` | `last_name` | `date_of_birth`, default `patient_code`), `sort_dir` (`asc` | `desc`, default `asc`), `page` (default `1`), `page_size` (default `25`, max `500`).

Sorting by `patient_code` with no PHI filter is resolved entirely in SQL; any other combination decrypts the caller's scoped rows in application code before filtering/sorting — see `docs/architecture.md` for why.

Response `200`:

```json
{ "items": [ /* PatientRead objects, see below */ ], "total": 1800 }
```

### `GET /patients/analytics-dataset`

Requires `patient.view`. Rate-limited to 10 requests/minute per IP. Streams a **de-identified** columnar dataset for the analytics dashboard, scoped the same way as `GET /patients`.

No direct identifier is included: no id, `patient_code`, name, address, phone, email, policy number, or PCP name, and no exact dates — date of birth becomes an integer `age`, and `registration_date`/`last_visit_date` are truncated to `"YYYY-MM"`. Categorical and multi-value fields are dictionary-encoded (each distinct string assigned a small integer code) to keep the payload compact.

Streams as newline-delimited JSON, same shape as the upload endpoint:

```json
{"type": "progress", "phase": "decrypting", "processed": 5000, "total": 10000}
{"type": "done", "total": 9980, "categories": {"gender": ["F", "M"], "...": ["..."]}, "multi_value_categories": {"...": ["..."]}, "columns": {"gender": [0, 1, 0], "age": [34, 61, null], "...": ["..."]}, "quality": {"duplicate_identity_groups": 2, "duplicate_identity_rows": 4, "dates_before_birth": 0, "last_visit_before_registration": 1, "unreadable_rows": 0}}
```

`quality` surfaces data-hygiene signals (possible duplicate patients by name+DOB, implausible dates, rows that failed to decrypt) as aggregate counts only — never the underlying values. A `patient_analytics_view` event (row counts only) is written to `audit_logs`.

| Status | Meaning             |
| ------ | ------------------- |
| `429`  | Rate limit exceeded |

### `GET /patients/{patient_id}`

Requires `patient.view`. Writes a `patient_view` event to `audit_logs`.

| Status | Meaning                                                     |
| ------ | ----------------------------------------------------------- |
| `404`  | No patient with that id, or it's outside the caller's scope |

### `PATCH /patients/{patient_id}`

Requires `patient.edit`. All fields optional — only fields present in the request body are updated; `patient_code` cannot be changed (immutable once uploaded). An explicit `null` clears an optional field; `first_name`/`last_name`/`date_of_birth`/`gender` cannot be nulled (a `null` for one of those is ignored, same as omitting it). Field values go through the same validation as the upload path (formula-injection guard, date/enum checks). Writes a `patient_edit` event to `audit_logs` listing which field names changed — never the old or new values, so this log never carries PHI.

| Status | Meaning                                                     |
| ------ | ----------------------------------------------------------- |
| `404`  | No patient with that id, or it's outside the caller's scope |
| `422`  | A field fails validation                                    |

### `DELETE /patients/{patient_id}`

Requires `patient.delete`. Hard delete — unlike users, patient rows are actually removed, not soft-deleted. Writes a `patient_delete` event to `audit_logs` first. Returns `204`.

| Status | Meaning                                                     |
| ------ | ----------------------------------------------------------- |
| `404`  | No patient with that id, or it's outside the caller's scope |

## Patient object shape

Returned by every `/patients` endpoint above except `analytics-dataset`:

```json
{
  "id": "uuid",
  "patient_code": "string",
  "first_name": "string",
  "last_name": "string",
  "date_of_birth": "YYYY-MM-DD",
  "gender": "string",
  "street_address": "string | null",
  "city": "string | null",
  "state": "string | null",
  "zip_code": "string | null",
  "phone": "string | null",
  "email": "string | null",
  "emergency_contact_name": "string | null",
  "emergency_contact_relationship": "string | null",
  "emergency_contact_phone": "string | null",
  "preferred_language": "string | null",
  "race_ethnicity": "string | null",
  "marital_status": "string | null",
  "occupation": "string | null",
  "insurance_provider": "string | null",
  "policy_number": "string | null",
  "pcp_name": "string | null",
  "care_department": "string | null",
  "registration_date": "YYYY-MM-DD | null",
  "last_visit_date": "YYYY-MM-DD | null",
  "preferred_pharmacy": "string | null",
  "blood_type": "string | null",
  "height_in": "integer | null",
  "weight_lbs": "integer | null",
  "systolic_bp": "integer | null",
  "diastolic_bp": "integer | null",
  "allergies": "string[] | null",
  "current_medications": "string[] | null",
  "chronic_conditions": "string[] | null",
  "immunization_history": "string[] | null",
  "smoking_status": "string | null",
  "alcohol_use": "string | null",
  "uploaded_by": "uuid",
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

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
