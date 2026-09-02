"use client";

import { useEffect } from "react";

import LoginForm from "@/components/LoginForm";
import LoginHero from "@/components/LoginHero";
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
      router.replace("/dashboard");
    }
  }, [isLoading, currentUser, router]);

  if (pending) {
    // Either the session check is still running, or a redirect above is
    // in flight -- show a spinner while we wait.
    if (!showSpinner) return null;
    return (
      <main className="login-texture flex min-h-screen items-center justify-center px-4">
        <Spinner size="md" className="text-accent" />
      </main>
    );
  }

  return (
    <main className="login-texture grid min-h-screen lg:grid-cols-[1fr_480px]">
      <LoginHero />

      <div className="flex items-center justify-center border-border px-4 py-8 lg:border-l lg:bg-surface lg:px-12">
        <div className="w-full max-w-sm">
          <p className="animate-rise-in mb-3 text-center font-serif text-xs tracking-[0.3em] text-muted uppercase lg:text-left">
            Patient Records System
          </p>
          <h1 className="animate-rise-in mb-8 text-center font-serif text-3xl font-semibold text-foreground lg:text-left">
            Sign in to continue
          </h1>
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
