"use client";

import { useEffect, type ReactNode } from "react";

import Spinner from "@/components/Spinner";
import { useAuth } from "@/lib/auth-context";
import { useAppRouter } from "@/lib/useAppRouter";

// Wraps a page that requires an authenticated session -- redirects to
// /login once the session check resolves with no user.
export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { currentUser, isLoading } = useAuth();
  const router = useAppRouter();

  useEffect(() => {
    if (!isLoading && !currentUser) {
      router.replace("/login");
    }
  }, [isLoading, currentUser, router]);

  if (isLoading) {
    // Session check still in flight -- show a spinner instead of guessing.
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Spinner size="md" className="text-accent" />
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
