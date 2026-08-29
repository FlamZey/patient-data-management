import { act, renderHook } from "@testing-library/react";

import { useDelayedFlag } from "@/lib/useDelayedFlag";

describe("lib/useDelayedFlag", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Starts false when active starts false.
  it("starts false when active starts false", () => {
    const { result } = renderHook(() => useDelayedFlag(false, 150));
    expect(result.current).toBe(false);
  });

  // Stays false until the delay has elapsed.
  it("stays false until the delay has elapsed", () => {
    const { result } = renderHook(() => useDelayedFlag(true, 150));
    expect(result.current).toBe(false);

    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current).toBe(false);
  });

  // Becomes true once active has held continuously for the delay.
  it("becomes true once active has held continuously for the delay", () => {
    const { result } = renderHook(() => useDelayedFlag(true, 150));

    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(result.current).toBe(true);
  });

  // Resets to false immediately when active goes false, without waiting for the delay.
  it("resets to false immediately when active goes false", () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 150), {
      initialProps: { active: true },
    });
    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(result.current).toBe(true);

    rerender({ active: false });
    expect(result.current).toBe(false);
  });

  // A brief flicker of active that ends before the delay never shows true.
  it("never shows true for a brief flicker that ends before the delay", () => {
    const { result, rerender } = renderHook(({ active }) => useDelayedFlag(active, 150), {
      initialProps: { active: true },
    });
    act(() => {
      jest.advanceTimersByTime(80);
    });
    rerender({ active: false });
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(result.current).toBe(false);
  });

  // Uses the default delay when none is provided.
  it("uses the default delay when none is provided", () => {
    const { result } = renderHook(() => useDelayedFlag(true));

    act(() => {
      jest.advanceTimersByTime(149);
    });
    expect(result.current).toBe(false);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });
});
