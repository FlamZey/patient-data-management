"use client";

import { useEffect } from "react";

import Spinner from "@/components/Spinner";
import { useAuth } from "@/lib/auth-context";
import { useAppRouter } from "@/lib/useAppRouter";

// Root route -- never renders content, just bounces to /home or /login
// once the session check resolves.
export default function Home() {
  const { currentUser, isLoading } = useAuth();
  const router = useAppRouter();

  useEffect(() => {
    if (isLoading) return; // wait for the session check to resolve
    router.replace(currentUser ? "/home" : "/login");
  }, [isLoading, currentUser, router]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Spinner size="md" className="text-accent" />
    </main>
  );
}
