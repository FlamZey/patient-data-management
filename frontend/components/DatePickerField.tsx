"use client";

import { createPortal } from "react-dom";
import { DayPicker } from "react-day-picker";

import { CalendarIcon, Chevron, Dropdown, calendarClassNames, useCalendarPopover } from "@/components/calendar-primitives";
import { formatDateDisplay, parseISODateLocal, toISODateLocal } from "@/lib/date";
import { popoverPosition } from "@/lib/popoverPosition";

interface DatePickerFieldProps {
  value: string; // "YYYY-MM-DD"
  onChange: (value: string) => void;
  hasError?: boolean; // switches the trigger's border to the danger color
}

// Approximate rendered size of the calendar popover, plus an 8px
// clearance margin from the viewport edge.
const PANEL_HEIGHT_ESTIMATE = 320;
const PANEL_WIDTH_ESTIMATE = 288;

// Single-date picker: a trigger button showing the current value, opening
// a floating react-day-picker calendar on click.
export default function DatePickerField({ value, onChange, hasError }: DatePickerFieldProps) {
  const { open, anchorRect, triggerRef, panelRef, openPopover, closePopover } = useCalendarPopover();

  function toggleOpen() {
    if (open) closePopover();
    else openPopover();
  }

  const selectedDate = parseISODateLocal(value); // undefined if value is empty/invalid
  const today = new Date();
  const earliestMonth = new Date(today.getFullYear() - 130, 0); // caps how far back the month picker scrolls

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
            style={popoverPosition(anchorRect, PANEL_HEIGHT_ESTIMATE, PANEL_WIDTH_ESTIMATE)}
            className="animate-panel-in z-50 rounded-xl border border-border bg-surface p-3 shadow-2xl shadow-black/40"
          >
            <DayPicker
              mode="single"
              required
              selected={selectedDate}
              defaultMonth={selectedDate ?? today}
              onSelect={(date) => {
                onChange(toISODateLocal(date));
                closePopover();
              }}
              disabled={{ after: today }} // no future dates of birth
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
