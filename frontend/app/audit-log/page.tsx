"use client";

import { useEffect } from "react";

import AuditLogTable from "@/components/AuditLogTable";
import ProtectedRoute from "@/components/ProtectedRoute";
import Sidebar from "@/components/Sidebar";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { useAppRouter } from "@/lib/useAppRouter";

// Audit log route, gated on audit.view -- previously a section embedded in
// /manage-users; now its own destination so it isn't tied to user
// administration for readers who only need the log.
function AuditLogContent() {
  const { currentUser } = useAuth();
  const router = useAppRouter();
  const canView = hasPermission(currentUser, PERMISSIONS.auditView);

  useEffect(() => {
    if (currentUser && !canView) router.replace("/home");
  }, [currentUser, canView, router]);

  if (!currentUser || !canView) return null; // redirect above is in flight, or auth hasn't resolved yet

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar active="audit-log" />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AuditLogTable />
      </main>
    </div>
  );
}

export default function AuditLogPage() {
  return (
    <ProtectedRoute>
      <AuditLogContent />
    </ProtectedRoute>
  );
}
