"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import NavBar from "@/components/NavBar";
import ProtectedRoute from "@/components/ProtectedRoute";
import UserManagementTable from "@/components/UserManagementTable";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";

// Manage Users route, gated on user.view (admin/manager).
function ManageUsersContent() {
  const { currentUser } = useAuth();
  const router = useRouter();
  const canManageUsers = hasPermission(currentUser, "user.view");

  // Nothing on this page is visible without user.view -- /home is the safe
  // landing spot every authenticated user can see.
  useEffect(() => {
    if (currentUser && !canManageUsers) router.replace("/home");
  }, [currentUser, canManageUsers, router]);

  if (!currentUser || !canManageUsers) return null; // redirect above is in flight, or auth hasn't resolved yet

  return (
    <>
      <NavBar />
      <main className="min-h-screen px-4 py-10 sm:py-14">
        <div className="animate-rise-in [animation-delay:0.05s] mx-auto w-full max-w-6xl">
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
