"use client";

import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import Button from "@/components/Button";
import Field, { inputClass } from "@/components/FormField";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
import { useLockPageScroll } from "@/lib/page-scroll-lock";
import { isBlank } from "@/lib/text";
import type { LocationRead, RoleRead, TeamRead, UserRead } from "@/lib/types";

// Create/edit user modal, shared between the "Add user" and "Edit" actions
// on the Manage Users page.
interface UserFormDialogProps {
  mode: "create" | "edit";
  user?: UserRead; // the row being edited; unused/undefined in create mode
  roles: RoleRead[]; // dropdown options
  locations: LocationRead[]; // dropdown options
  teams: TeamRead[]; // dropdown options
  onClose: () => void;
  onSaved: (user: UserRead) => void; // called with the created/updated row
}

// Local form state -- ids are kept as strings since <select> values are
// always strings; converted to numbers only when building the API payload.
interface FormState {
  email: string;
  username: string;
  password: string; // only used/shown in create mode
  first_name: string;
  last_name: string;
  role_id: string;
  location_id: string;
  team_id: string; // empty string means "Unassigned"
}

type FormErrors = Partial<Record<keyof FormState, string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Builds the form's starting values -- blank for create, pre-filled from
// the existing row for edit.
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

// Client-side validation, run before every submit -- password is only
// checked in create mode since edit has no password field.
function validate(mode: "create" | "edit", form: FormState): FormErrors {
  const errors: FormErrors = {};

  if (isBlank(form.email)) errors.email = "Email is required.";
  else if (!EMAIL_PATTERN.test(form.email.trim())) errors.email = "Enter a valid email address.";

  if (isBlank(form.username)) errors.username = "Username is required.";
  if (isBlank(form.first_name)) errors.first_name = "First name is required.";
  if (isBlank(form.last_name)) errors.last_name = "Last name is required.";
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
  const [errors, setErrors] = useState<FormErrors>({}); // per-field validation/conflict messages
  const [formError, setFormError] = useState<string | null>(null); // form-wide error banner
  const [isSubmitting, setIsSubmitting] = useState(false);

  useLockPageScroll();

  // Escape closes the dialog without saving.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Updates one field and clears its stale error as the user retypes it.
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
      const teamId = form.team_id ? Number(form.team_id) : null; // "" -> null (Unassigned)

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
        // 409 means email or username is already taken -- the backend's
        // error message says which, so route the inline error accordingly.
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

  // Portaled to document.body: a page wrapper using the animate-rise-in
  // utility (see globals.css) keeps a persistent non-"none" transform after
  // its animation ends (fill-mode "both"), which creates a containing block
  // for "fixed" descendants -- without the portal this backdrop would be
  // contained within that ancestor instead of the viewport.
  return createPortal(
    <div
      className="overlay-scrollbar animate-backdrop-in fixed inset-0 z-20 flex items-center justify-center overflow-y-auto bg-black/60 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-form-title"
        onClick={(event) => event.stopPropagation()} // don't let a click inside the panel bubble to the backdrop's onClose
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
    </div>,
    document.body,
  );
}
