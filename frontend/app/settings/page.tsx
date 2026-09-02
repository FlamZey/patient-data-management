"use client";

import { useEffect, useState, type ReactNode, type SubmitEvent } from "react";
import { createPortal } from "react-dom";

import Button from "@/components/Button";
import Field, { inputClass } from "@/components/FormField";
import ProtectedRoute from "@/components/ProtectedRoute";
import Sidebar from "@/components/Sidebar";
import StatusBadge from "@/components/StatusBadge";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useLockPageScroll } from "@/lib/page-scroll-lock";
import type { UserRead } from "@/lib/types";

// Self-service account page

// Formats an ISO datetime for display
function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

// First + last initials for the avatar circle, e.g. "Ada Lovelace" -> "AL".
function initials(user: UserRead): string {
  return `${user.first_name[0] ?? ""}${user.last_name[0] ?? ""}`.toUpperCase();
}

// Small pencil glyph for the two inline edit triggers
function PencilIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M13.5 3.5 16.5 6.5 7 16H4v-3L13.5 3.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Round icon-button shared by both edit triggers.
function EditTrigger({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
    >
      <PencilIcon />
    </button>
  );
}

// Shared dialog chrome
function SettingsDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useLockPageScroll();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="animate-backdrop-in fixed inset-0 z-20 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        onClick={(event) => event.stopPropagation()}
        className="animate-panel-in w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl shadow-black/40 sm:p-8"
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 id="settings-dialog-title" className="font-serif text-lg font-semibold text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ---- Edit name -------------------------------------------------------

function EditNameDialog({ onClose }: { onClose: () => void }) {
  const { currentUser, updateCurrentUser } = useAuth();
  const [firstName, setFirstName] = useState(currentUser?.first_name ?? "");
  const [lastName, setLastName] = useState(currentUser?.last_name ?? "");
  const [errors, setErrors] = useState<{ first_name?: string; last_name?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!currentUser) return null;

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    // Deliberately not clearing formError/successMessage here -- keeps the dialog's height stable across a resubmit.

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
      updateCurrentUser(updated); // refreshes the name shown in Sidebar/this card
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
    <SettingsDialog title="Edit name" onClose={onClose}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="First name" error={errors.first_name}>
            <input
              autoFocus
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

        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting}>
            {successMessage ? "Close" : "Cancel"}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </form>
    </SettingsDialog>
  );
}

// ---- Change password --------------------------------------------------

// Mirrors backend's PasswordChangeRequest.validate_password_strength exactly, so the inline error matches the API's.
function passwordStrengthError(password: string): string | undefined {
  if (password.length < 8) return "Must be at least 8 characters.";
  if (!/[A-Za-z]/.test(password)) return "Must contain at least one letter.";
  if (!/\d/.test(password)) return "Must contain at least one number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Must contain at least one special character.";
  return undefined;
}

// Success signs the user out everywhere, so onClose is only reachable via Cancel/×/Escape/backdrop before that.
function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<{
    current_password?: string;
    new_password?: string;
    confirm_password?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
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
      // Changing the password revokes every session server-side, so the frontend follows suit instead of leaving this tab looking logged in.
      setSuccessMessage("Password changed. Signing you out for security — please sign in again.");
      setTimeout(() => logout(), 1800); // gives the user a moment to read the message before redirecting
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
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
    <SettingsDialog title="Change password" onClose={onClose}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <Field label="Current password" error={errors.current_password}>
          <input
            autoFocus
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

        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose} disabled={isSubmitting || !!successMessage}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting || !!successMessage}>
            {isSubmitting ? "Saving..." : "Change password"}
          </Button>
        </div>
      </form>
    </SettingsDialog>
  );
}

// ---- Profile -------------------------------------------------------------

function ProfileSection() {
  const { currentUser } = useAuth();
  const [editNameOpen, setEditNameOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);

  // ProtectedRoute guarantees currentUser is set here -- this is just for the type checker.
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
    <>
      <div className="animate-rise-in flex flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-8 sm:px-8">
        <div className="flex items-center gap-5">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent font-serif text-xl font-semibold text-accent-foreground">
            {initials(currentUser)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-serif text-2xl font-semibold text-foreground">
                {currentUser.first_name} {currentUser.last_name}
              </h2>
              <EditTrigger label="Edit name" onClick={() => setEditNameOpen(true)} />
            </div>
            <p className="font-mono text-xs tracking-wide text-muted">Record #{currentUser.id.slice(0, 8)}</p>
          </div>
        </div>
        <StatusBadge status={currentUser.status} />
      </div>

      <dl className="animate-rise-in grid grid-cols-2 gap-x-8 gap-y-8 px-4 py-8 sm:grid-cols-4 sm:px-8">
        {fields.map((field) => (
          <div key={field.label}>
            <dt className="font-mono text-[11px] uppercase tracking-wide text-muted">{field.label}</dt>
            <dd
              className={`mt-1.5 truncate text-sm text-foreground ${field.mono ? "font-mono" : ""}`}
              title={field.value}
            >
              {field.value}
            </dd>
          </div>
        ))}
        <div>
          <dt className="font-mono text-[11px] uppercase tracking-wide text-muted">Password</dt>
          <dd className="mt-1.5 flex items-center gap-1.5 text-sm text-foreground">
            <span className="font-mono tracking-wider">••••••••</span>
            <EditTrigger label="Edit password" onClick={() => setChangePasswordOpen(true)} />
          </dd>
        </div>
      </dl>

      {editNameOpen && <EditNameDialog onClose={() => setEditNameOpen(false)} />}
      {changePasswordOpen && <ChangePasswordDialog onClose={() => setChangePasswordOpen(false)} />}
    </>
  );
}

export default function SettingsPage() {
  return (
    <ProtectedRoute>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-14 shrink-0 items-center border-b border-border px-4 sm:px-6">
            <h1 className="font-serif text-base font-semibold text-foreground">Settings</h1>
          </div>
          <div className="overlay-scrollbar flex-1 overflow-auto">
            <ProfileSection />
          </div>
        </main>
      </div>
    </ProtectedRoute>
  );
}
