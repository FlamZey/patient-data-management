"use client";

import PatientAnalysis from "@/components/analytics/PatientAnalysis";
import ProtectedRoute from "@/components/ProtectedRoute";
import Sidebar from "@/components/Sidebar";
import { PERMISSIONS } from "@/lib/permissions";
import { useRequirePermission } from "@/lib/useRequirePermission";

// Data analysis route, gated on patient.view like the dashboard
function DataAnalysisContent() {
  const canView = useRequirePermission(PERMISSIONS.patientView);

  if (!canView) return null; // redirect is in flight, or auth hasn't resolved yet

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar active="data-analysis" />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="overlay-scrollbar flex-1 overflow-auto px-4 py-10 sm:py-14">
          <div className="animate-rise-in [animation-delay:0.05s] mx-auto w-full max-w-6xl">
            <div className="mb-6">
              <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-muted uppercase">Records</p>
              <h1 className="font-serif text-2xl font-semibold text-foreground">Data Analysis</h1>
            </div>
            <PatientAnalysis />
          </div>
        </div>
      </main>
    </div>
  );
}

export default function DataAnalysisPage() {
  return (
    <ProtectedRoute>
      <DataAnalysisContent />
    </ProtectedRoute>
  );
}
