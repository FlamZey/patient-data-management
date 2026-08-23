"use client";

import { useEffect } from "react";

import Button from "@/components/Button";

// Generic yes/no confirmation modal -- title/description/confirm label are
// all caller-supplied, so one component covers every destructive action.
interface ConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string; // e.g. "Suspend", "Delete"
  isConfirming?: boolean; // shows a busy state and disables both buttons
  error?: string | null; // shown below the description if the last confirm failed
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  description,
  confirmLabel,
  isConfirming = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Escape closes the dialog, same as clicking the backdrop or Cancel.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="animate-backdrop-in fixed inset-0 z-20 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(event) => event.stopPropagation()} // don't let a click inside the panel bubble to the backdrop's onCancel
        className="animate-panel-in w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-2xl shadow-black/40"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger">
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M10 6.5v4M10 13.5h.01M8.68 3.45 1.82 15.2A1.5 1.5 0 0 0 3.13 17.5h13.74a1.5 1.5 0 0 0 1.3-2.3L11.32 3.45a1.5 1.5 0 0 0-2.64 0Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h2 id="confirm-dialog-title" className="font-serif text-lg font-semibold text-foreground">
            {title}
          </h2>
        </div>
        <p className="mt-3 text-sm text-muted">{description}</p>

        {error && (
          <p role="alert" className="mt-4 rounded-md border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-foreground">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel} disabled={isConfirming}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={isConfirming}>
            {isConfirming ? "Working..." : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
