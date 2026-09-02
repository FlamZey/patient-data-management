"use client";

import ProtectedRoute from "@/components/ProtectedRoute";
import Sidebar from "@/components/Sidebar";
import UserManagementTable from "@/components/UserManagementTable";
import { PERMISSIONS } from "@/lib/permissions";
import { useRequirePermission } from "@/lib/useRequirePermission";

// Manage Users route, gated on user.view (admin/manager).
function ManageUsersContent() {
  const canManageUsers = useRequirePermission(PERMISSIONS.userView);

  if (!canManageUsers) return null; // redirect is in flight, or auth hasn't resolved yet

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
