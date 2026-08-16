"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

// Mirrors backend/app/routers/auth.py's login endpoint exactly -- same
// status codes, same wording, so what the user sees matches what the API
// actually decided.
const STATUS_MESSAGES: Record<number, string> = {
  401: "Invalid email or password",
  423: "Account locked. Try again later.",
  403: "User account is not active",
};

export default function LoginPage() {
  const router = useRouter();
  const { login, currentUser, isLoading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Already logged in (e.g. session restored from the refresh cookie) --
  // skip the form entirely.
  useEffect(() => {
    if (!isLoading && currentUser) {
      router.replace("/dashboard");
    }
  }, [isLoading, currentUser, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await login(email, password);
      router.push("/dashboard");
    } catch (err) {
      if (err instanceof ApiError && STATUS_MESSAGES[err.status]) {
        setError(STATUS_MESSAGES[err.status]);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  if (isLoading || currentUser) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        <p className="reveal reveal-1 mb-3 text-center font-mono text-xs tracking-[0.3em] text-muted uppercase">
          Patient Records System
        </p>
        <h1 className="reveal reveal-2 mb-8 text-center font-serif text-3xl font-semibold text-foreground">
          Sign in to continue
        </h1>

        <form
          onSubmit={handleSubmit}
          noValidate
          className="reveal reveal-3 space-y-5 rounded-xl border border-border bg-surface p-6 shadow-2xl shadow-black/40 sm:p-8"
        >
          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block font-mono text-xs tracking-wide text-muted uppercase"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="block w-full rounded-md border border-border bg-background px-3 py-3 text-base text-foreground transition-colors focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-1.5 block font-mono text-xs tracking-wide text-muted uppercase"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="block w-full rounded-md border border-border bg-background px-3 py-3 text-base text-foreground transition-colors focus:border-accent focus:outline-none"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-md border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-foreground"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-accent py-3 text-base font-semibold text-accent-foreground transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting && (
              <svg
                className="h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {isSubmitting ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
