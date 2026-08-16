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
    <nav className="flex flex-wrap items-center justify-between gap-3 bg-white px-4 py-3 shadow-sm sm:px-6">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold text-gray-900">
          {currentUser.first_name} {currentUser.last_name}
        </span>
        <span className="text-xs text-gray-500">{currentUser.role.display_name}</span>
      </div>

      <div className="flex items-center gap-4">
        {canManageUsers && (
          <Link
            href="/users"
            className="text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            Manage Users
          </Link>
        )}
        <button
          type="button"
          onClick={() => logout()}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Logout
        </button>
      </div>
    </nav>
  );
}
