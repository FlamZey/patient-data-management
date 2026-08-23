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

  it("flags a route transition as pending and forwards push", () => {
    const { result } = renderHook(() => useAppRouter());

    result.current.push("/dashboard");

    expect(isRouteTransitionPending()).toBe(true);
    expect(pushMock).toHaveBeenCalledWith("/dashboard");
  });

  it("flags a route transition as pending and forwards replace", () => {
    const { result } = renderHook(() => useAppRouter());

    result.current.replace("/login");

    expect(isRouteTransitionPending()).toBe(true);
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });

  it("forwards push/replace options unchanged", () => {
    const { result } = renderHook(() => useAppRouter());

    result.current.push("/dashboard", { scroll: false });

    expect(pushMock).toHaveBeenCalledWith("/dashboard", { scroll: false });
  });

  it("passes through other router methods untouched", () => {
    const { result } = renderHook(() => useAppRouter());

    result.current.back();

    expect(backMock).toHaveBeenCalledTimes(1);
  });
});
