"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

import Spinner from "@/components/Spinner";
import {
  endRouteTransition,
  isRouteTransitionPending,
  startRouteTransition,
  subscribeRouteTransition,
} from "@/lib/navigation-loading";

// Only surfaced once a transition has been pending this long, so the
// common case -- a fast client navigation -- never flickers the indicator
// on screen for a frame or two.
const SHOW_DELAY_MS = 150;
// Safety net: if a transition is somehow never marked done (a route that
// throws before committing, a redirect loop), stop showing the indicator
// after this long instead of leaving it stuck on screen forever.
const MAX_PENDING_MS = 8000;

// Mounted once in the root layout. Shows a small, non-blocking spinner
// while a route transition is in flight -- whether it started from a
// plain <Link> click anywhere in the app (caught here via a capture-phase
// click listener) or from a wrapped router.push/replace (see
// lib/useAppRouter.ts, used for the redirects auth/permission checks
// trigger). The transition is considered finished the moment the
// destination path actually commits.
export default function RouteLoadingIndicator() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);

  // Catches every same-tab, same-origin <a> click before Next.js has
  // committed anything, so <Link>-based navigation (e.g. NavBar) doesn't
  // need to opt in individually.
  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;

      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      // Same destination as the current URL -- Next.js won't actually
      // navigate, so don't start a transition that would never end.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;

      startRouteTransition();
    }

    document.addEventListener("click", handleClick, { capture: true });
    return () => document.removeEventListener("click", handleClick, { capture: true });
  }, []);

  // The one signal that ends every transition, regardless of how it
  // started or how many superseded navigations came before it: the
  // pathname Next.js actually committed to.
  useEffect(() => {
    endRouteTransition();
  }, [pathname]);

  // Delay-before-show plus the safety timeout above, re-run whenever a
  // transition starts or ends.
  useEffect(() => {
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;

    function sync() {
      clearTimeout(showTimer);
      clearTimeout(maxTimer);
      if (isRouteTransitionPending()) {
        showTimer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
        maxTimer = setTimeout(() => endRouteTransition(), MAX_PENDING_MS);
      } else {
        setVisible(false);
      }
    }

    sync();
    const unsubscribe = subscribeRouteTransition(sync);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(maxTimer);
      unsubscribe();
    };
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-backdrop-in pointer-events-none fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 text-accent shadow-2xl shadow-black/40"
    >
      <Spinner size="sm" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
