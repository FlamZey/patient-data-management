"use client";

import { useEffect } from "react";

import PatientTable from "@/components/PatientTable";
import ProtectedRoute from "@/components/ProtectedRoute";
import Sidebar from "@/components/Sidebar";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { useAppRouter } from "@/lib/useAppRouter";

// Patient dashboard route, gated on patient.view (admin/manager). Sidebar
// static, table flush and filling the rest of the viewport -- see
// table-primitives.tsx's DataTableCard for the scrolling itself.
function DashboardContent() {
  const { currentUser } = useAuth();
  const router = useAppRouter();
  const canViewPatients = hasPermission(currentUser, PERMISSIONS.patientView);

  // Nothing on this page is visible without patient.view -- /home is the
  // safe landing spot every authenticated user can see.
  useEffect(() => {
    if (currentUser && !canViewPatients) router.replace("/home");
  }, [currentUser, canViewPatients, router]);

  if (!currentUser || !canViewPatients) return null; // redirect above is in flight, or auth hasn't resolved yet

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
