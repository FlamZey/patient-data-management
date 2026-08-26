"use client";

import { useState } from "react";

import PatientAnalysis from "@/components/analytics/PatientAnalysis";
import PatientTable from "@/components/PatientTable";
import PatientUploadCard from "@/components/PatientUploadCard";

// Wraps the upload card and table together; owns refreshSignal so a
// successful upload triggers the table's next reload.
export default function PatientDashboard() {
  // Bumped after every successful upload; PatientTable reloads whenever
  // this value changes (see its refreshSignal prop).
  const [refreshSignal, setRefreshSignal] = useState(0);

  return (
    <>
      <div className="mb-6">
        <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-muted uppercase">Records</p>
        <h1 className="font-serif text-2xl font-semibold text-foreground">Patient Management</h1>
      </div>

      <div className="space-y-6">
        <PatientUploadCard onUploaded={() => setRefreshSignal((n) => n + 1)} />
        <PatientTable refreshSignal={refreshSignal} />
        <PatientAnalysis refreshSignal={refreshSignal} />
      </div>
    </>
  );
}
