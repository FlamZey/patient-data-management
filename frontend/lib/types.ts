// Mirrors backend/app/schemas.py exactly. Keep in sync with that file --
// field names/nullability here must match the Pydantic models, not the
// SQLAlchemy models in backend/app/models.py.

export interface PermissionRead {
  id: number;
  code: string;
  resource: string;
  action: string;
  description: string | null;
}

export interface RoleRead {
  id: number;
  name: string;
  display_name: string;
  parent_role_id: number | null;
  description: string | null;
  is_active: boolean;
  permissions: PermissionRead[];
}

export interface LocationRead {
  id: number;
  code: string;
  name: string;
  is_active: boolean;
}

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

export interface LoginRequest {
  email: string;
  password: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}
