"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/lib/auth-context";

// Root route -- never renders content, just bounces to /home or /login
// once the session check resolves.
export default function Home() {
  const { currentUser, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return; // wait for the session check to resolve
    router.replace(currentUser ? "/home" : "/login");
  }, [isLoading, currentUser, router]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
    </main>
  );
}
