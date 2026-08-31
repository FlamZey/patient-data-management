"use client";

import { useEffect } from "react";

import AuditLogTable from "@/components/AuditLogTable";
import NavBar from "@/components/NavBar";
import ProtectedRoute from "@/components/ProtectedRoute";
import UserManagementTable from "@/components/UserManagementTable";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { useAppRouter } from "@/lib/useAppRouter";

// Manage Users route, gated on user.view (admin/manager).
function ManageUsersContent() {
  const { currentUser } = useAuth();
  const router = useAppRouter();
  const canManageUsers = hasPermission(currentUser, PERMISSIONS.userView);
  // The audit log is a whole feature rather than an action on the user table,
  // so it's gated here, at the point it's composed in, and simply isn't in the
  // DOM without audit.view -- the same `canX && <Thing/>` idiom the table uses
  // for "Add user". It's a section of this route rather than a route of its
  // own because it's read by the same administrators, in the same context, as
  // the user list: a separate route would need its own guard and its own nav
  // entry to reach the very same audience. GET /audit-logs is gated
  // independently server-side and refuses regardless of what renders here.
  const canViewAuditLog = hasPermission(currentUser, PERMISSIONS.auditView);

  // Nothing on this page is visible without user.view -- /home is the safe
  // landing spot every authenticated user can see.
  useEffect(() => {
    if (currentUser && !canManageUsers) router.replace("/home");
  }, [currentUser, canManageUsers, router]);

  if (!currentUser || !canManageUsers) return null; // redirect above is in flight, or auth hasn't resolved yet

  return (
    <>
      <NavBar />
      <main className="flex-1 px-4 py-10 sm:py-14">
        {/* Wider than the patients dashboard's max-w-6xl: this table carries
            eight columns, and its Actions column has to hold Cancel + Save
            during inline editing. See UserManagementTable's COLUMN_WIDTHS. */}
        <div className="animate-rise-in [animation-delay:0.05s] mx-auto w-full max-w-7xl">
          {/* Page heading lives here, the way PatientDashboard owns its own
              -- the table below is just the card. */}
          <div className="mb-6">
            <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-muted uppercase">Administration</p>
            <h1 className="font-serif text-2xl font-semibold text-foreground">User Management</h1>
          </div>
          <UserManagementTable />

          {canViewAuditLog && (
            <div className="mt-10">
              <AuditLogTable />
            </div>
          )}
        </div>
      </main>
    </>
  );
}

export default function ManageUsersPage() {
  return (
    <ProtectedRoute>
      <ManageUsersContent />
    </ProtectedRoute>
  );
}
