"use client";

import { useEffect, useState } from "react";

// Mirrors RouteLoadingIndicator's SHOW_DELAY_MS -- the common case (a fast
// session-restore/redirect check) shouldn't flash a spinner for a frame or
// two, so callers only see `true` once `active` has held for this long.
export const SHOW_DELAY_MS = 150;

// True only once `active` has been true continuously for `delayMs`; resets
// to false the instant `active` goes false.
export function useDelayedFlag(active: boolean, delayMs: number = SHOW_DELAY_MS): boolean {
  const [show, setShow] = useState(false);

  // Reset during render rather than in the effect below -- `active` going
  // false should clear `show` immediately, not after an extra render.
  const [prevActive, setPrevActive] = useState(active);
  if (active !== prevActive) {
    setPrevActive(active);
    if (!active) setShow(false);
  }

  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);

  return show;
}
