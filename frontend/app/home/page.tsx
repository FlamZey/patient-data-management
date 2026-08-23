"use client";

import NavBar from "@/components/NavBar";
import ProtectedRoute from "@/components/ProtectedRoute";

// Authenticated landing page -- placeholder content, every role lands here
// after login.
export default function HomePage() {
  return (
    <ProtectedRoute>
      <NavBar />
      <main className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
        <p className="animate-rise-in [animation-delay:0.05s] mb-3 font-mono text-xs tracking-[0.3em] text-muted uppercase">
          Patient Records System
        </p>
        <h1 className="animate-rise-in [animation-delay:0.15s] font-serif text-3xl font-semibold text-foreground">
          Home
        </h1>
        <p className="animate-rise-in [animation-delay:0.25s] mt-2 text-sm text-muted">
          Work in progress.
        </p>
      </main>
    </ProtectedRoute>
  );
}
