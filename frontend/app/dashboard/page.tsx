"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import NavBar from "@/components/NavBar";
import PatientDashboard from "@/components/PatientDashboard";
import ProtectedRoute from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";

// Patient dashboard route, gated on patient.view (admin/manager).
function DashboardContent() {
  const { currentUser } = useAuth();
  const router = useRouter();
  const canViewPatients = hasPermission(currentUser, "patient.view");

  // Nothing on this page is visible without patient.view -- /home is the
  // safe landing spot every authenticated user can see.
  useEffect(() => {
    if (currentUser && !canViewPatients) router.replace("/home");
  }, [currentUser, canViewPatients, router]);

  if (!currentUser || !canViewPatients) return null; // redirect above is in flight, or auth hasn't resolved yet

  return (
    <>
      <NavBar />
      <main className="min-h-screen px-4 py-10 sm:py-14">
        <div className="animate-rise-in [animation-delay:0.05s] mx-auto w-full max-w-6xl">
          <PatientDashboard />
        </div>
      </main>
    </>
  );
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <DashboardContent />
    </ProtectedRoute>
  );
}
