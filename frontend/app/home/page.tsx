"use client";

import ProtectedRoute from "@/components/ProtectedRoute";
import Sidebar from "@/components/Sidebar";

// Authenticated landing page -- the fallback every role can reach, even
// without permission for /dashboard (the actual post-login default).
export default function HomePage() {
  return (
    <ProtectedRoute>
      <div className="flex flex-1">
        <Sidebar />
        <main className="flex flex-1 flex-col items-center justify-center px-4 text-center">
          <p className="animate-rise-in mb-3 font-mono text-xs tracking-[0.3em] text-muted uppercase">
            Patient Records System
          </p>
          <h1 className="animate-rise-in font-serif text-3xl font-semibold text-foreground">
            Home
          </h1>
        </main>
      </div>
    </ProtectedRoute>
  );
}
