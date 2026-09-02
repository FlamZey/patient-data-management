"use client";

import AuditLogTable from "@/components/AuditLogTable";
import ProtectedRoute from "@/components/ProtectedRoute";
import Sidebar from "@/components/Sidebar";
import { PERMISSIONS } from "@/lib/permissions";
import { useRequirePermission } from "@/lib/useRequirePermission";

// Audit log route, gated on audit.view
function AuditLogContent() {
  const canView = useRequirePermission(PERMISSIONS.auditView);

  if (!canView) return null; // redirect is in flight, or auth hasn't resolved yet

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
