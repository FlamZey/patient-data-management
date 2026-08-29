import {
  endRouteTransition,
  isRouteTransitionPending,
  startRouteTransition,
  subscribeRouteTransition,
} from "@/lib/navigation-loading";

describe("lib/navigation-loading", () => {
  afterEach(() => {
    // Module state is a singleton -- reset it so tests don't leak into
    // each other.
    endRouteTransition();
  });

  // Starts out not pending.
  it("starts out not pending", () => {
    expect(isRouteTransitionPending()).toBe(false);
  });

  // Becomes pending after startRouteTransition.
  it("becomes pending after startRouteTransition", () => {
    startRouteTransition();
    expect(isRouteTransitionPending()).toBe(true);
  });

  // Clears pending after endRouteTransition.
  it("clears pending after endRouteTransition", () => {
    startRouteTransition();
    endRouteTransition();
    expect(isRouteTransitionPending()).toBe(false);
  });

  // Notifies subscribers when a transition starts and ends.
  it("notifies subscribers when a transition starts and ends", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeRouteTransition(listener);

    startRouteTransition();
    expect(listener).toHaveBeenCalledTimes(1);

    endRouteTransition();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  // Is idempotent -- a second start while already pending does not notify again.
  it("is idempotent -- a second start while already pending does not notify again", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeRouteTransition(listener);

    startRouteTransition();
    startRouteTransition();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  // Is idempotent -- ending an already-ended transition does not notify.
  it("is idempotent -- ending an already-ended transition does not notify", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeRouteTransition(listener);

    endRouteTransition();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  // Stops notifying a listener once unsubscribed.
  it("stops notifying a listener once unsubscribed", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeRouteTransition(listener);
    unsubscribe();

    startRouteTransition();
    expect(listener).not.toHaveBeenCalled();
  });
});
