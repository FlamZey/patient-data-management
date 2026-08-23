"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DayPicker } from "react-day-picker";

import { CalendarIcon, Chevron, Dropdown, calendarClassNames } from "@/components/calendar-primitives";
import { formatDateDisplay, parseISODateLocal, toISODateLocal } from "@/lib/date";

interface DatePickerFieldProps {
  value: string; // "YYYY-MM-DD"
  onChange: (value: string) => void;
  hasError?: boolean;
}

// Approximate rendered height of the calendar popover, used to decide
// whether it should open below or above its trigger button.
const PANEL_HEIGHT_ESTIMATE = 320;
const PANEL_WIDTH_ESTIMATE = 280;

export default function DatePickerField({ value, onChange, hasError }: DatePickerFieldProps) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    setAnchorRect(triggerRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  }

  // Close on an outside click, Escape, or any scroll/resize -- the panel's
  // position is only computed once, on open, so it'd otherwise drift out
  // of place instead of tracking the trigger button.
  //
  // Listener attachment is deferred a tick: react-day-picker focuses the
  // selected/today day button on mount for keyboard accessibility, and if
  // that button is off-screen the browser's default focus-scroll fires a
  // native "scroll" event as part of that same mount. Attaching
  // synchronously would catch that self-inflicted scroll and immediately
  // close the popover it just opened.
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    // "scroll" doesn't bubble, but a capture-phase window listener still
    // sees it on the way down to its target -- including scrolls inside
    // the popover's own month/year dropdown lists (e.g. scrolling the
    // selected option into view). Only close for scrolls outside the
    // popover; a resize has no such source to exempt.
    function handleScroll(event: Event) {
      if (panelRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    }
    function handleResize() {
      setOpen(false);
    }

    const timeoutId = window.setTimeout(() => {
      document.addEventListener("mousedown", handlePointerDown);
      document.addEventListener("keydown", handleKeyDown);
      window.addEventListener("scroll", handleScroll, true);
      window.addEventListener("resize", handleResize);
    }, 0);
    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [open]);

  const selectedDate = parseISODateLocal(value);
  const today = new Date();
  const earliestMonth = new Date(today.getFullYear() - 130, 0);

  return (
    <div>
      <button
        type="button"
        ref={triggerRef}
        onClick={toggleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-2 rounded-md border ${hasError ? "border-danger" : "border-border"} bg-background px-2 py-1 text-left text-sm text-foreground transition-colors focus:border-accent focus:outline-none`}
      >
        <span>{selectedDate ? formatDateDisplay(value) : "Select date"}</span>
        <CalendarIcon />
      </button>

      {open &&
        anchorRect &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              // Flip above the trigger when there's no room below -- e.g. a
              // row scrolled near the bottom of the viewport.
              top:
                anchorRect.bottom + 6 + PANEL_HEIGHT_ESTIMATE > window.innerHeight
                  ? Math.max(8, anchorRect.top - PANEL_HEIGHT_ESTIMATE - 6)
                  : anchorRect.bottom + 6,
              left: Math.min(anchorRect.left, window.innerWidth - PANEL_WIDTH_ESTIMATE - 8),
            }}
            className="animate-panel-in z-50 rounded-xl border border-border bg-surface p-3 shadow-2xl shadow-black/40"
          >
            <DayPicker
              mode="single"
              required
              selected={selectedDate}
              defaultMonth={selectedDate ?? today}
              onSelect={(date) => {
                onChange(toISODateLocal(date));
                setOpen(false);
              }}
              disabled={{ after: today }}
              captionLayout="dropdown"
              startMonth={earliestMonth}
              endMonth={today}
              formatters={{
                formatWeekdayName: (date) => date.toLocaleDateString(undefined, { weekday: "narrow" }),
              }}
              components={{ Chevron, Dropdown }}
              classNames={calendarClassNames}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
