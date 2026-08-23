"use client";

import type { ReactNode } from "react";

// Shared text-input styling and label/error/hint wrapper for form fields --
// used by UserFormDialog and the Settings page's edit-name/change-password
// forms so the two don't drift apart.
// hasError: true switches the border to the danger color.
export function inputClass(hasError: boolean): string {
  return `block w-full rounded-md border ${hasError ? "border-danger" : "border-border"} bg-background px-3 py-2 text-sm text-foreground transition-colors focus:border-accent focus:outline-none`;
}

export default function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string; // shown in place of hint when set (validation failure)
  hint?: string; // helper text shown when there's no error
  children: ReactNode; // the actual <input>/<select>
}) {
  return (
    <div>
      <label className="mb-1.5 block font-mono text-xs tracking-wide text-muted uppercase">{label}</label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
