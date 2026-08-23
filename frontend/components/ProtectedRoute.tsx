"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/lib/auth-context";

// Wraps a page that requires an authenticated session -- redirects to
// /login once the session check resolves with no user.
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { currentUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !currentUser) {
      router.replace("/login");
    }
  }, [isLoading, currentUser, router]);

  if (isLoading) {
    // Session check still in flight -- show a pulse instead of guessing.
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      </div>
    );
  }

  if (!currentUser) {
    // Redirect above is in flight -- render nothing so protected content
    // never flashes on screen first.
    return null;
  }

  return <>{children}</>;
}
