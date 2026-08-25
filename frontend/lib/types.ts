// Mirrors backend/app/schemas.py exactly. Keep in sync with that file --
// field names/nullability here must match the Pydantic models, not the
// SQLAlchemy models in backend/app/models.py.

// A single grantable capability, e.g. "patient.view".
export interface PermissionRead {
  id: number;
  code: string;
  resource: string;
  action: string;
  description: string | null;
}

// A role (admin/manager/user) and the permissions it carries.
export interface RoleRead {
  id: number;
  name: string;
  display_name: string;
  parent_role_id: number | null;
  description: string | null;
  is_active: boolean;
  permissions: PermissionRead[];
}

// An org location option (e.g. "US", "EU") used on the user form.
export interface LocationRead {
  id: number;
  code: string;
  name: string;
  is_active: boolean;
}

// A team option, or null on a user with no team assigned.
export interface TeamRead {
  id: number;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

// datetime fields are ISO 8601 strings over the wire (Pydantic's default
// JSON encoding), not Date objects -- parse with `new Date(...)` if needed.
export interface UserRead {
  id: string;
  email: string;
  username: string;
  first_name: string;
  last_name: string;
  status: string;
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  password_changed_at: string | null;
  created_at: string;
  updated_at: string;
  role: RoleRead;
  location: LocationRead;
  team: TeamRead | null;
}

// Payload for POST /users (Manage Users' "Add user" form).
export interface UserCreate {
  email: string;
  username: string;
  password: string;
  first_name: string;
  last_name: string;
  role_id: number;
  location_id: number;
  team_id: number | null;
}

// Payload for PATCH /users/:id -- every field optional, only changed
// fields need to be sent.
// Password is intentionally omitted -- backend/app/schemas.py's
// UserUpdate doesn't accept it either; there's no password-change path
// through this endpoint.
export interface UserUpdate {
  email?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  status?: string;
  role_id?: number;
  location_id?: number;
  team_id?: number | null;
}

// Response shape for GET /users -- a page of rows plus the total row
// count across all pages (for the "X of Y" label and Prev/Next).
export interface UserListResponse {
  items: UserRead[];
  total: number;
}

// Payload for PATCH /auth/me -- what a user may edit about their own
// account, deliberately smaller than UserUpdate.
export interface SelfProfileUpdate {
  first_name: string;
  last_name: string;
}

// Payload for POST /auth/me/password.
export interface PasswordChangeRequest {
  current_password: string;
  new_password: string;
}

// Payload for POST /auth/login.
export interface LoginRequest {
  email: string;
  password: string;
}

// Response from /auth/login and /auth/refresh.
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

// Closed set of values the backend accepts for a patient's gender field.
export type Gender = "Male" | "Female" | "Other" | "Prefer not to say";

// The decrypted view returned to the client -- PHI fields are stored
// encrypted server-side (see backend/app/core/encryption.py) but always
// come back plaintext here.
export interface PatientRead {
  id: string;
  patient_code: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
}

// Payload for PATCH /patients/:id -- only changed fields need to be sent.
// patient_code is deliberately absent -- it's immutable once uploaded.
export interface PatientUpdate {
  first_name?: string;
  last_name?: string;
  date_of_birth?: string;
  gender?: Gender;
}

// Response shape for GET /patients -- see UserListResponse above.
export interface PatientListResponse {
  items: PatientRead[];
  total: number;
}

// One row from a patient upload that failed validation/import.
export interface RejectedRow {
  row: number;
  field: string;
  reason: string;
}

// Response from POST /patients/upload -- a summary of the import run.
export interface PatientUploadResult {
  accepted: number;
  rejected: RejectedRow[];
  upload_id: string;
}
