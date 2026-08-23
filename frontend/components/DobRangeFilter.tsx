"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DayPicker, type DateRange } from "react-day-picker";

import Button from "@/components/Button";
import { CalendarIcon, Chevron, Dropdown, calendarClassNames } from "@/components/calendar-primitives";
import { parseISODateLocal, toISODateLocal } from "@/lib/date";

interface DobRangeFilterProps {
  from: string | null;
  to: string | null;
  onApply: (range: { from: string | null; to: string | null }) => void;
}

// Approximate rendered height of the calendar + Cancel/Apply footer, used
// to decide whether the popover should open below or above its trigger.
const PANEL_HEIGHT_ESTIMATE = 380;
const PANEL_WIDTH_ESTIMATE = 300;

// Range mode marks every selected day (start, middle, end) with `selected`
// -- overridden to a no-op here so only range_start/range_end get the solid
// accent circle, while range_middle gets just the light connecting bar.
const rangeCalendarClassNames = {
  ...calendarClassNames,
  selected: "",
  range_start:
    "rounded-l-full bg-accent/15 [&>button]:bg-accent [&>button]:font-semibold [&>button]:text-accent-foreground [&>button]:hover:bg-accent-hover",
  range_end:
    "rounded-r-full bg-accent/15 [&>button]:bg-accent [&>button]:font-semibold [&>button]:text-accent-foreground [&>button]:hover:bg-accent-hover",
  range_middle: "bg-accent/15 [&>button]:font-normal [&>button]:hover:bg-transparent",
};

export default function DobRangeFilter({ from, to, onApply }: DobRangeFilterProps) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const isActive = Boolean(from || to);

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    // Re-seed the draft from the currently applied range every time the
    // popover opens, so a Cancel after tweaking the selection has
    // something correct to discard back to.
    setDraft({ from: parseISODateLocal(from ?? ""), to: parseISODateLocal(to ?? "") });
    setAnchorRect(triggerRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  }

  // Same close behavior (outside click / Escape / scroll / resize) as
  // DatePickerField, including the same one-tick-deferred listener
  // attachment -- react-day-picker's mount-time focus-scroll of the
  // selected/today day would otherwise self-close the popover it just
  // opened.
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

  function handleApply() {
    onApply({
      from: draft?.from ? toISODateLocal(draft.from) : null,
      to: draft?.to ? toISODateLocal(draft.to) : null,
    });
    setOpen(false);
  }

  function handleClear() {
    setDraft(undefined);
    onApply({ from: null, to: null });
    setOpen(false);
  }

  const today = new Date();
  const earliestMonth = new Date(today.getFullYear() - 130, 0);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={toggleOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Filter by Date of Birth"
        className={`transition-colors hover:text-foreground ${isActive ? "text-accent" : ""}`}
      >
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
              // header row scrolled near the bottom of the viewport.
              top:
                anchorRect.bottom + 6 + PANEL_HEIGHT_ESTIMATE > window.innerHeight
                  ? Math.max(8, anchorRect.top - PANEL_HEIGHT_ESTIMATE - 6)
                  : anchorRect.bottom + 6,
              left: Math.min(anchorRect.left, window.innerWidth - PANEL_WIDTH_ESTIMATE - 8),
            }}
            className="animate-panel-in z-50 rounded-xl border border-border bg-surface p-3 shadow-2xl shadow-black/40"
          >
            <DayPicker
              mode="range"
              selected={draft}
              defaultMonth={draft?.from ?? today}
              onSelect={setDraft}
              disabled={{ after: today }}
              captionLayout="dropdown"
              startMonth={earliestMonth}
              endMonth={today}
              formatters={{
                formatWeekdayName: (date) => date.toLocaleDateString(undefined, { weekday: "narrow" }),
              }}
              components={{ Chevron, Dropdown }}
              classNames={rangeCalendarClassNames}
            />
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={handleClear}
                className="rounded-md px-2 py-1 text-xs text-muted transition-colors hover:text-foreground"
              >
                Clear
              </button>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="xs" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button size="xs" onClick={handleApply}>
                  Apply
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
