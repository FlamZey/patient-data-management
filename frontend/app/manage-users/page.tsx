"use client";

import { useEffect } from "react";

import ProtectedRoute from "@/components/ProtectedRoute";
import Sidebar from "@/components/Sidebar";
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
    <div className="flex h-screen overflow-hidden">
      <Sidebar active="manage-users" />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <UserManagementTable />
      </main>
    </div>
  );
}

export default function ManageUsersPage() {
  return (
    <ProtectedRoute>
      <ManageUsersContent />
    </ProtectedRoute>
  );
}
