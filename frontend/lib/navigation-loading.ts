// Tiny external store tracking whether a route transition is in flight --
// shared by RouteLoadingIndicator (the one place that reads it) and every
// navigation entry point (useAppRouter, RouteLoadingIndicator's own <a>
// click listener) that can start one. Kept outside React state so a
// programmatic router.push and a plain <Link> click both feed the same
// signal without needing a context provider between them.
type Listener = () => void;

let pending = false;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

// Flags a navigation as in flight. Idempotent -- calling it again while
// already pending (e.g. a second click before the first navigation
// commits) is a no-op, so a burst of rapid, superseded navigations still
// reads as a single pending transition rather than restarting it.
export function startRouteTransition() {
  if (pending) return;
  pending = true;
  emit();
}

// Marks the in-flight transition as finished. Whichever navigation
// actually commits last is the one that matters, so callers don't need to
// track which specific push/click this ends.
export function endRouteTransition() {
  if (!pending) return;
  pending = false;
  emit();
}

export function isRouteTransitionPending() {
  return pending;
}

export function subscribeRouteTransition(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
