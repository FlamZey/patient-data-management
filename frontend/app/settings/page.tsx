"use client";

import { useState, type FormEvent } from "react";

import Button from "@/components/Button";
import Field, { inputClass } from "@/components/FormField";
import NavBar from "@/components/NavBar";
import ProtectedRoute from "@/components/ProtectedRoute";
import StatusBadge from "@/components/StatusBadge";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { UserRead } from "@/lib/types";

// Self-service account page: profile summary, edit-name form, and
// change-password form. Every authenticated role can reach this page.

// Formats an ISO datetime for display, or an em dash if it's null
// (e.g. a user who has never logged in).
function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

// First + last initials for the avatar circle, e.g. "Ada Lovelace" -> "AL".
function initials(user: UserRead): string {
  return `${user.first_name[0] ?? ""}${user.last_name[0] ?? ""}`.toUpperCase();
}

// Shared card chrome (title header + padded body) for the two forms below.
function Card({
  title,
  delay, // CSS animation-delay, staggers the cards' entrance
  children,
}: {
  title: string;
  delay: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="animate-rise-in mx-auto mt-6 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40"
      style={{ animationDelay: delay }}
    >
      <div className="border-b border-border px-6 py-5 sm:px-8">
        <h2 className="font-serif text-lg font-semibold text-foreground">{title}</h2>
      </div>
      <div className="px-6 py-6 sm:px-8">{children}</div>
    </div>
  );
}

// Read-only summary of the signed-in user's account (avatar, name, status,
// and key fields).
function ProfileCard() {
  const { currentUser } = useAuth();

  // ProtectedRoute guarantees currentUser is set by the time this renders;
  // this is just to satisfy the type checker.
  if (!currentUser) return null;

  // Label/value pairs rendered as the definition list below.
  const fields: { label: string; value: string; mono?: boolean }[] = [
    { label: "Email", value: currentUser.email, mono: true },
    { label: "Username", value: currentUser.username, mono: true },
    { label: "Role", value: currentUser.role.display_name },
    { label: "Location", value: currentUser.location.name },
    { label: "Team", value: currentUser.team ? currentUser.team.name : "Unassigned" },
    { label: "Last login", value: formatDateTime(currentUser.last_login_at), mono: true },
    { label: "Member since", value: formatDateTime(currentUser.created_at), mono: true },
  ];

  return (
    <div className="animate-rise-in [animation-delay:0.05s] mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-5 sm:px-8">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent font-serif text-lg font-semibold text-accent-foreground">
            {initials(currentUser)}
          </div>
          <div>
            <h1 className="font-serif text-xl font-semibold text-foreground">
              {currentUser.first_name} {currentUser.last_name}
            </h1>
            <p className="font-mono text-xs tracking-wide text-muted">
              Record #{currentUser.id.slice(0, 8)}
            </p>
          </div>
        </div>
        <StatusBadge status={currentUser.status} />
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-5 px-6 py-6 sm:grid-cols-2 sm:px-8">
        {fields.map((field) => (
          <div key={field.label}>
            <dt className="font-mono text-[11px] uppercase tracking-wide text-muted">
              {field.label}
            </dt>
            <dd
              className={`mt-1 text-sm text-foreground ${field.mono ? "font-mono" : ""}`}
            >
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// Form for changing first/last name -- the only self-editable profile
// fields (email/role/location/etc. are admin-controlled).
function EditProfileForm() {
  const { currentUser, updateCurrentUser } = useAuth();
  const [firstName, setFirstName] = useState(currentUser?.first_name ?? "");
  const [lastName, setLastName] = useState(currentUser?.last_name ?? "");
  const [errors, setErrors] = useState<{ first_name?: string; last_name?: string }>({}); // per-field validation errors
  const [formError, setFormError] = useState<string | null>(null); // form-wide error banner
  const [successMessage, setSuccessMessage] = useState<string | null>(null); // shown after a successful save
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!currentUser) return null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Deliberately not clearing formError/successMessage here -- doing so
    // would hide the previous message immediately on click and only bring
    // it back once the request resolves, which makes the card visibly
    // shrink then grow on every submit (worse when spamming the button).
    // Leaving the old message in place until a new result comes back keeps
    // the layout stable (same reasoning as login/page.tsx's handleSubmit).

    const nextErrors: { first_name?: string; last_name?: string } = {};
    if (!firstName.trim()) nextErrors.first_name = "First name is required.";
    if (!lastName.trim()) nextErrors.last_name = "Last name is required.";
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setIsSubmitting(true);
    try {
      const updated = await apiPatch<UserRead>("/auth/me", {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
      });
      updateCurrentUser(updated); // refreshes the name shown in NavBar/ProfileCard
      setSuccessMessage("Profile updated.");
      setFormError(null);
    } catch {
      setFormError("Something went wrong. Please try again.");
      setSuccessMessage(null);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card title="Edit name" delay="0.15s">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="First name" error={errors.first_name}>
            <input
              value={firstName}
              onChange={(event) => {
                setFirstName(event.target.value);
                setErrors((prev) => ({ ...prev, first_name: undefined }));
              }}
              className={inputClass(!!errors.first_name)}
            />
          </Field>
          <Field label="Last name" error={errors.last_name}>
            <input
              value={lastName}
              onChange={(event) => {
                setLastName(event.target.value);
                setErrors((prev) => ({ ...prev, last_name: undefined }));
              }}
              className={inputClass(!!errors.last_name)}
            />
          </Field>
        </div>

        {formError && (
          <p role="alert" className="rounded-md border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-foreground">
            {formError}
          </p>
        )}
        {successMessage && (
          <p role="status" className="rounded-md border-l-2 border-teal bg-teal/10 px-3 py-2 text-sm text-foreground">
            {successMessage}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// Mirrors backend/app/schemas.py's PasswordChangeRequest.validate_password_strength
// exactly, so the inline error matches what the API would reject with.
function passwordStrengthError(password: string): string | undefined {
  if (password.length < 8) return "Must be at least 8 characters.";
  if (!/[A-Za-z]/.test(password)) return "Must contain at least one letter.";
  if (!/\d/.test(password)) return "Must contain at least one number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Must contain at least one special character.";
  return undefined;
}

// Form for changing the account password -- success signs the user out
// everywhere (see the comment near setSuccessMessage below).
function ChangePasswordForm() {
  const { logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<{
    current_password?: string;
    new_password?: string;
    confirm_password?: string;
  }>({}); // per-field validation errors
  const [formError, setFormError] = useState<string | null>(null); // form-wide error banner
  const [successMessage, setSuccessMessage] = useState<string | null>(null); // shown briefly before sign-out
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const nextErrors: typeof errors = {};
    if (!currentPassword) nextErrors.current_password = "Current password is required.";
    const pwError = passwordStrengthError(newPassword);
    if (pwError) nextErrors.new_password = pwError;
    else if (newPassword && newPassword === currentPassword) {
      nextErrors.new_password = "New password must be different from your current password.";
    }
    if (confirmPassword !== newPassword) nextErrors.confirm_password = "Passwords do not match.";
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    setIsSubmitting(true);
    try {
      await apiPost("/auth/me/password", {
        current_password: currentPassword,
        new_password: newPassword,
      });
      // Changing the password revokes every session server-side (see
      // backend/app/routers/auth.py), so the frontend follows suit rather
      // than leaving this tab in a state that looks logged in but whose
      // refresh token no longer works.
      setSuccessMessage("Password changed. Signing you out for security — please sign in again.");
      setTimeout(() => logout(), 1800); // gives the user a moment to read the message before redirecting
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setErrors((prev) => ({ ...prev, current_password: "Current password is incorrect." }));
      } else if (err instanceof ApiError && err.status === 400) {
        setErrors((prev) => ({
          ...prev,
          new_password: "New password must be different from your current password.",
        }));
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card title="Change password" delay="0.25s">
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <Field label="Current password" error={errors.current_password}>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
              setErrors((prev) => ({ ...prev, current_password: undefined }));
            }}
            className={inputClass(!!errors.current_password)}
          />
        </Field>
        <Field
          label="New password"
          error={errors.new_password}
          hint="At least 8 characters, with a letter, a number, and a special character."
        >
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
              setErrors((prev) => ({ ...prev, new_password: undefined }));
            }}
            className={inputClass(!!errors.new_password)}
          />
        </Field>
        <Field label="Confirm new password" error={errors.confirm_password}>
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              setErrors((prev) => ({ ...prev, confirm_password: undefined }));
            }}
            className={inputClass(!!errors.confirm_password)}
          />
        </Field>

        {formError && (
          <p role="alert" className="rounded-md border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-foreground">
            {formError}
          </p>
        )}
        {successMessage && (
          <p role="status" className="rounded-md border-l-2 border-teal bg-teal/10 px-3 py-2 text-sm text-foreground">
            {successMessage}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={isSubmitting || !!successMessage}>
            {isSubmitting ? "Saving..." : "Change password"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <ProtectedRoute>
      <NavBar />
      <main className="min-h-screen px-4 py-10 sm:py-14">
        <ProfileCard />
        <EditProfileForm />
        <ChangePasswordForm />
      </main>
    </ProtectedRoute>
  );
}
