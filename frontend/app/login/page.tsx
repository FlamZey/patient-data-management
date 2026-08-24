"use client";

import { useEffect } from "react";

import LoginForm from "@/components/LoginForm";
import Spinner from "@/components/Spinner";
import { useAuth } from "@/lib/auth-context";
import { useAppRouter } from "@/lib/useAppRouter";
import { useDelayedFlag } from "@/lib/useDelayedFlag";

// Login route -- bounces to /home if already authenticated, otherwise
// renders the heading and LoginForm.
export default function LoginPage() {
  const router = useAppRouter();
  const { currentUser, isLoading } = useAuth();
  const pending = isLoading || !!currentUser;
  const showSpinner = useDelayedFlag(pending);

  // Already logged in (e.g. session restored from the refresh cookie) --
  // skip the form entirely.
  useEffect(() => {
    if (!isLoading && currentUser) {
      router.replace("/home");
    }
  }, [isLoading, currentUser, router]);

  if (pending) {
    // Either the session check is still running, or a redirect above is
    // in flight -- show a pulse instead of flashing the form first, but
    // only once that's taken long enough to actually be noticeable.
    if (!showSpinner) return null;
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <Spinner size="md" className="text-accent" />
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
