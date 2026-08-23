"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import LoginForm from "@/components/LoginForm";
import { useAuth } from "@/lib/auth-context";

// Login route -- bounces to /home if already authenticated, otherwise
// renders the heading and LoginForm.
export default function LoginPage() {
  const router = useRouter();
  const { currentUser, isLoading } = useAuth();

  // Already logged in (e.g. session restored from the refresh cookie) --
  // skip the form entirely.
  useEffect(() => {
    if (!isLoading && currentUser) {
      router.replace("/home");
    }
  }, [isLoading, currentUser, router]);

  if (isLoading || currentUser) {
    // Either the session check is still running, or a redirect above is
    // in flight -- show a pulse instead of flashing the form first.
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <p className="animate-rise-in [animation-delay:0.05s] mb-3 text-center font-mono text-xs tracking-[0.3em] text-muted uppercase">
          Patient Records System
        </p>
        <h1 className="animate-rise-in [animation-delay:0.15s] mb-8 text-center font-serif text-3xl font-semibold text-foreground">
          Sign in to continue
        </h1>
        <LoginForm />
      </div>
    </main>
  );
}
