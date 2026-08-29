import { act, render, screen } from "@testing-library/react";

let mockPathname = "/home";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

import RouteLoadingIndicator from "@/components/RouteLoadingIndicator";
import { endRouteTransition, startRouteTransition } from "@/lib/navigation-loading";

// Mirrors the component's own constants.
const SHOW_DELAY_MS = 150;
const MAX_PENDING_MS = 8000;

function clickAnchor(href: string, options: { target?: string; download?: boolean; metaKey?: boolean } = {}) {
  const anchor = document.createElement("a");
  anchor.href = href;
  if (options.target) anchor.target = options.target;
  if (options.download) anchor.setAttribute("download", "");
  // Real <Link> clicks are handled by Next.js's router, not a browser
  // navigation -- prevent jsdom's own "not implemented" navigation so this
  // only exercises RouteLoadingIndicator's capture-phase listener.
  anchor.addEventListener("click", (event) => event.preventDefault());
  document.body.appendChild(anchor);
  anchor.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: options.metaKey ?? false }),
  );
  anchor.remove();
}

describe("components/RouteLoadingIndicator", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockPathname = "/home";
    window.history.pushState({}, "", mockPathname); // keep the real jsdom URL in sync with the usePathname mock
    endRouteTransition(); // reset the singleton store between tests
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  // Renders nothing when no transition is pending.
  it("renders nothing when no transition is pending", () => {
    const { container } = render(<RouteLoadingIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  // Does not show the spinner before the show-delay has elapsed.
  it("does not show the spinner before the show-delay has elapsed", () => {
    render(<RouteLoadingIndicator />);

    act(() => {
      startRouteTransition();
      jest.advanceTimersByTime(SHOW_DELAY_MS - 1);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // Shows the spinner once a transition has been pending past the show-delay.
  it("shows the spinner once a transition has been pending past the show-delay", () => {
    render(<RouteLoadingIndicator />);

    act(() => {
      startRouteTransition();
      jest.advanceTimersByTime(SHOW_DELAY_MS);
    });

    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // Hides again once the pathname commits, even mid-delay.
  it("hides again once the pathname commits, even mid-delay", () => {
    const { rerender } = render(<RouteLoadingIndicator />);

    act(() => {
      startRouteTransition();
      jest.advanceTimersByTime(SHOW_DELAY_MS);
    });
    expect(screen.getByRole("status")).toBeInTheDocument();

    mockPathname = "/dashboard";
    window.history.pushState({}, "", mockPathname);
    rerender(<RouteLoadingIndicator />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // Starts a transition when a same-origin, same-tab <a> is clicked.
  it("starts a transition when a same-origin, same-tab <a> is clicked", () => {
    render(<RouteLoadingIndicator />);

    act(() => {
      clickAnchor("/dashboard");
      jest.advanceTimersByTime(SHOW_DELAY_MS);
    });

    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // Ignores a click on a link to the current path.
  it("ignores a click on a link to the current path", () => {
    render(<RouteLoadingIndicator />);

    act(() => {
      clickAnchor("/home");
      jest.advanceTimersByTime(SHOW_DELAY_MS);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // Ignores a modified click (e.g. cmd/ctrl-click to open in a new tab).
  it("ignores a modified click (e.g. cmd/ctrl-click to open in a new tab)", () => {
    render(<RouteLoadingIndicator />);

    act(() => {
      clickAnchor("/dashboard", { metaKey: true });
      jest.advanceTimersByTime(SHOW_DELAY_MS);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // Ignores a click on a link that opens in a new tab.
  it("ignores a click on a link that opens in a new tab", () => {
    render(<RouteLoadingIndicator />);

    act(() => {
      clickAnchor("/dashboard", { target: "_blank" });
      jest.advanceTimersByTime(SHOW_DELAY_MS);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // Ignores a download link.
  it("ignores a download link", () => {
    render(<RouteLoadingIndicator />);

    act(() => {
      clickAnchor("/report.csv", { download: true });
      jest.advanceTimersByTime(SHOW_DELAY_MS);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // Does not restart the delay for a rapid second navigation while already pending.
  it("does not restart the delay for a rapid second navigation while already pending", () => {
    render(<RouteLoadingIndicator />);

    act(() => {
      startRouteTransition();
      jest.advanceTimersByTime(SHOW_DELAY_MS - 50);
      clickAnchor("/manage-users"); // a second, superseding navigation before the first commits
      jest.advanceTimersByTime(50);
    });

    // Still shows at the original delay -- the second start didn't push the
    // timer back.
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  // Auto-clears a transition that never commits, after the safety timeout.
  it("auto-clears a transition that never commits, after the safety timeout", () => {
    render(<RouteLoadingIndicator />);

    act(() => {
      startRouteTransition();
      jest.advanceTimersByTime(MAX_PENDING_MS);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
