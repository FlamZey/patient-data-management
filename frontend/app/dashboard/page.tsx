"use client";

import PatientTable from "@/components/PatientTable";
import ProtectedRoute from "@/components/ProtectedRoute";
import Sidebar from "@/components/Sidebar";
import { PERMISSIONS } from "@/lib/permissions";
import { useRequirePermission } from "@/lib/useRequirePermission";

// Patient dashboard route, gated on patient.view (admin/manager).
function DashboardContent() {
  const canViewPatients = useRequirePermission(PERMISSIONS.patientView);

  if (!canViewPatients) return null; // redirect is in flight, or auth hasn't resolved yet

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar active="dashboard" />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <PatientTable />
      </main>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <DashboardContent />
    </ProtectedRoute>
  );
}
