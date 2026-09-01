"use client";

import { useEffect } from "react";

import PatientAnalysis from "@/components/analytics/PatientAnalysis";
import ProtectedRoute from "@/components/ProtectedRoute";
import Sidebar from "@/components/Sidebar";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { useAppRouter } from "@/lib/useAppRouter";

// Data analysis route, gated on patient.view like the dashboard -- it reads
// the same de-identified patient dataset the dashboard's analytics used to
// be embedded next to, now its own destination in the sidebar.
function DataAnalysisContent() {
  const { currentUser } = useAuth();
  const router = useAppRouter();
  const canView = hasPermission(currentUser, PERMISSIONS.patientView);

  useEffect(() => {
    if (currentUser && !canView) router.replace("/home");
  }, [currentUser, canView, router]);

  if (!currentUser || !canView) return null; // redirect above is in flight, or auth hasn't resolved yet

  // The report is long enough to scroll, so it scrolls inside <main> against a
  // viewport-height shell rather than scrolling the document -- that's what
  // keeps the sidebar pinned instead of riding up with the content, and it's
  // the same shell every other content page uses (settings, dashboard,
  // manage-users, audit-log).
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
