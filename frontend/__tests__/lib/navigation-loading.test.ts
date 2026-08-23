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

  it("starts out not pending", () => {
    expect(isRouteTransitionPending()).toBe(false);
  });

  it("becomes pending after startRouteTransition", () => {
    startRouteTransition();
    expect(isRouteTransitionPending()).toBe(true);
  });

  it("clears pending after endRouteTransition", () => {
    startRouteTransition();
    endRouteTransition();
    expect(isRouteTransitionPending()).toBe(false);
  });

  it("notifies subscribers when a transition starts and ends", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeRouteTransition(listener);

    startRouteTransition();
    expect(listener).toHaveBeenCalledTimes(1);

    endRouteTransition();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it("is idempotent -- a second start while already pending does not notify again", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeRouteTransition(listener);

    startRouteTransition();
    startRouteTransition();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("is idempotent -- ending an already-ended transition does not notify", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeRouteTransition(listener);

    endRouteTransition();
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("stops notifying a listener once unsubscribed", () => {
    const listener = jest.fn();
    const unsubscribe = subscribeRouteTransition(listener);
    unsubscribe();

    startRouteTransition();
    expect(listener).not.toHaveBeenCalled();
  });
});
