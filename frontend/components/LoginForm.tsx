"use client";

import { useState, type FormEvent } from "react";

import Button from "@/components/Button";
import Spinner from "@/components/Spinner";
import { ApiError } from "@/lib/api";
import { useAppRouter } from "@/lib/useAppRouter";
import { useAuth } from "@/lib/auth-context";

// Mirrors backend/app/routers/auth.py's login endpoint exactly -- same
// status codes, same wording, so what the user sees matches what the API
// actually decided.
const STATUS_MESSAGES: Record<number, string> = {
  401: "Invalid email or password",
  423: "Account locked. Try again later.",
  403: "User account is not active",
};

// Open eye -- shown when the password is hidden (click to reveal it).
function EyeIcon() {
  return (
    <svg className="h-4.5 w-4.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

// Eye with a slash -- shown when the password is revealed (click to hide it).
function EyeOffIcon() {
  return (
    <svg className="h-4.5 w-4.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 3l14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// Self-contained: owns its own field state, submit handling, and
// navigation on success, so the page that renders it stays a thin shell.
export default function LoginForm() {
  const router = useAppRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false); // toggles the password field between masked and plain text
  const [error, setError] = useState<string | null>(null); // message shown in the alert banner
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Deliberately not clearing the previous error here -- if it did, every
    // resubmit would briefly hide then re-show the message, and since the
    // card resizes with it, spamming submit made the whole page visibly
    // wiggle. Leaving the old message in place until a new result comes
    // back keeps the layout stable and still shows fresh info once it does.
    setIsSubmitting(true);

    try {
      await login(email, password);
      router.push("/home");
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

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="animate-rise-in [animation-delay:0.25s] space-y-5 rounded-xl border border-border bg-surface p-6 shadow-2xl shadow-black/40 sm:p-8"
    >
      <div>
        <label htmlFor="email" className="mb-1.5 block font-mono text-xs tracking-wide text-muted uppercase">
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
        <label htmlFor="password" className="mb-1.5 block font-mono text-xs tracking-wide text-muted uppercase">
          Password
        </label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="block w-full rounded-md border border-border bg-background px-3 py-3 pr-10 text-base text-foreground transition-colors focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute right-0 top-0 flex h-full w-10 items-center justify-center text-muted transition-colors hover:text-foreground"
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-foreground">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" fullWidth disabled={isSubmitting}>
        {isSubmitting && <Spinner />}
        {isSubmitting ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  );
}
