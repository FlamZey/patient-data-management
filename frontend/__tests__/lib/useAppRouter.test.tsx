import { renderHook } from "@testing-library/react";

const pushMock = jest.fn();
const replaceMock = jest.fn();
const backMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock, back: backMock }),
}));

import { isRouteTransitionPending, endRouteTransition } from "@/lib/navigation-loading";
import { useAppRouter } from "@/lib/useAppRouter";

describe("lib/useAppRouter", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    endRouteTransition();
  });

  // Flags a route transition as pending and forwards push.
  it("flags a route transition as pending and forwards push", () => {
    const { result } = renderHook(() => useAppRouter());

    result.current.push("/dashboard");

    expect(isRouteTransitionPending()).toBe(true);
    expect(pushMock).toHaveBeenCalledWith("/dashboard");
  });

  // Flags a route transition as pending and forwards replace.
  it("flags a route transition as pending and forwards replace", () => {
    const { result } = renderHook(() => useAppRouter());

    result.current.replace("/login");

    expect(isRouteTransitionPending()).toBe(true);
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });

  // Forwards push/replace options unchanged.
  it("forwards push/replace options unchanged", () => {
    const { result } = renderHook(() => useAppRouter());

    result.current.push("/dashboard", { scroll: false });

    expect(pushMock).toHaveBeenCalledWith("/dashboard", { scroll: false });
  });

  // Passes through other router methods untouched.
  it("passes through other router methods untouched", () => {
    const { result } = renderHook(() => useAppRouter());

    result.current.back();

    expect(backMock).toHaveBeenCalledTimes(1);
  });
});
