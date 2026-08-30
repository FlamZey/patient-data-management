"use client";

// Shared building blocks for this app's data tables -- used by both
// PatientTable and UserManagementTable so the two stay structurally and
// visually identical instead of drifting apart. Each table file owns its
// own fetching, columns and filter state; everything here (the card shell,
// header row, row/cell rendering, row-reorder animation, pagination) is
// common to both.

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
  type Table,
  type TableMeta,
} from "@tanstack/react-table";

import Button from "@/components/Button";
import {
  ColumnFilterPanel,
  ColumnFilterTrigger,
  useColumnFilterPopover,
  type ColumnFilterConfig,
} from "@/components/ColumnFilters";
import DobRangeFilter from "@/components/DobRangeFilter";
import Spinner from "@/components/Spinner";
import { ApiError } from "@/lib/api";
import { useDelayedFlag } from "@/lib/useDelayedFlag";

// Every row rendered here is keyed by a stable server-side id -- used for
// tanstack's getRowId, React keys, and the row-reorder animation below.
export interface DataTableRow {
  id: string;
}

// Page-size choices offered in the footer -- the same set for every table,
// so the control reads identically wherever it appears.
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200, 500];

// --- cell contents ------------------------------------------------------
//
// The pieces a column's `cell` renderer builds from. Column defs stay free
// of styling of their own: what a cell *contains* is the table's business,
// how it looks is this file's.

// An identifier-ish value (a code, an email) -- monospaced so digits and
// characters line up down the column.
export function MonoCell({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

// Row of action buttons in an Actions column.
export function CellActions({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2">{children}</div>;
}

// Validation message under an in-cell editing field.
export function CellFieldError({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-danger">{children}</p>;
}

// Styling for an in-cell <input>/<select> used by inline row editing; red
// border when the field is invalid.
export function tableInputClass(hasError = false): string {
  return `block w-full rounded-md border ${hasError ? "border-danger" : "border-border"} bg-background px-2 py-1 text-sm text-foreground transition-colors focus:border-accent focus:outline-none`;
}

// --- inline row editing ---------------------------------------------------
//
// Click Edit, a row's cells swap to inputs/selects, Save PATCHes just the
// changed fields with an optimistic update (rolled back on failure). Shared
// by PatientTable and UserManagementTable via useInlineRowEdit below; each
// table still owns its own draft shape, field-level validation, and column
// defs -- only the edit/save/rollback lifecycle and its Actions-column
// affordances are common.

// Every inline-edit input/select binds to a string, so a draft is always a
// flat record of them -- both tables' concrete draft types (PatientTable's
// EditDraft, UserManagementTable's) satisfy this structurally.
export type InlineEditDraft = Record<string, string>;

// Edit-state passed through table.options.meta rather than closed over
// directly in column defs. TanStack's flexRender renders a column's `cell`
// as a component type, so column defs need to stay referentially stable --
// meta is how those otherwise-static cell renderers still read current,
// per-keystroke edit state. editDraft is intentionally the loose
// InlineEditDraft rather than each table's own concrete draft type:
// TanStack's TableMeta<TData> is one interface merged across every
// `declare module` augmentation in the program, so two tables each
// pinning `editDraft` to their own distinct type here would conflict.
// Each table's own code still gets full field-name checking on the draft
// it constructs locally (in its onEditClick/toRow/etc.) -- this loose
// typing only applies at the meta boundary.
declare module "@tanstack/react-table" {
  interface TableMeta<TData> {
    editingId: string | null; // id of the row currently in edit mode, if any
    editDraft: InlineEditDraft | null; // that row's in-progress field values
    savingId: string | null; // id of the row currently being PATCHed
    onFieldChange: (field: string, value: string) => void;
    onEditClick: (row: TData) => void;
    onCancel: () => void;
    onSave: (row: TData) => void;
    // Only set by a table that places its own expand toggle inside a
    // column cell (e.g. PatientTable's Actions column) rather than using
    // DataTableCard's built-in leading toggle column -- see
    // ExpandToggleButton and DataTableCardProps.showExpandColumn.
    expandedRowId?: string | null;
    onToggleExpand?: (row: TData) => void;
  }
}

interface UseInlineRowEditOptions<TRow extends DataTableRow, TDraft extends InlineEditDraft> {
  setRows: Dispatch<SetStateAction<TRow[] | null>>;
  // Merges a draft into a full row for the optimistic update shown the
  // instant Save is clicked -- e.g. a plain spread for string fields, or
  // (for a foreign-key select) resolving an id string back to the looked-up
  // object.
  toRow: (row: TRow, draft: TDraft) => TRow;
  // Column ids whose value actually differs from the row being edited --
  // drives both the flash-on-success (DataTableCard matches these against
  // each cell's column id) and, typically, what `request` below sends.
  changedFields: (draft: TDraft, row: TRow) => string[];
  // Sends just the changed fields and resolves with the row as the server
  // now has it.
  request: (id: string, draft: TDraft, changedFields: string[]) => Promise<TRow>;
  // Maps a failed request to what the row's error banner shows -- e.g.
  // distinguishing a 404 (row deleted elsewhere) from a generic failure.
  errorMessage: (err: unknown) => string;
}

// Owns the full inline-edit lifecycle for one table: which row is being
// edited/saved, its draft, per-row save errors, and the flash-on-success
// state -- everything DataTableCard's editingRowId/savingRowId/flashedRow/
// rowError props need. A table wires the returned state into its `meta`
// (see the module augmentation above) and its own onEditClick wrapper (to
// seed the draft -- see toRow's doc comment for why that step is still
// table-specific).
export function useInlineRowEdit<TRow extends DataTableRow, TDraft extends InlineEditDraft>({
  setRows,
  toRow,
  changedFields,
  request,
  errorMessage,
}: UseInlineRowEditOptions<TRow, TDraft>) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<TDraft | null>(null);
  const [editSnapshot, setEditSnapshot] = useState<TRow | null>(null); // pre-edit copy, for rollback on save failure
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({}); // id -> last save-error message
  const [flashedRow, setFlashedRow] = useState<{ id: string; fields: string[] } | null>(null);

  // Enters edit mode for one row, seeding the draft -- the caller builds
  // it (see toRow's doc comment above for why: which fields a draft has,
  // and how they're derived from the row, is table-specific).
  function onEditClick(row: TRow, draft: TDraft) {
    setEditingId(row.id);
    setEditDraft(draft);
    setEditSnapshot(row);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
  }

  // Discards the draft and exits edit mode without saving.
  function onCancel() {
    setEditingId(null);
    setEditDraft(null);
    setEditSnapshot(null);
  }

  function onFieldChange(field: string, value: string) {
    setEditDraft((prev) => prev && { ...prev, [field]: value });
  }

  // Optimistically applies the edit, then sends it -- rolling back to the
  // pre-edit snapshot if the request fails.
  async function onSave(row: TRow) {
    if (!editDraft || !editSnapshot) return;

    const snapshot = editSnapshot;
    const draft = editDraft;
    const fields = changedFields(draft, snapshot);
    const optimistic = toRow(row, draft);

    setRows((prev) => prev?.map((r) => (r.id === row.id ? optimistic : r)) ?? prev);
    setEditingId(null);
    setEditDraft(null);
    setEditSnapshot(null);
    setSavingId(row.id);

    try {
      const updated = await request(row.id, draft, fields);
      setRows((prev) => prev?.map((r) => (r.id === row.id ? updated : r)) ?? prev);
      setRowErrors((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });

      // Flash just the field(s) that actually changed, then clear once the
      // animation finishes -- matches animate-cell-flash's duration.
      if (fields.length > 0) {
        setFlashedRow({ id: row.id, fields });
        window.setTimeout(() => {
          setFlashedRow((prev) => (prev?.id === row.id ? null : prev));
        }, 900);
      }
    } catch (err) {
      // Roll back to the pre-edit snapshot -- the optimistic update above
      // didn't hold, but the rest of the table stays exactly as it was.
      setRows((prev) => prev?.map((r) => (r.id === row.id ? snapshot : r)) ?? prev);
      setRowErrors((prev) => ({ ...prev, [row.id]: errorMessage(err) }));
    } finally {
      setSavingId(null);
    }
  }

  return { editingId, editDraft, savingId, rowErrors, flashedRow, onEditClick, onCancel, onFieldChange, onSave };
}

// The Actions-column contents for an inline-editable row: Cancel/Save while
// editing (Save disabled until the draft's valid), a disabled "Saving..."
// button once Save is clicked but before the request resolves (kept
// visible through that whole window -- see savingRowId's doc comment on
// DataTableCardProps for why this matters), otherwise a plain Edit button.
export function InlineEditActionsCell<TRow extends DataTableRow>({
  row,
  editingId,
  savingId,
  hasErrors,
  onEditClick,
  onCancel,
  onSave,
}: {
  row: TRow;
  editingId: string | null;
  savingId: string | null;
  hasErrors: boolean; // only consulted while this row is the one being edited
  onEditClick: (row: TRow) => void;
  onCancel: () => void;
  onSave: (row: TRow) => void;
}) {
  const isSaving = savingId === row.id;

  if (editingId === row.id) {
    return (
      <>
        <Button variant="secondary" size="xs" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button size="xs" onClick={() => onSave(row)} disabled={isSaving || hasErrors}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </>
    );
  }

  if (isSaving) {
    return (
      <Button variant="accent-outline" size="xs" disabled>
        Saving...
      </Button>
    );
  }

  return (
    <Button
      variant="accent-outline"
      size="xs"
      onClick={() => onEditClick(row)}
      disabled={editingId !== null || savingId !== null} // only one row editable/saving at a time
    >
      Edit
    </Button>
  );
}

// ApiError re-exported so a table's errorMessage callback can branch on
// .status without importing it separately from lib/api.
export { ApiError };

// --- filter config builders ---------------------------------------------

// A free-text column filter, applied through the shared popover.
export function textFilter(
  label: string,
  value: string,
  onChange: (value: string) => void,
): ColumnFilterConfig {
  return { kind: "text", label, value, onChange };
}

// A closed-set column filter: every option checked means "no filtering",
// unchecking narrows, and unchecking everything matches no rows. Owns the
// select-all/clear-all and per-option toggling, so callers only supply the
// options and the state they live in.
export function checklistFilter(
  label: string,
  options: string[],
  selected: string[],
  setSelected: Dispatch<SetStateAction<string[]>>,
): ColumnFilterConfig {
  return {
    kind: "checklist",
    label,
    options,
    selected,
    onToggleOption: (option) =>
      setSelected((prev) =>
        prev.includes(option) ? prev.filter((value) => value !== option) : [...prev, option],
      ),
    onToggleAll: () => setSelected(selected.length === options.length ? [] : [...options]),
  };
}

// An inclusive date range, applied on Apply rather than as-you-type -- see
// the date-range note on ColumnFilterConfig.
export function dateRangeFilter(
  from: string | null,
  to: string | null,
  onApply: (range: { from: string | null; to: string | null }) => void,
): ColumnFilterConfig {
  return { kind: "date-range", from, to, onApply };
}

// --- hooks --------------------------------------------------------------

// useDebouncedFilters' own default delay, exported so callers that need to
// react to its settling independently of whether its output value actually
// changed (see PatientTable's isFetching handling) can use the same window
// instead of a second hardcoded number that could drift out of sync.
export const DEBOUNCE_DELAY_MS = 300;

// Debounces a group of text-filter inputs together, so typing doesn't fire
// a request per keystroke and several inputs touched inside the same window
// commit as one update (one reload, not one per field).
export function useDebouncedFilters<T extends Record<string, string>>(inputs: T, delayMs = DEBOUNCE_DELAY_MS): T {
  const [debounced, setDebounced] = useState(inputs);
  // Serialized so the effect depends on the values themselves rather than
  // on the object literal's per-render identity -- and so the timeout reads
  // the values it was scheduled with instead of a stale closure.
  const serialized = JSON.stringify(inputs);

  useEffect(() => {
    const handle = setTimeout(() => {
      // Keeps the same object when the values haven't actually moved (e.g.
      // a keystroke typed and then undone inside one window), so callers
      // holding the returned object don't see a spurious change.
      setDebounced((prev) => (JSON.stringify(prev) === serialized ? prev : (JSON.parse(serialized) as T)));
    }, delayMs);
    return () => clearTimeout(handle);
  }, [serialized, delayMs]);

  return debounced;
}

// Page number + page size for a server-paginated table. `resetKey` is
// whatever invalidates the current page -- the active filters and sort.
//
// The page is stored alongside the key it was chosen under and read back as
// 1 once that key moves on, rather than being reset from an effect: a
// filter change lands on page 1 in the same render, instead of rendering
// (and fetching) the stale page first and correcting itself afterwards.
export function useTablePagination(defaultPageSize: number, resetKey: unknown) {
  const [pageSize, setPageSize] = useState(defaultPageSize);
  // Serialized so equal-but-newly-allocated filter arrays (a checklist
  // re-seeded with the same options, say) don't read as a change.
  const key = JSON.stringify([resetKey, pageSize]);
  const [pageState, setPageState] = useState({ key, page: 1 });

  const page = pageState.key === key ? pageState.page : 1;
  const setPage = useCallback((next: number) => setPageState({ key, page: next }), [key]);

  return { page, setPage, pageSize, setPageSize };
}

// The tanstack config both tables share: single-column, server-side sorting
// with rows keyed by id. Only data/columns/sorting (and, for a table with
// inline editing, meta) differ between callers.
export function useDataTable<T extends DataTableRow>({
  data,
  columns,
  sorting,
  onSortingChange,
  meta,
}: {
  data: T[];
  // `any` here is TanStack's own documented pattern for a column list
  // spanning columns with different accessor value types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
  meta?: TableMeta<T>;
}): Table<T> {
  return useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange,
    manualSorting: true, // sorting happens server-side, driven by the sorting state above
    // Without this, TanStack infers each column's first-click direction from
    // the currently-displayed rows (getAutoSortDir), which defaults to
    // 'desc' whenever the current page happens to be empty -- so the first
    // click's direction would depend on what's on screen rather than always
    // being asc.
    sortDescFirst: false,
    enableMultiSort: false,
    enableSortingRemoval: false, // clicking a sorted column just flips asc/desc, never clears it
    getCoreRowModel: getCoreRowModel(),
    // Keys rows by record id instead of array index, so a reordering sort
    // moves each row's existing <tr> (letting the FLIP effect below track
    // it) rather than every row just getting new content in place.
    getRowId: (row) => row.id,
    meta,
  });
}

// Row-position "FLIP" animation: when a sort/filter/page reload reorders
// rows already on screen, existing <tr>s slide from their old position to
// their new one instead of jumping. The returned map tracks each mounted
// row's DOM node by id (DataTableCard registers them); prevRectsRef holds
// where each one was as of the last commit, re-measured every time `rows`
// changes.
function useRowFlipAnimation(rows: unknown) {
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const prevRectsRef = useRef(new Map<string, DOMRect>());

  // Runs after every `rows` update, once the DOM has already committed rows
  // in their new order. For any row present both before and now, instantly
  // re-applies its old position as a transform (no transition), forces a
  // reflow, then animates that transform away -- the row visually slides
  // from where it was to where it now is instead of jumping. Brand-new rows
  // (no previous rect) are left alone, so they just get their normal
  // animate-rise-in entrance.
  useLayoutEffect(() => {
    const prevRects = prevRectsRef.current;
    const nextRects = new Map<string, DOMRect>();
    rowRefs.current.forEach((el, id) => nextRects.set(id, el.getBoundingClientRect()));

    if (prevRects.size > 0) {
      nextRects.forEach((nextRect, id) => {
        const prevRect = prevRects.get(id);
        const el = rowRefs.current.get(id);
        if (!prevRect || !el) return;

        const deltaY = prevRect.top - nextRect.top;
        if (Math.abs(deltaY) < 1) return;

        el.style.transition = "none";
        el.style.transform = `translateY(${deltaY}px)`;
        el.getBoundingClientRect(); // forces layout so the line above is committed before this one
        el.style.transition = "transform 350ms cubic-bezier(0.16, 1, 0.3, 1)";
        el.style.transform = "";
      });
    }

    prevRectsRef.current = nextRects;
  }, [rows]);

  return rowRefs;
}

// --- rendering ----------------------------------------------------------

// Chevron shown next to a sortable column's header -- fades/scales in once
// the column is sorted (rather than popping in) and rotates between asc/
// desc instead of swapping glyphs, so the direction change reads as a
// single smooth motion.
function SortIndicator({ direction }: { direction: false | "asc" | "desc" }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={`ml-1 h-3 w-3 shrink-0 transition-all duration-200 ${
        direction ? "scale-100 opacity-100" : "scale-50 opacity-0"
      } ${direction === "desc" ? "rotate-180" : ""}`}
    >
      <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Toggle button for a row's expandable detail panel -- same chevron glyph as
// SortIndicator, but driven by open/closed state rather than sort direction.
function ExpandChevron({ isExpanded }: { isExpanded: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={`h-3.5 w-3.5 shrink-0 text-muted transition-all duration-200 ${isExpanded ? "rotate-180" : ""}`}
    >
      <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Toggle button for a row's expandable detail panel, exported so a table
// that places the toggle inside its own column cell (e.g. PatientTable's
// Actions column, via table.options.meta.expandedRowId/onToggleExpand)
// renders the same button DataTableCard's built-in leading column would
// have -- see DataTableCardProps.showExpandColumn.
export function ExpandToggleButton({ isExpanded, onClick }: { isExpanded: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={isExpanded}
      aria-label={isExpanded ? "Hide details" : "Show details"}
      className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-surface-hover"
    >
      <ExpandChevron isExpanded={isExpanded} />
    </button>
  );
}

interface DataTableCardProps<T extends DataTableRow> {
  // Card header
  eyebrow: string; // small uppercase kicker above the title
  title: string;
  headerActions?: ReactNode; // right-hand side of the header bar, e.g. an "Add" button

  table: Table<T>;
  rows: T[] | null; // null until the first load resolves
  isFetching: boolean; // a sort/filter/page reload is in flight
  loadError: boolean;
  onRetry: () => void;
  errorMessage: string; // shown above the Retry button
  emptyMessage: string; // shown in place of rows when nothing matches

  columnWidths: Record<string, string>; // column id -> tailwind width class
  columnFilters: Record<string, ColumnFilterConfig>; // column id -> its filter, for columns that have one

  // Per-row state. These say what is true of a row, not how to draw it --
  // the styling for each lives below, so it can't drift between tables.
  editingRowId?: string | null; // row currently in inline-edit mode: accent rail, no hover/entrance
  // Row with a save in flight -- kept visually distinct (same accent rail
  // as editingRowId) for the whole request, not just while its inputs are
  // showing. Without this, a row whose edit mode has already closed reads
  // as fully saved -- indistinguishable from a confirmed row -- for
  // however long the request takes, so a rollback+error later on feels
  // like it came from nowhere.
  savingRowId?: string | null;
  flashedRow?: { id: string; fields?: string[] } | null; // row that just saved; omit `fields` to flash the whole row
  rowError?: (row: T) => string | undefined; // message for this row's error banner, if it has one

  // Expandable per-row detail panel. expandedRowId/renderExpandedContent
  // are required together -- a table that doesn't pass
  // renderExpandedContent gets no expanded-row highlighting or detail row
  // at all. onToggleExpand additionally drives DataTableCard's own leading
  // toggle column; a table that instead places its own ExpandToggleButton
  // inside a column cell (reading/writing expandedRowId through its own
  // state, e.g. PatientTable's Actions column) omits onToggleExpand and
  // passes showExpandColumn={false} to suppress that leading column.
  expandedRowId?: string | null; // row whose detail panel is open, if any
  onToggleExpand?: (row: T) => void;
  renderExpandedContent?: (row: T) => ReactNode;
  showExpandColumn?: boolean; // default true; set false when a column cell renders its own expand toggle instead

  // Pagination
  page: number; // 1-indexed
  pageSize: number;
  total: number; // total matching rows across all pages
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

// The full data-table card: header bar, loading/error/empty states, the
// table itself (sticky sortable + filterable header, animated rows) and the
// pagination footer.
export function DataTableCard<T extends DataTableRow>({
  eyebrow,
  title,
  headerActions,
  table,
  rows,
  isFetching,
  loadError,
  onRetry,
  errorMessage,
  emptyMessage,
  columnWidths,
  columnFilters,
  editingRowId,
  savingRowId,
  flashedRow,
  rowError,
  expandedRowId,
  onToggleExpand,
  renderExpandedContent,
  showExpandColumn = true,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: DataTableCardProps<T>) {
  const { openFilterColumn, filterAnchorRect, filterPanelRef, toggleFilterOpen, registerFilterButton } =
    useColumnFilterPopover();
  const rowRefs = useRowFlipAnimation(rows);
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Opening a row's detail panel can render it partly (or entirely) below
  // the fold -- both the table's own fixed-height scroll area and the page
  // itself. Scroll the row to the top of those on open so the panel that
  // just appeared underneath it is actually visible, not just "moved focus
  // to" -- for a disclosure toggle like this, focus stays on the button
  // that was clicked (matching standard accordion/disclosure behavior);
  // only the scroll position changes.
  //
  // This is done as two explicit, independent scrollBy calls rather than
  // one native el.scrollIntoView() -- the table's own fixed-height area and
  // the page itself are separate scroll contexts, each occluded by a
  // different sticky element (the area's own thead vs. the page's nav bar,
  // #app-navbar), and native scrollIntoView only accepts a single
  // scroll-margin-top shared across every ancestor it walks. Using the
  // larger of the two heights for both (as this used to) overshoots
  // whichever occluder is actually smaller -- in practice the thead, which
  // left a sliver of the previous row peeking out between it and the
  // row that just got scrolled to "the top". Computing each context's own
  // delta against its own occluder avoids that.
  useEffect(() => {
    if (!expandedRowId) return;
    const el = rowRefs.current.get(expandedRowId);
    const scrollArea = scrollAreaRef.current;
    if (!el || !scrollArea) return;

    const theadHeight = theadRef.current?.getBoundingClientRect().height ?? 0;
    const navHeight = document.getElementById("app-navbar")?.getBoundingClientRect().height ?? 0;
    const rowRect = el.getBoundingClientRect();
    const areaRect = scrollArea.getBoundingClientRect();

    // The row's position relative to the scroll area's own top is
    // unaffected by the page's scroll position (both move together), so
    // this and the page-level adjustment below can be computed from the
    // same, single read of the current layout.
    //
    // Vertical and horizontal are combined into one scrollBy call on
    // scrollArea -- two separate smooth-behavior calls on the same element
    // race each other (the second interrupts/restarts the first before its
    // animation finishes), which was cutting the vertical scroll short.
    scrollArea.scrollBy({
      top: rowRect.top - areaRect.top - (theadHeight + 8),
      // The detail panel that's about to open is one cell spanning the
      // row, anchored at its left edge -- scroll back to it rather than
      // leaving the area wherever a wide table's Actions column (at the
      // row's right edge) had to be scrolled to reach the toggle.
      left: -scrollArea.scrollLeft,
      behavior: "smooth",
    });
    window.scrollBy({ top: areaRect.top - (navHeight + 8), behavior: "smooth" });
  }, [expandedRowId, rowRefs]);

  // "X-Y of Z" pagination label inputs.
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  // +1 for the leading expand-toggle cell, which isn't a real TanStack
  // column (so per-table column defs/widths never have to know about it).
  // Not added when a column cell renders its own toggle instead (see
  // showExpandColumn).
  const columnCount = table.getVisibleLeafColumns().length + (renderExpandedContent && showExpandColumn ? 1 : 0);

  const activeColumnFilter = openFilterColumn ? columnFilters[openFilterColumn] : undefined;

  // A sort/filter/page reload spinner -- only relevant once the initial
  // load has already resolved (that case is covered by the `rows === null`
  // spinner below), and delayed so a fast reload doesn't just flash.
  const showReloadSpinner = useDelayedFlag(isFetching && rows !== null);

  return (
    <>
      <div className="animate-rise-in overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-5 sm:px-8">
          <div>
            <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-teal uppercase">{eyebrow}</p>
            <h2 className="font-serif text-lg font-semibold text-foreground">{title}</h2>
          </div>
          <div className="flex items-center gap-3">
            {showReloadSpinner && (
              <div className="animate-backdrop-in" role="status" aria-label="Loading">
                <Spinner size="sm" className="text-accent" />
              </div>
            )}
            {headerActions}
          </div>
        </div>

        {rows === null && !loadError && (
          <div className="animate-backdrop-in flex justify-center py-16">
            <Spinner size="md" className="text-accent" />
          </div>
        )}

        {loadError && (
          <div className="animate-backdrop-in flex flex-col items-center gap-4 py-16 text-center">
            <p className="text-sm text-muted">{errorMessage}</p>
            <Button variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}

        {rows !== null && !loadError && (
          <div ref={scrollAreaRef} className="animate-backdrop-in overlay-scrollbar h-[550.5px] overflow-auto">
            <table className="w-full min-w-215 table-fixed text-left text-sm">
              <thead ref={theadRef} className="sticky top-0 z-10 bg-surface">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id} className="border-b border-border text-xs uppercase tracking-wide text-muted">
                    {renderExpandedContent && showExpandColumn && (
                      <th className="w-10 px-4 py-3 align-top sm:px-6" aria-hidden="true" />
                    )}
                    {headerGroup.headers.map((header, index) => {
                      const columnFilter = columnFilters[header.column.id];
                      const isLast = index === headerGroup.headers.length - 1;
                      return (
                        <th
                          key={header.id}
                          className={`relative px-4 py-3 align-top font-mono font-medium sm:px-6 ${columnWidths[header.column.id] ?? ""}`}
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            {header.column.getCanSort() ? (
                              <button
                                type="button"
                                onClick={header.column.getToggleSortingHandler()}
                                className="flex items-center gap-1 transition-colors hover:text-foreground"
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                <SortIndicator direction={header.column.getIsSorted()} />
                              </button>
                            ) : (
                              flexRender(header.column.columnDef.header, header.getContext())
                            )}
                            {/* A date range renders its own trigger+panel (it needs Cancel/Apply) */}
                            {columnFilter?.kind === "date-range" && (
                              <DobRangeFilter
                                from={columnFilter.from}
                                to={columnFilter.to}
                                onApply={columnFilter.onApply}
                              />
                            )}
                            {/* Every other filterable column uses the shared trigger/popover */}
                            {columnFilter && columnFilter.kind !== "date-range" && (
                              <ColumnFilterTrigger
                                config={columnFilter}
                                isOpen={openFilterColumn === header.column.id}
                                onToggle={() => toggleFilterOpen(header.column.id)}
                                registerRef={registerFilterButton(header.column.id)}
                              />
                            )}
                          </div>
                          {!isLast && (
                            <span className="pointer-events-none absolute right-0 top-1/2 h-4 w-px -translate-y-1/2 bg-border" />
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={columnCount} className="py-16 text-center text-sm text-muted">
                      {emptyMessage}
                    </td>
                  </tr>
                )}
                {table.getRowModel().rows.map((row, index) => {
                  // Pinned open (accent rail, no hover/entrance) while
                  // either editing or saving -- a save in flight keeps the
                  // same treatment its editing did, so the row stays
                  // visually "not yet settled" for the request's full
                  // duration instead of reading as done the instant edit
                  // mode closes.
                  const isExpanded = renderExpandedContent != null && expandedRowId === row.id;
                  const isActive =
                    (editingRowId != null && row.id === editingRowId) ||
                    (savingRowId != null && row.id === savingRowId) ||
                    isExpanded;
                  // A flash with no `fields` covers every cell in the row --
                  // for an edit whose changed fields aren't known (e.g. one
                  // made through a dialog).
                  const flashedFields = flashedRow?.id === row.id ? (flashedRow.fields ?? null) : undefined;
                  const error = rowError?.(row.original);
                  return (
                    <Fragment key={row.id}>
                      <tr
                        ref={(el) => {
                          if (el) rowRefs.current.set(row.id, el);
                          else rowRefs.current.delete(row.id);
                        }}
                        className={`border-b border-border last:border-b-0 transition-colors ${
                          isActive
                            ? "border-l-2 border-l-accent bg-accent/5"
                            : "animate-rise-in hover:bg-surface-hover"
                        }`}
                        // The staggered entrance only applies to rows running
                        // animate-rise-in -- an active row is pinned open
                        // instead, so it opts out of both.
                        style={isActive ? undefined : { animationDelay: `${Math.min(index * 0.04, 0.3)}s` }}
                      >
                        {renderExpandedContent && showExpandColumn && (
                          <td className="px-4 py-3 align-top sm:px-6">
                            <ExpandToggleButton
                              isExpanded={isExpanded}
                              onClick={() => onToggleExpand?.(row.original)}
                            />
                          </td>
                        )}
                        {row.getVisibleCells().map((cell) => (
                          <td
                            key={cell.id}
                            className={`px-4 py-3 align-top text-foreground sm:px-6 ${
                              flashedFields !== undefined &&
                              (flashedFields === null || flashedFields.includes(cell.column.id))
                                ? "animate-cell-flash"
                                : ""
                            }`}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                      {/* Per-row error banner, spanning the full row */}
                      {error && (
                        <tr className="border-b border-border last:border-b-0">
                          <td colSpan={columnCount} className="px-4 py-2 sm:px-6">
                            <p
                              role="alert"
                              className="rounded-md border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-foreground"
                            >
                              {error}
                            </p>
                          </td>
                        </tr>
                      )}
                      {/* Expandable per-row detail panel */}
                      {isExpanded && renderExpandedContent && (
                        <tr className="border-b border-border last:border-b-0">
                          <td colSpan={columnCount} className="animate-rise-in px-4 py-3 sm:px-6">
                            {renderExpandedContent(row.original)}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border px-6 py-4 sm:px-8">
          <p className="font-mono text-xs text-muted">
            {total === 0 ? "0 of 0" : `${start}–${end} of ${total}`}
          </p>
          <div className="flex items-center gap-3">
            <select
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors focus:border-accent focus:outline-none"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size} / page
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="xs"
                onClick={() => onPageChange(Math.max(1, page - 1))}
                // Also disabled while a reload's in flight -- without this,
                // repeated clicks each fire their own request (same cost
                // sort-spamming had before it got debounced+aborted; paging
                // isn't debounced, so this is the cheaper fix for it).
                disabled={page <= 1 || isFetching}
              >
                Prev
              </Button>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => onPageChange(page + 1)}
                disabled={page * pageSize >= total || isFetching}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </div>

      <ColumnFilterPanel activeFilter={activeColumnFilter} anchorRect={filterAnchorRect} panelRef={filterPanelRef} />
    </>
  );
}
