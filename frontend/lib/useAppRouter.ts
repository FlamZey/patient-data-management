"use client";

import { useRouter } from "next/navigation";

import { startRouteTransition } from "./navigation-loading";

// Drop-in replacement for next/navigation's useRouter -- same push/replace
// signatures, but flags a route transition as pending first so
// RouteLoadingIndicator can show its spinner for programmatic navigation
// (redirects after login/logout, permission-gated bounces to /home) the
// same way it does for a plain <Link> click.
export function useAppRouter() {
  const router = useRouter();

  return {
    ...router,
    push: (...args: Parameters<typeof router.push>) => {
      startRouteTransition();
      router.push(...args);
    },
    replace: (...args: Parameters<typeof router.replace>) => {
      startRouteTransition();
      router.replace(...args);
    },
  };
}
