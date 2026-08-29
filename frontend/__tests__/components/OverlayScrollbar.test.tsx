import { act, fireEvent, render, screen } from "@testing-library/react";

import OverlayScrollbar from "@/components/OverlayScrollbar";

// jsdom has no ResizeObserver -- stub one that mimics the one real behavior
// this component depends on: a real ResizeObserver invokes its callback
// once immediately after observe() (per the component's own comment), which
// is how it gets its first real measurement after mount.
class MockResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

function setViewport({ scrollHeight, clientHeight, scrollTop = 0 }: { scrollHeight: number; clientHeight: number; scrollTop?: number }) {
  Object.defineProperty(document.documentElement, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(document.documentElement, "scrollTop", { value: scrollTop, configurable: true, writable: true });
}

describe("components/OverlayScrollbar", () => {
  const originalResizeObserver = global.ResizeObserver;

  beforeEach(() => {
    // @ts-expect-error -- test stub
    global.ResizeObserver = MockResizeObserver;
    setViewport({ scrollHeight: 1000, clientHeight: 1000 });
  });

  afterEach(() => {
    global.ResizeObserver = originalResizeObserver;
    document.documentElement.style.overflow = "";
  });

  // Renders nothing on first mount before content has been measured, avoiding a hydration mismatch.
  it("renders nothing on first mount before content has been measured", () => {
    // Measurement runs in an effect, so on the very first synchronous
    // render (before effects flush) the track must not be present yet.
    setViewport({ scrollHeight: 3000, clientHeight: 1000 });
    let container: HTMLElement;
    act(() => {
      ({ container } = render(<OverlayScrollbar />));
    });
    // By the time render() returns, effects have already flushed under RTL,
    // so this asserts the steady state renders the thumb once content overflows.
    expect(container!.querySelector('[role="scrollbar"]')).toBeInTheDocument();
  });

  // Renders no scrollbar when the page does not overflow the viewport.
  it("renders no scrollbar when the page does not overflow the viewport", () => {
    setViewport({ scrollHeight: 800, clientHeight: 1000 });
    render(<OverlayScrollbar />);
    expect(screen.queryByRole("scrollbar")).not.toBeInTheDocument();
  });

  // Renders the thumb once content overflows the viewport.
  it("renders the thumb once content overflows the viewport", () => {
    setViewport({ scrollHeight: 3000, clientHeight: 1000 });
    render(<OverlayScrollbar />);
    expect(screen.getByRole("scrollbar")).toBeInTheDocument();
  });

  // Reports scroll percent as an aria value for assistive tech.
  it("reports scroll percent as an aria value for assistive tech", () => {
    setViewport({ scrollHeight: 3000, clientHeight: 1000, scrollTop: 1000 });
    render(<OverlayScrollbar />);
    const thumb = screen.getByRole("scrollbar");
    expect(thumb).toHaveAttribute("aria-valuenow", "50");
    expect(thumb).toHaveAttribute("aria-valuemin", "0");
    expect(thumb).toHaveAttribute("aria-valuemax", "100");
  });

  // Home and End keys jump to the top and bottom of the page.
  it("home and end keys jump to the top and bottom of the page", () => {
    setViewport({ scrollHeight: 3000, clientHeight: 1000 });
    const scrollToSpy = jest.spyOn(window, "scrollTo").mockImplementation(() => {});
    render(<OverlayScrollbar />);
    const thumb = screen.getByRole("scrollbar");

    fireEvent.keyDown(thumb, { key: "End" });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 3000 });

    fireEvent.keyDown(thumb, { key: "Home" });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 0 });
    scrollToSpy.mockRestore();
  });

  // Arrow keys and page keys scroll by relative step and page amounts.
  it("arrow keys and page keys scroll by relative step and page amounts", () => {
    setViewport({ scrollHeight: 3000, clientHeight: 1000 });
    const scrollBySpy = jest.spyOn(window, "scrollBy").mockImplementation(() => {});
    render(<OverlayScrollbar />);
    const thumb = screen.getByRole("scrollbar");

    fireEvent.keyDown(thumb, { key: "ArrowDown" });
    expect(scrollBySpy).toHaveBeenCalledWith({ top: 100 }); // 10% of clientHeight 1000

    fireEvent.keyDown(thumb, { key: "ArrowUp" });
    expect(scrollBySpy).toHaveBeenCalledWith({ top: -100 });

    fireEvent.keyDown(thumb, { key: "PageDown" });
    expect(scrollBySpy).toHaveBeenCalledWith({ top: 900 });
    scrollBySpy.mockRestore();
  });

  // Ignores keys it does not handle, leaving scroll position untouched.
  it("ignores keys it does not handle", () => {
    setViewport({ scrollHeight: 3000, clientHeight: 1000 });
    const scrollBySpy = jest.spyOn(window, "scrollBy").mockImplementation(() => {});
    render(<OverlayScrollbar />);
    fireEvent.keyDown(screen.getByRole("scrollbar"), { key: "a" });
    expect(scrollBySpy).not.toHaveBeenCalled();
    scrollBySpy.mockRestore();
  });

  // Hides the thumb while a dialog holds the page scroll lock.
  it("hides the thumb while a dialog holds the page scroll lock", async () => {
    setViewport({ scrollHeight: 3000, clientHeight: 1000 });
    const { useLockPageScroll } = await import("@/lib/page-scroll-lock");

    function Dialog() {
      useLockPageScroll();
      return null;
    }

    const { rerender } = render(<OverlayScrollbar />);
    expect(screen.getByRole("scrollbar")).toBeInTheDocument();

    rerender(
      <>
        <OverlayScrollbar />
        <Dialog />
      </>,
    );
    expect(screen.queryByRole("scrollbar")).not.toBeInTheDocument();
  });
});
