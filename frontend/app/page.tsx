"use client";

import { useEffect } from "react";

import Spinner from "@/components/Spinner";
import { useAuth } from "@/lib/auth-context";
import { useAppRouter } from "@/lib/useAppRouter";
import { useDelayedFlag } from "@/lib/useDelayedFlag";

// Root route -- never renders content, just bounces to /home or /login
// once the session check resolves.
export default function Home() {
  const { currentUser, isLoading } = useAuth();
  const router = useAppRouter();
  const showSpinner = useDelayedFlag(true);

  useEffect(() => {
    if (isLoading) return; // wait for the session check to resolve
    router.replace(currentUser ? "/home" : "/login");
  }, [isLoading, currentUser, router]);

  if (!showSpinner) return null;

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Spinner size="md" className="text-accent" />
    </main>
  );
}
