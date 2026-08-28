"use client";

// Global filter bar for the analytics panel: narrows every tab (overview,
// charts, statistics) down to a subgroup at once, rather than each section
// having its own separate filtering. A lightweight self-contained multi-
// select popover -- not the tanstack-table column-filter machinery
// elsewhere in this app, which is coupled to a paginated table's column/
// header model that doesn't fit an in-memory analytics array.

import { useEffect, useRef, useState } from "react";

import {
  EMPTY_SEGMENT_FILTERS,
  SEGMENT_FILTER_FIELDS,
  filterOptionsFor,
  isFilterActive,
  type SegmentFilters,
} from "@/lib/segmentation";
import type { AnalyticsRow } from "@/lib/analytics";

interface FilterDropdownProps {
  label: string;
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

function FilterDropdown({ label, options, selected, onChange }: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const isActive = selected.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
          isActive
            ? "border-accent/50 bg-accent/10 text-accent"
            : "border-border text-muted hover:text-foreground"
        }`}
      >
        {label}
        {isActive ? <span className="font-mono">({selected.length})</span> : null}
        <svg viewBox="0 0 20 20" fill="none" aria-hidden className="h-3 w-3">
          <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-1.5 max-h-56 w-48 overflow-y-auto overlay-scrollbar rounded-lg border border-border bg-surface p-2 shadow-lg shadow-black/30">
          <button
            type="button"
            onClick={() => onChange(selected.length === options.length ? [] : options)}
            className="mb-1 w-full rounded px-1.5 py-1 text-left text-[11px] text-accent hover:bg-surface-hover"
          >
            {selected.length === options.length ? "Clear all" : "Select all"}
          </button>
          {options.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11px] text-foreground hover:bg-surface-hover"
            >
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={() =>
                  onChange(
                    selected.includes(option)
                      ? selected.filter((value) => value !== option)
                      : [...selected, option],
                  )
                }
                className="accent-accent"
              />
              <span className="truncate">{option}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface SegmentFilterBarProps {
  rows: AnalyticsRow[];
  filters: SegmentFilters;
  onChange: (filters: SegmentFilters) => void;
  matchCount: number;
  totalCount: number;
}

export default function SegmentFilterBar({
  rows,
  filters,
  onChange,
  matchCount,
  totalCount,
}: SegmentFilterBarProps) {
  const active = isFilterActive(filters);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5">
      <span className="text-[11px] text-muted">Segment:</span>
      {SEGMENT_FILTER_FIELDS.map(({ key, label }) => (
        <FilterDropdown
          key={key}
          label={label}
          options={filterOptionsFor(rows, key)}
          selected={filters[key]}
          onChange={(selected) => onChange({ ...filters, [key]: selected })}
        />
      ))}
      {active ? (
        <button
          type="button"
          onClick={() => onChange(EMPTY_SEGMENT_FILTERS)}
          className="text-[11px] text-danger hover:underline"
        >
          Reset
        </button>
      ) : null}
      <span className="ml-auto text-[11px] text-muted">
        {active ? (
          <>
            <span className="font-medium text-foreground">{matchCount.toLocaleString()}</span> of{" "}
            {totalCount.toLocaleString()} patients match
          </>
        ) : (
          `${totalCount.toLocaleString()} patients`
        )}
      </span>
    </div>
  );
}
