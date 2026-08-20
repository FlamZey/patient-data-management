"use client";

import { useEffect, useState, type FormEvent } from "react";

import Button from "@/components/Button";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
import type { LocationRead, RoleRead, TeamRead, UserRead } from "@/lib/types";

interface UserFormDialogProps {
  mode: "create" | "edit";
  user?: UserRead;
  roles: RoleRead[];
  locations: LocationRead[];
  teams: TeamRead[];
  onClose: () => void;
  onSaved: (user: UserRead) => void;
}

interface FormState {
  email: string;
  username: string;
  password: string;
  first_name: string;
  last_name: string;
  role_id: string;
  location_id: string;
  team_id: string;
}

type FormErrors = Partial<Record<keyof FormState, string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function initialState(user?: UserRead): FormState {
  return {
    email: user?.email ?? "",
    username: user?.username ?? "",
    password: "",
    first_name: user?.first_name ?? "",
    last_name: user?.last_name ?? "",
    role_id: user ? String(user.role.id) : "",
    location_id: user ? String(user.location.id) : "",
    team_id: user?.team ? String(user.team.id) : "",
  };
}

// Mirrors backend/app/schemas.py's UserCreate.validate_password_strength
// exactly, so the inline error matches what the API would reject with.
function passwordError(password: string): string | undefined {
  if (password.length < 8) return "Must be at least 8 characters.";
  if (!/[A-Za-z]/.test(password)) return "Must contain at least one letter.";
  if (!/\d/.test(password)) return "Must contain at least one number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Must contain at least one special character.";
  return undefined;
}

function validate(mode: "create" | "edit", form: FormState): FormErrors {
  const errors: FormErrors = {};

  if (!form.email.trim()) errors.email = "Email is required.";
  else if (!EMAIL_PATTERN.test(form.email.trim())) errors.email = "Enter a valid email address.";

  if (!form.username.trim()) errors.username = "Username is required.";
  if (!form.first_name.trim()) errors.first_name = "First name is required.";
  if (!form.last_name.trim()) errors.last_name = "Last name is required.";
  if (!form.role_id) errors.role_id = "Role is required.";
  if (!form.location_id) errors.location_id = "Location is required.";

  if (mode === "create") {
    const pwError = passwordError(form.password);
    if (pwError) errors.password = pwError;
  }

  return errors;
}

export default function UserFormDialog({
  mode,
  user,
  roles,
  locations,
  teams,
  onClose,
  onSaved,
}: UserFormDialogProps) {
  const [form, setForm] = useState<FormState>(() => initialState(user));
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function setField<K extends keyof FormState>(field: K, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const validationErrors = validate(mode, form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    setIsSubmitting(true);
    try {
      const teamId = form.team_id ? Number(form.team_id) : null;

      const saved =
        mode === "create"
          ? await apiPost<UserRead>("/users", {
              email: form.email.trim(),
              username: form.username.trim(),
              password: form.password,
              first_name: form.first_name.trim(),
              last_name: form.last_name.trim(),
              role_id: Number(form.role_id),
              location_id: Number(form.location_id),
              team_id: teamId,
            })
          : await apiPatch<UserRead>(`/users/${user!.id}`, {
              email: form.email.trim(),
              username: form.username.trim(),
              first_name: form.first_name.trim(),
              last_name: form.last_name.trim(),
              role_id: Number(form.role_id),
              location_id: Number(form.location_id),
              team_id: teamId,
            });

      onSaved(saved);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const detail = (err.body as { detail?: string } | null)?.detail?.toLowerCase() ?? "";
        if (detail.includes("email")) {
          setErrors((prev) => ({ ...prev, email: "This email is already in use." }));
        } else if (detail.includes("username")) {
          setErrors((prev) => ({ ...prev, username: "This username is already taken." }));
        } else {
          setFormError("That email or username is already in use.");
        }
      } else if (err instanceof ApiError && err.status === 404) {
        setFormError("This user no longer exists. Close this form and refresh the list.");
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const title = mode === "create" ? "Add user" : `Edit ${user?.first_name} ${user?.last_name}`;
  const eyebrow = mode === "create" ? "New record" : `Editing record #${user?.id.slice(0, 8)}`;

  return (
    <div
      className="animate-backdrop-in fixed inset-0 z-20 flex items-center justify-center overflow-y-auto bg-black/60 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-form-title"
        onClick={(event) => event.stopPropagation()}
        className="animate-panel-in w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-2xl shadow-black/40 sm:p-8"
      >
        <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-teal uppercase">{eyebrow}</p>
        <h2 id="user-form-title" className="font-serif text-xl font-semibold text-foreground">
          {title}
        </h2>

        <form onSubmit={handleSubmit} noValidate className="mt-6 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="First name" error={errors.first_name}>
              <input
                value={form.first_name}
                onChange={(event) => setField("first_name", event.target.value)}
                className={inputClass(!!errors.first_name)}
              />
            </Field>
            <Field label="Last name" error={errors.last_name}>
              <input
                value={form.last_name}
                onChange={(event) => setField("last_name", event.target.value)}
                className={inputClass(!!errors.last_name)}
              />
            </Field>
          </div>

          <Field label="Email" error={errors.email}>
            <input
              type="email"
              value={form.email}
              onChange={(event) => setField("email", event.target.value)}
              className={inputClass(!!errors.email)}
            />
          </Field>

          <Field label="Username" error={errors.username}>
            <input
              value={form.username}
              onChange={(event) => setField("username", event.target.value)}
              className={inputClass(!!errors.username)}
            />
          </Field>

          {mode === "create" && (
            <Field
              label="Password"
              error={errors.password}
              hint="At least 8 characters, with a letter, a number, and a special character."
            >
              <input
                type="password"
                value={form.password}
                onChange={(event) => setField("password", event.target.value)}
                className={inputClass(!!errors.password)}
              />
            </Field>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Role" error={errors.role_id}>
              <select
                value={form.role_id}
                onChange={(event) => setField("role_id", event.target.value)}
                className={inputClass(!!errors.role_id)}
              >
                <option value="">Select...</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.display_name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Location" error={errors.location_id}>
              <select
                value={form.location_id}
                onChange={(event) => setField("location_id", event.target.value)}
                className={inputClass(!!errors.location_id)}
              >
                <option value="">Select...</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Team">
              <select
                value={form.team_id}
                onChange={(event) => setField("team_id", event.target.value)}
                className={inputClass(false)}
              >
                <option value="">Unassigned</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {formError && (
            <p role="alert" className="rounded-md border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-foreground">
              {formError}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving..." : mode === "create" ? "Create user" : "Save changes"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function inputClass(hasError: boolean): string {
  return `block w-full rounded-md border ${hasError ? "border-danger" : "border-border"} bg-background px-3 py-2 text-sm text-foreground transition-colors focus:border-accent focus:outline-none`;
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block font-mono text-xs tracking-wide text-muted uppercase">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
