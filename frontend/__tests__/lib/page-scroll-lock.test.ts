import { act, renderHook } from "@testing-library/react";

import { isPageScrollLocked, subscribePageScrollLock, useLockPageScroll } from "@/lib/page-scroll-lock";

describe("lib/page-scroll-lock", () => {
  afterEach(() => {
    document.documentElement.style.overflow = "";
  });

  // Reports unlocked when no dialog holds the lock.
  it("reports unlocked when no dialog holds the lock", () => {
    expect(isPageScrollLocked()).toBe(false);
  });

  // Locks scroll while mounted and hides overflow on the root element.
  it("locks scroll while mounted and hides overflow on the root element", () => {
    const { unmount } = renderHook(() => useLockPageScroll());

    expect(isPageScrollLocked()).toBe(true);
    expect(document.documentElement.style.overflow).toBe("hidden");

    unmount();
    expect(isPageScrollLocked()).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
  });

  // Stays locked while at least one of two overlapping dialogs is still mounted.
  it("stays locked while at least one of two overlapping dialogs is still mounted", () => {
    const first = renderHook(() => useLockPageScroll());
    const second = renderHook(() => useLockPageScroll());

    expect(isPageScrollLocked()).toBe(true);

    first.unmount();
    expect(isPageScrollLocked()).toBe(true);
    expect(document.documentElement.style.overflow).toBe("hidden");

    second.unmount();
    expect(isPageScrollLocked()).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
  });

  // Notifies subscribers whenever the lock count changes.
  it("notifies subscribers whenever the lock count changes", () => {
    const listener = jest.fn();
    const unsubscribe = subscribePageScrollLock(listener);

    const { unmount } = renderHook(() => useLockPageScroll());
    expect(listener).toHaveBeenCalledTimes(1);

    unmount();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  // Stops notifying after unsubscribe.
  it("stops notifying after unsubscribe", () => {
    const listener = jest.fn();
    const unsubscribe = subscribePageScrollLock(listener);
    unsubscribe();

    act(() => {
      renderHook(() => useLockPageScroll());
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
