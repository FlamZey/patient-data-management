"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { DayPicker, type DateRange } from "react-day-picker";

import Button from "@/components/Button";
import { CalendarIcon, Chevron, Dropdown, calendarClassNames, useCalendarPopover } from "@/components/calendar-primitives";
import { parseISODateLocal, toISODateLocal } from "@/lib/date";
import { popoverPosition } from "@/lib/popoverPosition";

interface DobRangeFilterProps {
  from: string | null; // applied range start ("YYYY-MM-DD"), or null if unset
  to: string | null; // applied range end, or null if unset
  onApply: (range: { from: string | null; to: string | null }) => void;
}

// Approximate rendered size of the calendar + Cancel/Apply footer, plus an
// 8px clearance margin from the viewport edge.
const PANEL_HEIGHT_ESTIMATE = 380;
const PANEL_WIDTH_ESTIMATE = 308;

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

// Date-of-birth column filter: a trigger icon that opens a floating
// range calendar with its own Clear/Cancel/Apply footer (unlike other
// column filters, a range needs an explicit commit step rather than
// applying as the user picks).
export default function DobRangeFilter({ from, to, onApply }: DobRangeFilterProps) {
  const { open, anchorRect, triggerRef, panelRef, openPopover, closePopover } = useCalendarPopover();
  const [draft, setDraft] = useState<DateRange | undefined>(undefined); // in-progress selection, not yet applied

  const isActive = Boolean(from || to); // whether the trigger icon renders in accent color

  function toggleOpen() {
    if (open) {
      closePopover();
      return;
    }
    // Re-seed the draft from the currently applied range every time the
    // popover opens, so a Cancel after tweaking the selection has
    // something correct to discard back to.
    setDraft({ from: parseISODateLocal(from ?? ""), to: parseISODateLocal(to ?? "") });
    openPopover();
  }

  function handleApply() {
    onApply({
      from: draft?.from ? toISODateLocal(draft.from) : null,
      to: draft?.to ? toISODateLocal(draft.to) : null,
    });
    closePopover();
  }

  function handleClear() {
    setDraft(undefined);
    onApply({ from: null, to: null });
    closePopover();
  }

  const today = new Date();
  const earliestMonth = new Date(today.getFullYear() - 130, 0); // caps how far back the month picker scrolls

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
            style={popoverPosition(anchorRect, PANEL_HEIGHT_ESTIMATE, PANEL_WIDTH_ESTIMATE)}
            className="animate-panel-in z-50 rounded-xl border border-border bg-surface p-3 shadow-2xl shadow-black/40"
          >
            <DayPicker
              mode="range"
              selected={draft}
              defaultMonth={draft?.from ?? today}
              onSelect={setDraft}
              disabled={{ after: today }} // no future dates of birth
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
                <Button variant="secondary" size="xs" onClick={closePopover}>
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
