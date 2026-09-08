"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createColumnHelper, type ColumnDef, type SortingState } from "@tanstack/react-table";

import { type ColumnFilterConfig } from "@/components/tables/ColumnFilters";
import {
  checklistFilter,
  DataTableCard,
  dateRangeFilter,
  MonoCell,
  textFilter,
  useDataTable,
  useDebouncedFilters,
  useTablePagination,
} from "@/components/tables/table-primitives";
import { apiGetAuditLogs } from "@/lib/api";
import type { AuditLogRead } from "@/lib/types";

// Fixed per-column widths (table-layout: fixed) so columns hold their width
// as content changes -- created_at fits the full timestamp on one line;
// every other column truncates on its own as a backstop.
const COLUMN_WIDTHS: Record<string, string> = {
  created_at: "w-56",
  actor: "w-56",
  event_type: "w-44",
  ip_address: "w-36",
  detail: "w-96",
};

// DataTableCard keys rows by a string `id`, while audit_logs.id is a bigint
// -- rows are mapped to this shape with the id stringified before reaching
// the table; nothing else about the row changes.
interface AuditLogRow extends Omit<AuditLogRead, "id"> {
  id: string;
}

const columnHelper = createColumnHelper<AuditLogRow>();

// "2024-03-01T12:30:00Z" -> "Mar 1, 2024, 12:30:00" in the viewer's zone.
// Unlike lib/date.ts's date-only helpers, these are real instants, so
// `new Date(iso)` is correct -- no bare YYYY-MM-DD to misread as UTC midnight.
function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Renders one event_detail value without knowing what it is -- deliberately
// shape-blind, since a renderer that recognised specific keys would decide
// what reaches the screen, and this log's hard rule is that it never surfaces PHI.
function formatDetailValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function detailEntries(detail: Record<string, unknown> | null): [string, string][] {
  if (!detail) return [];
  return Object.entries(detail).map(([key, value]) => [key, formatDetailValue(value)]);
}

// Self-contained like UserManagementTable: owns its own fetch, loading/error
// state, and columns. Holds no permission check of its own -- whether the
// log is offered is decided by the route that composes it; the backend gates it regardless.
export default function AuditLogTable() {
  const [logs, setLogs] = useState<AuditLogRead[] | null>(null); // null until the first load resolves
  const [total, setTotal] = useState(0); // total matching rows across all pages
  const [loadError, setLoadError] = useState(false);
  const [isFetching, setIsFetching] = useState(false); // true while a sort/filter/page reload is in flight
  // The known event types, as published by the API alongside the page -- the
  // Event checklist's options. Sourced from the server rather than a local
  // constant so the filter can't drift from what the backend actually emits.
  const [eventTypes, setEventTypes] = useState<string[]>([]);

  // Per-keystroke value for the Actor filter; the debounced copy is queried.
  const [actorInput, setActorInput] = useState("");
  const { actor: actorFilter } = useDebouncedFilters({ actor: actorInput });
  // Closed-set checklist filter: all checked means "no filtering", unchecking
  // narrows, unchecking everything matches no rows. Seeded fully-checked once
  // options arrive (see loadLogs); until then, empty reads as "not loaded".
  const [eventTypeFilter, setEventTypeFilter] = useState<string[]>([]);
  // Inclusive "YYYY-MM-DD" bounds, applied on Apply rather than as-you-type
  // (see dateRangeFilter).
  const [dateFrom, setDateFrom] = useState<string | null>(null);
  const [dateTo, setDateTo] = useState<string | null>(null);

  const [sorting, setSorting] = useState<SortingState>([{ id: "created_at", desc: true }]); // newest first
  const { page, setPage, pageSize, setPageSize } = useTablePagination(25, [
    actorFilter,
    eventTypeFilter,
    dateFrom,
    dateTo,
    sorting,
  ]);

  const sortBy = (sorting[0]?.id ?? "created_at") as "created_at" | "event_type" | "actor";
  const sortDir = sorting[0]?.desc ? "desc" : "asc";

  // Tracks the last request actually sent, so a loadLogs recreation that
  // wouldn't change what's sent skips the round trip -- seeding the event-type
  // checklist from the first response is exactly that case.
  const lastRequestKeyRef = useRef<string | null>(null);
  // Guards against an older, slower request's response landing after (and
  // overwriting) a newer one's -- same pattern as UserManagementTable's.
  const latestRequestIdRef = useRef(0);

  const loadLogs = useCallback(async () => {
    // An empty checklist matches nothing -- short-circuit rather than sending
    // an empty param, which the API reads as "no filter". Only blocks once
    // options have arrived; before that, empty just means not loaded yet.
    if (eventTypes.length > 0 && eventTypeFilter.length === 0) {
      ++latestRequestIdRef.current;
      // Invalidate the dedup guard -- otherwise re-selecting everything
      // reproduces pre-touch params, and the guard below would skip that
      // real request, leaving the table stuck on this empty result.
      lastRequestKeyRef.current = null;
      setLogs([]);
      setTotal(0);
      setLoadError(false);
      return;
    }

    const params: Parameters<typeof apiGetAuditLogs>[0] = {
      actor: actorFilter || undefined,
      // Only sent once the checklist has actually been narrowed -- fully
      // checked means "no filtering"; empty is handled above.
      event_type: eventTypeFilter.length < eventTypes.length ? eventTypeFilter : undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      sort_by: sortBy,
      sort_dir: sortDir,
      page,
      page_size: pageSize,
    };

    // The first response seeds the checklist fully-checked, which recreates
    // loadLogs without changing what would be sent. Skip the identical
    // request rather than round-tripping for nothing.
    const requestKey = JSON.stringify(params);
    if (requestKey === lastRequestKeyRef.current) return;
    lastRequestKeyRef.current = requestKey;

    // Claimed after the dedup guard, not before: a call that bails out above
    // changes nothing and must not invalidate the in-flight request it is a
    // duplicate of -- see UserManagementTable's longer note on the same point.
    const requestId = ++latestRequestIdRef.current;
    setIsFetching(true);
    try {
      const data = await apiGetAuditLogs(params);
      // A newer request already started (and will apply its own result) by
      // the time this one resolved -- discard rather than clobber it.
      if (requestId !== latestRequestIdRef.current) return;
      setLogs(data.items);
      setTotal(data.total);
      // Seeded once, from the first response: re-setting these on every page
      // would hand the filter state a fresh-but-equal array each time and
      // re-trigger this effect forever.
      if (eventTypes.length === 0 && data.event_types.length > 0) {
        setEventTypes(data.event_types);
        setEventTypeFilter(data.event_types);
      }
      setLoadError(false);
    } catch {
      if (requestId !== latestRequestIdRef.current) return;
      setLoadError(true);
    } finally {
      if (requestId === latestRequestIdRef.current) setIsFetching(false);
    }
  }, [actorFilter, eventTypeFilter, eventTypes.length, dateFrom, dateTo, sortBy, sortDir, page, pageSize]);

  useEffect(() => {
    (async () => {
      await loadLogs();
    })();
  }, [loadLogs]);

  function retryLoadLogs() {
    setLogs(null);
    setLoadError(false);
    // Bypasses the dedup guard: the failed attempt already claimed this params
    // key, so without the reset a same-params retry would be skipped as "no
    // change" and the table would sit on its spinner forever.
    lastRequestKeyRef.current = null;
    loadLogs();
  }

  // Every column is read-only -- there is no inline editing here, because
  // there is no write endpoint to edit through: the audit log is append-only
  // and written solely by the code paths being audited.
  const columns = useMemo(() => {
    // `any` here is TanStack's own documented pattern for a column list
    // spanning columns with different accessor value types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: ColumnDef<AuditLogRow, any>[] = [
      columnHelper.accessor("created_at", {
        header: "When",
        cell: (info) => <MonoCell>{formatTimestamp(info.getValue())}</MonoCell>,
      }),
      columnHelper.accessor((row) => (row.actor ? `${row.actor.first_name} ${row.actor.last_name}` : null), {
        id: "actor",
        header: "Actor",
        // Always two lines (name, email), even unauthenticated -- its second
        // line is reserved rather than omitted, so every row is a consistent
        // height. Each line truncates on its own rather than wrapping.
        cell: (info) => {
          const actor = info.row.original.actor;
          // No actor is a real, meaningful state -- a sign-in attempt against
          // an email that matches no account -- not missing data, so it's
          // labelled rather than left blank.
          if (!actor) {
            return (
              <div className="flex flex-col">
                <span className="truncate text-muted">Unauthenticated</span>
                <span className="truncate font-mono text-xs text-muted">&nbsp;</span>
              </div>
            );
          }
          return (
            <div className="flex flex-col">
              <span className="truncate" title={`${actor.first_name} ${actor.last_name}`}>{`${actor.first_name} ${actor.last_name}`}</span>
              <span className="truncate font-mono text-xs text-muted" title={actor.email}>
                {actor.email}
              </span>
            </div>
          );
        },
      }),
      columnHelper.accessor("event_type", {
        header: "Event",
        cell: (info) => <MonoCell>{info.getValue()}</MonoCell>,
      }),
      columnHelper.accessor("ip_address", {
        header: "IP address",
        enableSorting: false, // the backend doesn't support sorting by it
        cell: (info) => <MonoCell>{info.getValue() ?? "—"}</MonoCell>,
      }),
      columnHelper.display({
        id: "detail",
        header: "Details",
        cell: (info) => {
          const entries = detailEntries(info.row.original.event_detail);
          if (entries.length === 0) return <span className="text-muted">—</span>;
          // max-w-96 matches the column's own w-96 -- without it, this <p>
          // truncates against the <td>'s rendered width, which fixed-layout
          // stretches to absorb all leftover width since it's the last column.
          return (
            <p
              className="max-w-96 truncate font-mono text-xs text-muted"
              title={entries.map(([k, v]) => `${k}: ${v}`).join(", ")}
            >
              {entries.map(([key, value]) => `${key}: ${value}`).join(", ")}
            </p>
          );
        },
      }),
    ];
    return base;
  }, []);

  const columnFilters: Record<string, ColumnFilterConfig> = {
    actor: textFilter("Actor", actorInput, setActorInput),
    event_type: checklistFilter("Event", eventTypes, eventTypeFilter, setEventTypeFilter),
    created_at: dateRangeFilter(
      dateFrom,
      dateTo,
      ({ from, to }) => {
        setDateFrom(from);
        setDateTo(to);
      },
      "When",
    ),
  };

  const rows: AuditLogRow[] | null = useMemo(
    () => (logs === null ? null : logs.map((log) => ({ ...log, id: String(log.id) }))),
    [logs],
  );

  const table = useDataTable({
    data: rows ?? [],
    columns,
    sorting,
    onSortingChange: setSorting,
  });

  return (
    <DataTableCard
      title="Audit log"
      table={table}
      rows={rows}
      isFetching={isFetching}
      loadError={loadError}
      onRetry={retryLoadLogs}
      errorMessage="Couldn't load the audit log."
      emptyMessage="No audit events found."
      columnWidths={COLUMN_WIDTHS}
      columnFilters={columnFilters}
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
    />
  );
}
