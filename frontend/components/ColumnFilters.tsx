"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { popoverPosition } from "@/lib/popoverPosition";

// Shared column-filter widgetry used by any tanstack-table-backed data
// table (PatientTable, UserManagementTable) that renders a filter icon in
// its header and a floating popover panel for that column's filter.

// A single column's filter: free text, a checklist of options, or a date
// range (rendered elsewhere -- see below).
export type ColumnFilterConfig =
  | { kind: "text"; label: string; value: string; onChange: (value: string) => void }
  | {
      kind: "checklist";
      label: string;
      options: string[]; // every selectable value
      selected: string[]; // currently-checked subset; full list means "no filtering"
      onToggleOption: (option: string) => void;
      onToggleAll: () => void; // select-all / clear-all
    }
  // date-range doesn't route through the popover below -- its own trigger
  // (e.g. DobRangeFilter) renders and portals its own panel, since it needs
  // Cancel/Apply rather than apply-as-you-type. This variant carries the
  // range and its Apply handler so a table's header row can render that
  // trigger from the same config map as every other column's filter.
  | {
      kind: "date-range";
      // Optional, unlike the other two variants': the trigger has a sensible
      // default ("Date of Birth", the column this was built for), and every
      // existing caller relies on it. A table filtering a different date
      // column passes its own so the trigger's accessible name names the
      // right column.
      label?: string;
      from: string | null;
      to: string | null;
      onApply: (range: { from: string | null; to: string | null }) => void;
    };

// Whether a column's filter is currently narrowing the result set (used to
// highlight its trigger icon in accent color).
export function isColumnFilterActive(config: ColumnFilterConfig): boolean {
  if (config.kind === "checklist") return config.selected.length < config.options.length;
  if (config.kind === "date-range") return Boolean(config.from || config.to);
  return Boolean(config.value);
}

// Approximate rendered heights of the popover panel, used to decide whether
// it should open below or above its trigger button.
const FILTER_PANEL_HEIGHT_ESTIMATE = 56; // text filter: just an input
const CHECKLIST_FILTER_PANEL_HEIGHT_ESTIMATE = 180; // checklist: several rows

export function SearchIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16.5 16.5 13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function ChecklistFilterIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3 4.5h14L11.5 11v4.5L8.5 17V11L3 4.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// A checklist row's checkbox -- `indeterminate` is a DOM property, not an
// HTML attribute, so it has to be set imperatively via a ref rather than JSX.
function ChecklistOption({
  label,
  checked,
  indeterminate, // "some but not all others are checked" state, used on the "Select All" row
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);

  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-hover">
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 shrink-0 rounded border-border accent-accent"
      />
      <span className="truncate">{label}</span>
    </label>
  );
}

// Owns which column's filter popover is open and where it should render --
// the trigger button's position, tracked on open only (closing on scroll/
// resize instead of re-tracking keeps this simple).
export function useColumnFilterPopover() {
  const [openFilterColumn, setOpenFilterColumn] = useState<string | null>(null); // column id, or null if none open
  const [filterAnchorRect, setFilterAnchorRect] = useState<DOMRect | null>(null); // open trigger's position
  const filterButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map()); // column id -> its trigger element
  const filterPanelRef = useRef<HTMLDivElement | null>(null);

  // Opens the given column's popover (closing any other), or closes it if
  // it's already the open one.
  function toggleFilterOpen(columnId: string) {
    if (openFilterColumn === columnId) {
      setOpenFilterColumn(null);
      setFilterAnchorRect(null);
      return;
    }
    const button = filterButtonRefs.current.get(columnId);
    setFilterAnchorRect(button?.getBoundingClientRect() ?? null);
    setOpenFilterColumn(columnId);
  }

  // Ref callback factory -- keeps filterButtonRefs in sync as trigger
  // buttons mount/unmount.
  function registerFilterButton(columnId: string) {
    return (el: HTMLButtonElement | null) => {
      if (el) filterButtonRefs.current.set(columnId, el);
      else filterButtonRefs.current.delete(columnId);
    };
  }

  // Close on an outside click, Escape, or any scroll/resize (position is
  // only computed on open, so it'd otherwise drift out of place instead of
  // tracking the trigger button).
  useEffect(() => {
    if (!openFilterColumn) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (filterPanelRef.current?.contains(target)) return;
      if (filterButtonRefs.current.get(openFilterColumn!)?.contains(target)) return;
      setOpenFilterColumn(null);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenFilterColumn(null);
    }
    function handleReposition() {
      setOpenFilterColumn(null);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", handleReposition, true);
    window.addEventListener("resize", handleReposition);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", handleReposition, true);
      window.removeEventListener("resize", handleReposition);
    };
  }, [openFilterColumn]);

  return { openFilterColumn, filterAnchorRect, filterPanelRef, toggleFilterOpen, registerFilterButton };
}

// The header-cell trigger button -- a search icon for text filters, a
// checklist icon otherwise, highlighted accent color while narrowed. Only
// text/checklist configs apply here; date-range renders its own trigger.
export function ColumnFilterTrigger({
  config,
  isOpen,
  onToggle,
  registerRef,
}: {
  config: Exclude<ColumnFilterConfig, { kind: "date-range" }>;
  isOpen: boolean;
  onToggle: () => void;
  registerRef: (el: HTMLButtonElement | null) => void; // registers this button with useColumnFilterPopover
}) {
  return (
    <button
      type="button"
      ref={registerRef}
      onClick={onToggle}
      aria-label={`Filter by ${config.label}`}
      aria-expanded={isOpen}
      className={`transition-colors hover:text-foreground ${
        isColumnFilterActive(config) ? "text-accent" : ""
      }`}
    >
      {config.kind === "checklist" ? <ChecklistFilterIcon /> : <SearchIcon />}
    </button>
  );
}

// The portaled floating panel for whichever text/checklist filter is open.
export function ColumnFilterPanel({
  activeFilter, // config of the currently-open filter, if any
  anchorRect, // its trigger button's position
  panelRef,
}: {
  activeFilter: ColumnFilterConfig | undefined;
  anchorRect: DOMRect | null;
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (!activeFilter || !anchorRect || activeFilter.kind === "date-range") return null;

  const heightEstimate =
    activeFilter.kind === "checklist" ? CHECKLIST_FILTER_PANEL_HEIGHT_ESTIMATE : FILTER_PANEL_HEIGHT_ESTIMATE;

  return createPortal(
    <div
      ref={panelRef}
      style={popoverPosition(anchorRect, heightEstimate, 232)}
      className="animate-panel-in z-50 w-56 rounded-lg border border-border bg-surface p-1.5 shadow-2xl shadow-black/40"
    >
      {activeFilter.kind === "checklist" ? (
        <div className="overlay-scrollbar max-h-72 overflow-y-auto">
          <ChecklistOption
            label="(Select All)"
            checked={activeFilter.selected.length === activeFilter.options.length}
            indeterminate={
              activeFilter.selected.length > 0 && activeFilter.selected.length < activeFilter.options.length
            }
            onChange={activeFilter.onToggleAll}
          />
          {activeFilter.options.map((option) => (
            <ChecklistOption
              key={option}
              label={option}
              checked={activeFilter.selected.includes(option)}
              onChange={() => activeFilter.onToggleOption(option)}
            />
          ))}
        </div>
      ) : (
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted">
            <SearchIcon />
          </span>
          <input
            type="text"
            autoFocus
            value={activeFilter.value}
            onChange={(event) => activeFilter.onChange(event.target.value)}
            placeholder="Filter..."
            className="block w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
        </div>
      )}
    </div>,
    document.body,
  );
}
