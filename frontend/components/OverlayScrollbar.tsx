"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { isPageScrollLocked, subscribePageScrollLock } from "@/lib/page-scroll-lock";

// Persistent overlay replacement for the document's native scrollbar (which
// is hidden globally in globals.css). Floats above the content on a fixed
// track instead of reserving a layout column, and -- unlike the native
// scrollbar on most platforms -- never fades out between scroll events.

const EDGE_OFFSET = 3; // px kept clear at the top/bottom of the viewport
const MIN_THUMB_HEIGHT = 11; // px, so short pages still get a grabbable thumb
const THUMB_LENGTH_SCALE = 1 / 3; // shrinks the thumb relative to a native-proportioned bar
const TRACK_WIDTH = 14; // px hit area (drag/click target); the visible thumb is slimmer
const NAVBAR_ID = "app-navbar"; // see components/NavBar.tsx

interface ScrollMetrics {
  overflow: number; // scrollable distance, in px (0 when nothing to scroll)
  topInset: number; // px the track is pushed down by, to clear the sticky navbar
  trackLength: number; // px available for the thumb to travel within
  thumbHeight: number;
  thumbTop: number; // viewport-relative
  scrollPercent: number;
}

const HIDDEN_METRICS: ScrollMetrics = { overflow: 0, topInset: EDGE_OFFSET, trackLength: 0, thumbHeight: MIN_THUMB_HEIGHT, thumbTop: EDGE_OFFSET, scrollPercent: 0 };

// NavBar renders sticky at top:0 with its own stacking context, so instead
// of layering the track underneath it (which would clip the thumb mid-drag
// whenever it's behind the nav), the track's scrollable range is kept
// entirely below it -- the overlay only ever occupies the area the nav
// bar doesn't.
function readNavbarHeight(): number {
  return document.getElementById(NAVBAR_ID)?.getBoundingClientRect().height ?? 0;
}

function readMetrics(): ScrollMetrics {
  const doc = document.documentElement;
  const scrollHeight = doc.scrollHeight;
  const clientHeight = doc.clientHeight;
  const overflow = scrollHeight - clientHeight;
  const topInset = EDGE_OFFSET + readNavbarHeight();
  const trackLength = Math.max(0, clientHeight - topInset - EDGE_OFFSET);
  const thumbHeight = clientHeight > 0 ? Math.min(trackLength, Math.max(MIN_THUMB_HEIGHT, (clientHeight / scrollHeight) * trackLength * THUMB_LENGTH_SCALE)) : MIN_THUMB_HEIGHT;

  const scrollPercent = overflow > 0 ? Math.min(1, Math.max(0, doc.scrollTop / overflow)) : 0;
  const thumbTop = topInset + scrollPercent * (trackLength - thumbHeight);

  return { overflow, topInset, trackLength, thumbHeight, thumbTop, scrollPercent: Math.round(scrollPercent * 100) };
}

export default function OverlayScrollbar() {
  const trackRef = useRef<HTMLDivElement>(null);
  // Always starts hidden -- identical on the server render and the first
  // client render, so there's no hydration mismatch. The ResizeObserver
  // below measures for real right after mount, as its own async callback.
  const [metrics, setMetrics] = useState<ScrollMetrics>(HIDDEN_METRICS);
  const dragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number } | null>(null);
  const [scrollLocked, setScrollLocked] = useState(isPageScrollLocked);

  const measure = useCallback(() => {
    setMetrics(readMetrics());
  }, []);

  // A dialog holding the lock means the thumb would otherwise float above
  // its backdrop (this track renders at a higher z-index than any dialog)
  // and dragging it would scroll the page behind the dialog out from under it.
  useEffect(() => {
    return subscribePageScrollLock(() => setScrollLocked(isPageScrollLocked()));
  }, []);

  useEffect(() => {
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);

    // Catches content height changes that aren't a viewport resize (data
    // loading in, an accordion opening, images finishing layout, a page
    // transition mounting/unmounting the navbar, ...). Also fires once
    // immediately on observe(), which re-syncs `metrics` against any
    // layout shift that happened between the initial render and this
    // effect running. readMetrics() re-reads the navbar's height fresh
    // every time, so no separate observer is needed just for it.
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(document.documentElement);
    resizeObserver.observe(document.body);

    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      resizeObserver.disconnect();
    };
  }, [measure]);

  const handleThumbPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: document.documentElement.scrollTop,
    };
    document.body.style.userSelect = "none";
  }, []);

  const handleThumbPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const { overflow, trackLength, thumbHeight } = readMetrics();
    const draggableLength = trackLength - thumbHeight;
    if (draggableLength <= 0) return;

    const deltaY = event.clientY - drag.startY;
    const deltaScroll = (deltaY / draggableLength) * overflow;
    window.scrollTo({ top: drag.startScrollTop + deltaScroll });
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    document.body.style.userSelect = "";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  // Clicking the bare track (not the thumb) pages the viewport up/down,
  // matching how a native scrollbar track behaves.
  const handleTrackPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== trackRef.current) return;
    const clickedAboveThumb = event.clientY < metrics.thumbTop;
    const page = document.documentElement.clientHeight * 0.9;
    window.scrollBy({ top: clickedAboveThumb ? -page : page, behavior: "smooth" });
  }, [metrics.thumbTop]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const doc = document.documentElement;
    const step = doc.clientHeight * 0.1;
    const page = doc.clientHeight * 0.9;
    switch (event.key) {
      case "ArrowUp":
        window.scrollBy({ top: -step });
        break;
      case "ArrowDown":
        window.scrollBy({ top: step });
        break;
      case "PageUp":
        window.scrollBy({ top: -page });
        break;
      case "PageDown":
        window.scrollBy({ top: page });
        break;
      case "Home":
        window.scrollTo({ top: 0 });
        break;
      case "End":
        window.scrollTo({ top: doc.scrollHeight });
        break;
      default:
        return;
    }
    event.preventDefault();
  }, []);

  if (scrollLocked || metrics.overflow <= 1) return null;

  return (
    <div
      ref={trackRef}
      onPointerDown={handleTrackPointerDown}
      style={{ top: metrics.topInset, height: metrics.trackLength, width: TRACK_WIDTH }}
      className="fixed right-0 z-40"
    >
      <div
        role="scrollbar"
        aria-orientation="vertical"
        aria-controls="page-scroll-region"
        aria-valuenow={metrics.scrollPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        onPointerDown={handleThumbPointerDown}
        onPointerMove={handleThumbPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        style={{ height: metrics.thumbHeight, transform: `translateY(${metrics.thumbTop - metrics.topInset}px)` }}
        className="mx-auto w-1.5 cursor-pointer touch-none rounded-full bg-muted/45 transition-colors hover:bg-accent focus-visible:bg-accent active:bg-accent"
      />
    </div>
  );
}
