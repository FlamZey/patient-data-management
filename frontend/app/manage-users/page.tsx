"use client";

import { useEffect } from "react";

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
        <div className="animate-rise-in [animation-delay:0.05s] mx-auto w-full max-w-6xl">
          {/* Page heading lives here, the way PatientDashboard owns its own
              -- the table below is just the card. */}
          <div className="mb-6">
            <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-muted uppercase">Administration</p>
            <h1 className="font-serif text-2xl font-semibold text-foreground">User Management</h1>
          </div>
          <UserManagementTable />
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
