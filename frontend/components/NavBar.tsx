"use client";

import Link from "next/link";

import { useAuth } from "@/lib/auth-context";

export default function NavBar() {
  const { currentUser, logout } = useAuth();

  if (!currentUser) return null;

  // Checks the actual permissions array -- not the role name -- so this
  // stays correct if which roles get "user.view" changes later.
  const canManageUsers = currentUser.role.permissions.some(
    (permission) => permission.code === "user.view",
  );

  return (
    <nav className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface/90 px-4 py-3 backdrop-blur sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="shrink-0 font-serif text-lg font-semibold tracking-tight text-foreground">
          Records
        </span>
        <span className="hidden h-4 w-px shrink-0 bg-border sm:block" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">
            {currentUser.first_name} {currentUser.last_name}
          </span>
          <span className="truncate font-mono text-[11px] uppercase tracking-wide text-muted">
            {currentUser.role.display_name}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {canManageUsers && (
          <Link
            href="/users"
            className="text-sm font-medium text-accent transition-colors hover:text-accent-hover"
          >
            Manage Users
          </Link>
        )}
        <button
          type="button"
          onClick={() => logout()}
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
        >
          Logout
        </button>
      </div>
    </nav>
  );
}
