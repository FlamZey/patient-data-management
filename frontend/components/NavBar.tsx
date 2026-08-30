"use client";

import Link from "next/link";

import Button from "@/components/Button";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";

// Top nav shown on every authenticated page -- Dashboard/Manage Users
// links are permission-gated, everything else is visible to any user.
export default function NavBar() {
  const { currentUser, logout } = useAuth();

  if (!currentUser) return null; // nothing to show while signed out

  // Gated by the permission each page actually requires, not by role name,
  // so this stays correct if which roles hold these permissions changes.
  const canViewDashboard = hasPermission(currentUser, PERMISSIONS.patientView);
  const canManageUsers = hasPermission(currentUser, PERMISSIONS.userView);

  return (
    <nav
      id="app-navbar"
      className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface/90 px-4 py-3 backdrop-blur sm:px-6"
    >
      <div className="flex min-w-0 items-center gap-6">
        <Link
          href="/home"
          className="shrink-0 font-serif text-lg font-semibold tracking-tight text-foreground transition-colors hover:text-accent"
        >
          Records
        </Link>

        <span className="hidden h-4 w-px shrink-0 bg-border sm:block" />

        <div className="flex items-center gap-5">
          {canViewDashboard && (
            <Link
              href="/dashboard"
              className="text-sm font-medium text-foreground transition-colors hover:text-accent"
            >
              Dashboard
            </Link>
          )}
          {canManageUsers && (
            <Link
              href="/manage-users"
              className="text-sm font-medium text-foreground transition-colors hover:text-accent"
            >
              Manage Users
            </Link>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4">
        {/* Name + role, hidden on small screens to save space */}
        <div className="hidden min-w-0 flex-col text-right sm:flex">
          <span className="truncate text-sm font-medium text-foreground">
            {currentUser.first_name} {currentUser.last_name}
          </span>
          <span className="truncate font-mono text-[11px] uppercase tracking-wide text-muted">
            {currentUser.role.display_name}
          </span>
        </div>

        <Link
          href="/settings"
          aria-label="Settings"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          {/* Gear icon */}
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M16.17 12.5a1.38 1.38 0 0 0 .28 1.52l.05.05a1.67 1.67 0 1 1-2.36 2.36l-.05-.05a1.38 1.38 0 0 0-1.52-.28 1.38 1.38 0 0 0-.84 1.27v.13a1.67 1.67 0 1 1-3.33 0v-.07a1.38 1.38 0 0 0-.9-1.26 1.38 1.38 0 0 0-1.52.28l-.05.05a1.67 1.67 0 1 1-2.36-2.36l.05-.05a1.38 1.38 0 0 0 .28-1.52 1.38 1.38 0 0 0-1.27-.84h-.13a1.67 1.67 0 1 1 0-3.33h.07a1.38 1.38 0 0 0 1.26-.9 1.38 1.38 0 0 0-.28-1.52l-.05-.05a1.67 1.67 0 1 1 2.36-2.36l.05.05a1.38 1.38 0 0 0 1.52.28h.06a1.38 1.38 0 0 0 .84-1.27v-.13a1.67 1.67 0 1 1 3.33 0v.07a1.38 1.38 0 0 0 .84 1.26 1.38 1.38 0 0 0 1.52-.28l.05-.05a1.67 1.67 0 1 1 2.36 2.36l-.05.05a1.38 1.38 0 0 0-.28 1.52v.06a1.38 1.38 0 0 0 1.27.84h.13a1.67 1.67 0 1 1 0 3.33h-.07a1.38 1.38 0 0 0-1.26.84Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>

        <Button variant="secondary" size="sm" onClick={() => logout()}>
          Logout
        </Button>
      </div>
    </nav>
  );
}
