"use client";

// Shared building blocks for react-day-picker calendars in this app --
// used by both the single-date picker (DatePickerField) and the
// date-of-birth range filter (DobRangeFilter) so the two stay visually
// identical instead of drifting apart.

import { useEffect, useRef, useState } from "react";
import type { ChevronProps, DropdownProps } from "react-day-picker";

// Open/close/position state for a calendar popover, shared by
// DatePickerField and DobRangeFilter. Dismisses on outside click, Escape,
// or any scroll/resize. Listener attachment is deferred a tick: react-day-
// picker focuses the selected/today day on mount for keyboard
// accessibility, and if that button is off-screen the browser's default
// focus-scroll fires a native "scroll" event as part of that same mount --
// attaching synchronously would catch that self-inflicted scroll and
// immediately close the popover it just opened.
export function useCalendarPopover() {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null); // trigger button's position, computed on open
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    // Closes unless the click landed inside the trigger or the panel.
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
    // sees it on the way down -- including scrolls inside the popover's
    // own month/year dropdown lists. Only close for scrolls outside the
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

  // Captures the trigger's position before opening, so the portaled panel
  // knows where to render.
  function openPopover() {
    setAnchorRect(triggerRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
  }

  function closePopover() {
    setOpen(false);
  }

  return { open, anchorRect, triggerRef, panelRef, openPopover, closePopover };
}

export function CalendarIcon() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3" y="4.5" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3 8h14M7 3v3M13 3v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// Single chevron glyph, rotated per orientation, matching the thin-stroke
// icon style used elsewhere in the table (SearchIcon, sort arrows) instead
// of react-day-picker's default filled-polygon chevron.
export function Chevron({ orientation = "down", className, disabled }: ChevronProps) {
  const rotation =
    orientation === "up" ? "rotate-180" : orientation === "left" ? "rotate-90" : orientation === "right" ? "-rotate-90" : "";
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={`${rotation} ${disabled ? "opacity-40" : ""} ${className ?? ""}`}
    >
      <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Month/year selector used in the calendar caption. react-day-picker's
// default renders a real `<select>` -- which pops the browser's own
// unstyled, light-themed native list, breaking the dark theme. This
// swaps in a menu built from the same floating-panel pattern as the
// rest of the app (filter popovers, this component's own calendar
// panel): fixed-height trigger, options protrude downward in a
// bounded, scrollable panel.
export function Dropdown({ options, value, onChange, disabled, "aria-label": ariaLabel }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Closes on outside click or Escape, same pattern as useCalendarPopover.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Scrolls the currently-selected option into view when the list opens.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const selectedOption = list?.querySelector<HTMLElement>('[data-selected="true"]');
    if (!list || !selectedOption) return;
    // Scroll only this list's own scrollTop, not Element.scrollIntoView --
    // that can walk up and scroll ancestor containers (even the page) to
    // bring the option into view, which fires a "scroll" event the outer
    // calendar popover's own close-on-scroll listener would catch.
    list.scrollTop = selectedOption.offsetTop - list.clientHeight / 2 + selectedOption.clientHeight / 2;
  }, [open]);

  const selected = options?.find((option) => option.value === value);

  // Reports the pick back through react-day-picker's expected onChange
  // event shape, then closes the menu.
  function selectOption(optionValue: number) {
    onChange?.({ target: { value: String(optionValue) } } as React.ChangeEvent<HTMLSelectElement>);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className="flex h-7 items-center gap-0.5 rounded-md px-1 text-sm font-serif font-semibold text-foreground transition-colors hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-40"
      >
        <span>{selected?.label}</span>
        <Chevron orientation="down" className="h-3 w-3 fill-current text-muted" />
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="overlay-scrollbar animate-panel-in absolute left-0 top-full z-20 mt-1 max-h-56 w-28 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-2xl shadow-black/40"
        >
          {options?.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              data-selected={option.value === value}
              disabled={option.disabled}
              onClick={() => selectOption(option.value)}
              className={`block w-full rounded-md px-2 py-1 text-left text-sm transition-colors ${
                option.value === value
                  ? "bg-accent font-semibold text-accent-foreground hover:bg-accent-hover"
                  : "text-foreground hover:bg-surface-hover"
              } disabled:pointer-events-none disabled:opacity-30`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Shared layout/chrome classNames (caption, nav, grid, weekday, day sizing)
// -- used as-is for single-date selection, and spread with range-specific
// overrides (see DobRangeFilter) for range selection.
export const calendarClassNames = {
  root: "text-foreground",
  months: "relative",
  month: "space-y-3",
  month_caption: "flex h-7 items-center pr-16 text-sm font-serif font-semibold text-foreground",
  dropdowns: "flex items-center gap-1",
  nav: "absolute right-0 top-0 flex items-center gap-1",
  button_previous:
    "flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-foreground aria-disabled:opacity-30 aria-disabled:pointer-events-none",
  button_next:
    "flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-foreground aria-disabled:opacity-30 aria-disabled:pointer-events-none",
  chevron: "h-3.5 w-3.5 fill-current",
  month_grid: "w-full border-collapse",
  weekday: "w-8 pb-1 text-center font-mono text-[11px] font-normal uppercase tracking-wide text-muted",
  day: "p-0 text-center align-middle",
  day_button:
    "flex h-8 w-8 items-center justify-center rounded-full text-sm text-foreground transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
  selected: "[&>button]:bg-accent [&>button]:font-semibold [&>button]:text-accent-foreground [&>button]:hover:bg-accent-hover",
  today: "[&>button]:ring-1 [&>button]:ring-inset [&>button]:ring-accent/70",
  outside: "[&>button]:text-muted/50",
  disabled: "[&>button]:text-muted/30 [&>button]:pointer-events-none [&>button]:hover:bg-transparent",
  hidden: "invisible",
};
