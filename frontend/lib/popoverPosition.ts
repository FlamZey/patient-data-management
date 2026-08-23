// Position for a portaled popover anchored to a trigger element's bounding
// rect. Flips above the trigger when there's no room below (e.g. a row
// scrolled near the bottom of the viewport), and clamps the left edge so
// the popover stays on-screen. heightEstimate/widthEstimate must already
// include any clearance margin, since actual rendered size isn't known
// before first paint.
export function popoverPosition(
  anchorRect: DOMRect,
  heightEstimate: number,
  widthEstimate: number,
): { position: "fixed"; top: number; left: number } {
  return {
    position: "fixed",
    // Below the trigger by default; above it if that would overflow the
    // viewport bottom.
    top:
      anchorRect.bottom + 6 + heightEstimate > window.innerHeight
        ? Math.max(8, anchorRect.top - heightEstimate - 6)
        : anchorRect.bottom + 6,
    // Aligned with the trigger's left edge, pulled back if that would
    // overflow the viewport right edge.
    left: Math.min(anchorRect.left, window.innerWidth - widthEstimate),
  };
}
