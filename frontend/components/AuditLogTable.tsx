"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createColumnHelper, type ColumnDef, type SortingState } from "@tanstack/react-table";

import { type ColumnFilterConfig } from "@/components/ColumnFilters";
import {
  checklistFilter,
  DataTableCard,
  dateRangeFilter,
  MonoCell,
  textFilter,
  useDataTable,
  useDebouncedFilters,
  useTablePagination,
} from "@/components/table-primitives";
import { apiGetAuditLogs } from "@/lib/api";
import type { AuditLogRead } from "@/lib/types";

// Fixed per-column widths, read off the header row (table-layout: fixed) so
// columns hold their width instead of reflowing as content changes -- same
// rule as UserManagementTable's COLUMN_WIDTHS. created_at is wide enough to
// hold the full formatted timestamp ("Aug 31, 2026, 5:40:25 AM") on one
// line; every column also truncates on its own (see MonoCell/the actor
// cell) as a backstop, so the table never grows a row taller than the rest.
const COLUMN_WIDTHS: Record<string, string> = {
  created_at: "w-56",
  actor: "w-56",
  event_type: "w-44",
  ip_address: "w-36",
  detail: "w-96",
};

// DataTableCard keys every row by a string `id` (see DataTableRow), while
// audit_logs.id is a bigint -- so rows are mapped to this shape, with the id
// stringified, before they reach the table. Nothing else about the row
// changes; the API type stays the exact mirror of the backend schema.
interface AuditLogRow extends Omit<AuditLogRead, "id"> {
  id: string;
}

const columnHelper = createColumnHelper<AuditLogRow>();

// "2024-03-01T12:30:00Z" -> "Mar 1, 2024, 12:30:00" in the viewer's zone.
// Unlike lib/date.ts's date-only helpers, these values are real instants, so
// `new Date(iso)` is correct here -- there's no bare YYYY-MM-DD to be
// misread as UTC midnight.
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

// Renders one event_detail value without knowing what it is.
//
// This is deliberately shape-blind. event_detail is free-form JSONB and its
// contents vary per event type; a renderer that recognised particular keys
// would be the thing that decides which values reach the screen, and the one
// hard rule for this log is that it never surfaces PHI. Serialising whatever
// is there keeps the UI honest about what was actually recorded, and means a
// future event type can't be leaked into view by a renderer written before
// it existed.
function formatDetailValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function detailEntries(detail: Record<string, unknown> | null): [string, string][] {
  if (!detail) return [];
  return Object.entries(detail).map(([key, value]) => [key, formatDetailValue(value)]);
}

// Self-contained the way UserManagementTable is: owns its own fetch
// (server-driven sort/filter/pagination via GET /audit-logs), its loading and
// error state, and its column definitions.
//
// It holds no permission check of its own: whether the audit log is offered
// at all is a whole-feature decision made by the route that composes it (see
// app/manage-users/page.tsx), which is where audit.view is read. The backend
// gates GET /audit-logs independently and refuses regardless -- see
// backend/tests/test_audit.py.
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
  // Closed-set column filtered via a checklist, exactly like the user table's:
  // all checked means "no filtering", unchecking narrows, and unchecking
  // everything matches no rows. Seeded fully-checked the moment the options
  // arrive (see loadLogs) -- until then it's an empty, options-less checklist,
  // which reads as "not loaded yet" rather than as a user-driven "match
  // nothing".
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
    // an empty query param, which the API reads as "no filter" (every row)
    // instead of "no rows". It only counts as blocking once the options have
    // actually arrived; before that an empty selection just means the first
    // response hasn't landed yet. Nothing async happens before this, so it can
    // never itself be superseded.
    if (eventTypes.length > 0 && eventTypeFilter.length === 0) {
      ++latestRequestIdRef.current;
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
        // Two lines (name, email), always -- including the unauthenticated
        // case, whose second line is just reserved rather than omitted, so
        // this column (and every row in this table) is a consistent height
        // regardless of which rows have a resolved actor. Each line
        // truncates on its own rather than wrapping a long name or email
        // into a third line.
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
          // A one-line summary; the expand toggle opens the full panel.
          // max-w-96 matches the column's own w-96 -- without it, this <p>
          // truncates against its <td>'s rendered width instead, which
          // table-layout: fixed stretches to absorb the table's entire
          // leftover width since this is the last (unbordered) column, so
          // long details would run on for a very long way before ellipsing.
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
