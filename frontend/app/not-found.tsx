import Link from "next/link";

import Button from "@/components/Button";

// Rendered for any route that doesn't match one of the app's pages.
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <p className="animate-rise-in mb-3 font-mono text-xs tracking-[0.3em] text-muted uppercase">Error 404</p>
      <h1 className="animate-rise-in mb-4 font-serif text-6xl font-semibold tracking-tight text-foreground">
        Page not found
      </h1>
      <p className="animate-rise-in mb-8 max-w-md text-sm leading-relaxed text-muted text-pretty">
        This page does not exist, or the link is out of date.
      </p>

      <Link href="/" className="animate-rise-in">
        <Button size="md">Back</Button>
      </Link>
    </main>
  );
}
