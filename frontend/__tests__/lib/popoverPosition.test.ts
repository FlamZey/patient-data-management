import { popoverPosition } from "@/lib/popoverPosition";

function rect(overrides: Partial<DOMRect>): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

describe("lib/popoverPosition", () => {
  const originalInnerHeight = window.innerHeight;
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    Object.defineProperty(window, "innerHeight", { value: originalInnerHeight, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
  });

  // Positions below the trigger when there is enough room in the viewport.
  it("positions below the trigger when there is enough room", () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    const anchor = rect({ top: 100, bottom: 120, left: 50 });

    const result = popoverPosition(anchor, 200, 150);

    expect(result.position).toBe("fixed");
    expect(result.top).toBe(126);
  });

  // Flips above the trigger when there is no room below.
  it("flips above the trigger when there is no room below", () => {
    Object.defineProperty(window, "innerHeight", { value: 300, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    const anchor = rect({ top: 250, bottom: 270, left: 50 });

    const result = popoverPosition(anchor, 200, 150);

    expect(result.top).toBe(44);
  });

  // Clamps the flipped position to a minimum of 8px from the viewport top.
  it("clamps the flipped position to a minimum of 8px from the viewport top", () => {
    Object.defineProperty(window, "innerHeight", { value: 100, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    const anchor = rect({ top: 10, bottom: 30, left: 50 });

    const result = popoverPosition(anchor, 500, 150);

    expect(result.top).toBe(8);
  });

  // Aligns the left edge with the trigger when there is room.
  it("aligns the left edge with the trigger when there is room", () => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    const anchor = rect({ left: 100 });

    const result = popoverPosition(anchor, 200, 150);

    expect(result.left).toBe(100);
  });

  // Pulls the left edge back so the popover does not overflow the viewport right edge.
  it("pulls the left edge back to avoid overflowing the viewport right edge", () => {
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    const anchor = rect({ left: 380 });

    const result = popoverPosition(anchor, 200, 150);

    expect(result.left).toBe(250);
  });
});
