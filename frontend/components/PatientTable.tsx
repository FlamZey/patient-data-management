"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";

import Button from "@/components/Button";
import {
  ColumnFilterPanel,
  ColumnFilterTrigger,
  useColumnFilterPopover,
  type ColumnFilterConfig,
} from "@/components/ColumnFilters";
import DatePickerField from "@/components/DatePickerField";
import DobRangeFilter from "@/components/DobRangeFilter";
import { apiGetPatients, apiPatchPatient, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateDisplay } from "@/lib/date";
import { hasPermission } from "@/lib/permissions";
import type { Gender, PatientRead, PatientUpdate } from "@/lib/types";

interface PatientTableProps {
  // Bumped by the parent (e.g. after a successful upload) to trigger a
  // reload without this component needing an imperative ref API.
  refreshSignal?: number;
}

// The row currently being edited, as free-form strings (inputs/selects
// bind directly to these before they're validated/converted on save).
interface EditDraft {
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
}

// Editable-cell state passed through table.options.meta rather than closed
// over directly in column defs. TanStack's flexRender renders a column's
// `cell` as a component type, so column defs need to stay referentially
// stable (see the `columns` useMemo below) -- meta is how those otherwise-
// static cell renderers still read current, per-keystroke edit state.
declare module "@tanstack/react-table" {
  interface TableMeta<TData> {
    editingId: string | null; // id of the row currently in edit mode, if any
    editDraft: EditDraft | null; // that row's in-progress field values
    savingId: string | null; // id of the row currently being PATCHed
    onFieldChange: (field: keyof EditDraft, value: string) => void;
    onEditClick: (patient: TData) => void;
    onCancel: () => void;
    onSave: (patient: TData) => void;
  }
}

const GENDERS: Gender[] = ["Male", "Female", "Other", "Prefer not to say"];
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
// Fixed per-column widths (table-layout: fixed reads these off the header
// row only) so columns hold their width instead of reflowing as content or
// sort/filter state changes.
const COLUMN_WIDTHS: Record<string, string> = {
  patient_code: "w-32",
  first_name: "w-40",
  last_name: "w-40",
  date_of_birth: "w-40",
  gender: "w-32",
  actions: "w-32",
};

// Small loading indicator shown while the first page of data is in flight.
function PulseDot() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
    </div>
  );
}

// Styling for an inline-edit <input>/<select>; red border when invalid.
function inputClass(hasError = false): string {
  return `block w-full rounded-md border ${hasError ? "border-danger" : "border-border"} bg-background px-2 py-1 text-sm text-foreground transition-colors focus:border-accent focus:outline-none`;
}

// Mirrors the DOB/Gender rules from backend/app/services/patient_import.py
// (reused server-side by PatientUpdate in schemas.py) -- this is in
// addition to, not instead of, that server-side validation.
function validateDraft(draft: EditDraft): { date_of_birth?: string; gender?: string } {
  const errors: { date_of_birth?: string; gender?: string } = {};

  if (!GENDERS.includes(draft.gender as Gender)) {
    errors.gender = "Must be one of the listed options.";
  }

  const parsed = new Date(draft.date_of_birth);
  if (!draft.date_of_birth || Number.isNaN(parsed.getTime())) {
    errors.date_of_birth = "Must be a valid date.";
  } else if (parsed.getTime() > Date.now()) {
    errors.date_of_birth = "Cannot be in the future.";
  }

  return errors;
}

// Small ↑/↓ arrow shown next to a sorted column's header.
function sortIndicator(direction: false | "asc" | "desc") {
  if (!direction) return null;
  return <span className="ml-1">{direction === "asc" ? "↑" : "↓"}</span>;
}

const columnHelper = createColumnHelper<PatientRead>();

// Patient records table: server-driven sort/filter/pagination, plus
// inline row editing (click Edit, fields become inputs, Save/Cancel).
// Self-contained -- owns its own fetch, loading/error state, and
// permission checks.
export default function PatientTable({ refreshSignal }: PatientTableProps) {
  const { currentUser } = useAuth();
  const canEdit = hasPermission(currentUser, "patient.edit"); // gates the Actions column entirely

  const [patients, setPatients] = useState<PatientRead[] | null>(null); // null until the first load resolves
  const [total, setTotal] = useState(0); // total matching rows across all pages
  const [loadError, setLoadError] = useState(false);

  // Raw (per-keystroke) and debounced (actually-queried) values for each
  // column's own filter input.
  const [patientCodeInput, setPatientCodeInput] = useState("");
  const [firstNameInput, setFirstNameInput] = useState("");
  const [lastNameInput, setLastNameInput] = useState("");
  const [patientCodeFilter, setPatientCodeFilter] = useState("");
  const [firstNameFilter, setFirstNameFilter] = useState("");
  const [lastNameFilter, setLastNameFilter] = useState("");
  // Gender is a closed set (GENDERS below), filtered via a checklist rather
  // than free text -- all checked by default (no filtering applied) and
  // narrowed by unchecking options. Unchecking everything (including via
  // "Select All") shows no rows, same as any other filter combination that
  // matches nothing. Applied immediately, no debounce.
  const [genderFilter, setGenderFilter] = useState<string[]>(GENDERS);
  // Date of birth is filtered as an inclusive range, applied immediately
  // (no debounce) once the user hits Apply in DobRangeFilter's popover --
  // both ends are optional, so either can be left open.
  const [dobFrom, setDobFrom] = useState<string | null>(null);
  const [dobTo, setDobTo] = useState<string | null>(null);
  const { openFilterColumn, filterAnchorRect, filterPanelRef, toggleFilterOpen, registerFilterButton } =
    useColumnFilterPopover();
  const [sorting, setSorting] = useState<SortingState>([{ id: "patient_code", desc: false }]); // tanstack's single-column sort state
  const [page, setPage] = useState(1); // 1-indexed current page
  const [pageSize, setPageSize] = useState(25);

  // Inline-edit state -- only one row can be edited at a time.
  const [editingId, setEditingId] = useState<string | null>(null); // id of the row in edit mode
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null); // its in-progress field values
  const [editSnapshot, setEditSnapshot] = useState<PatientRead | null>(null); // pre-edit copy, for rollback on save failure
  const [savingId, setSavingId] = useState<string | null>(null); // id currently being PATCHed
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({}); // id -> last save-error message

  // Debounce the per-column filter inputs so every keystroke doesn't fire a
  // request -- all three commit together, same 300ms window.
  useEffect(() => {
    const handle = setTimeout(() => {
      setPatientCodeFilter(patientCodeInput);
      setFirstNameFilter(firstNameInput);
      setLastNameFilter(lastNameInput);
    }, 300);
    return () => clearTimeout(handle);
  }, [patientCodeInput, firstNameInput, lastNameInput]);

  // A changed filter/sort/page-size invalidates the current page number.
  useEffect(() => {
    setPage(1);
  }, [patientCodeFilter, firstNameFilter, lastNameFilter, genderFilter, dobFrom, dobTo, sorting, pageSize]);

  // Derived from tanstack's sorting state -- single-column sort only.
  const sortBy = (sorting[0]?.id ?? "patient_code") as
    | "patient_code"
    | "first_name"
    | "last_name"
    | "date_of_birth";
  const sortDir = sorting[0]?.desc ? "desc" : "asc";

  // Fetches the current page from the server using all active filters/
  // sort/pagination state.
  const loadPatients = useCallback(async () => {
    // No gender checked means the filter matches nothing -- short-circuit
    // rather than sending an empty `gender` param, which the API would
    // read as "no filter" (i.e. every row) instead of "no rows".
    if (genderFilter.length === 0) {
      setPatients([]);
      setTotal(0);
      setLoadError(false);
      return;
    }

    try {
      const data = await apiGetPatients({
        patient_code: patientCodeFilter || undefined,
        first_name: firstNameFilter || undefined,
        last_name: lastNameFilter || undefined,
        // Only sent when the checklist has been narrowed -- fully checked
        // means "no filtering"; fully unchecked is handled above.
        gender: genderFilter.length < GENDERS.length ? genderFilter : undefined,
        date_of_birth_from: dobFrom || undefined,
        date_of_birth_to: dobTo || undefined,
        sort_by: sortBy,
        sort_dir: sortDir,
        page,
        page_size: pageSize,
      });
      setPatients(data.items);
      setTotal(data.total);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [patientCodeFilter, firstNameFilter, lastNameFilter, genderFilter, dobFrom, dobTo, sortBy, sortDir, page, pageSize]);

  useEffect(() => {
    loadPatients();
    // refreshSignal isn't read by loadPatients -- it's purely a trigger so
    // a parent (e.g. after a successful upload) can force a reload.
  }, [loadPatients, refreshSignal]);

  // Enters edit mode for one row, seeding the draft from its current values.
  function handleEditClick(patient: PatientRead) {
    setEditingId(patient.id);
    setEditDraft({
      first_name: patient.first_name,
      last_name: patient.last_name,
      date_of_birth: patient.date_of_birth,
      gender: patient.gender,
    });
    setEditSnapshot(patient);
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[patient.id];
      return next;
    });
  }

  // Discards the draft and exits edit mode without saving.
  function handleCancel() {
    setEditingId(null);
    setEditDraft(null);
    setEditSnapshot(null);
  }

  function handleFieldChange(field: keyof EditDraft, value: string) {
    setEditDraft((prev) => prev && { ...prev, [field]: value });
  }

  // Validates, optimistically applies the edit, then PATCHes it -- rolling
  // back to the pre-edit snapshot if the request fails.
  async function handleSave(patient: PatientRead) {
    if (!editDraft || !editSnapshot) return;
    if (Object.keys(validateDraft(editDraft)).length > 0) return;

    const snapshot = editSnapshot;
    const optimistic: PatientRead = { ...patient, ...editDraft };

    setPatients((prev) => prev?.map((p) => (p.id === patient.id ? optimistic : p)) ?? prev);
    setEditingId(null);
    setEditDraft(null);
    setEditSnapshot(null);
    setSavingId(patient.id);

    // Only send fields that actually changed.
    const changes: PatientUpdate = {};
    if (editDraft.first_name !== snapshot.first_name) changes.first_name = editDraft.first_name;
    if (editDraft.last_name !== snapshot.last_name) changes.last_name = editDraft.last_name;
    if (editDraft.date_of_birth !== snapshot.date_of_birth) changes.date_of_birth = editDraft.date_of_birth;
    if (editDraft.gender !== snapshot.gender) changes.gender = editDraft.gender as Gender;

    try {
      const updated = await apiPatchPatient(patient.id, changes);
      setPatients((prev) => prev?.map((p) => (p.id === patient.id ? updated : p)) ?? prev);
      setRowErrors((prev) => {
        const next = { ...prev };
        delete next[patient.id];
        return next;
      });
    } catch (err) {
      // Roll back to the pre-edit snapshot -- the optimistic update above
      // didn't hold, but the rest of the table stays exactly as it was.
      setPatients((prev) => prev?.map((p) => (p.id === patient.id ? snapshot : p)) ?? prev);
      const message =
        err instanceof ApiError && err.status === 404
          ? "This patient no longer exists. Refresh to update the list."
          : "Could not save changes. Please try again.";
      setRowErrors((prev) => ({ ...prev, [patient.id]: message }));
    } finally {
      setSavingId(null);
    }
  }

  // Column definitions -- each one either shows a plain value or, while
  // its row is being edited, swaps to an input/select bound through meta.
  const columns = useMemo(() => {
    // TanStack Table's own column-def types don't unify cleanly across
    // columns with different accessor value types in one array literal --
    // `any` here is the pattern their docs use for a heterogeneous column
    // list; each column's own accessor/cell stays fully typed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: ColumnDef<PatientRead, any>[] = [
      columnHelper.accessor("patient_code", {
        header: "Patient ID",
        cell: (info) => <span className="font-mono">{info.getValue()}</span>,
      }),
      columnHelper.accessor("first_name", {
        header: "First Name",
        cell: (info) => {
          const patient = info.row.original;
          const meta = info.table.options.meta!;
          if (meta.editingId === patient.id && meta.editDraft) {
            return (
              <input
                value={meta.editDraft.first_name}
                onChange={(event) => meta.onFieldChange("first_name", event.target.value)}
                className={inputClass()}
              />
            );
          }
          return info.getValue();
        },
      }),
      columnHelper.accessor("last_name", {
        header: "Last Name",
        cell: (info) => {
          const patient = info.row.original;
          const meta = info.table.options.meta!;
          if (meta.editingId === patient.id && meta.editDraft) {
            return (
              <input
                value={meta.editDraft.last_name}
                onChange={(event) => meta.onFieldChange("last_name", event.target.value)}
                className={inputClass()}
              />
            );
          }
          return info.getValue();
        },
      }),
      columnHelper.accessor("date_of_birth", {
        header: "Date of Birth",
        cell: (info) => {
          const patient = info.row.original;
          const meta = info.table.options.meta!;
          if (meta.editingId === patient.id && meta.editDraft) {
            const draft = meta.editDraft;
            const errors = validateDraft(draft);
            return (
              <div>
                <DatePickerField
                  value={draft.date_of_birth}
                  onChange={(value) => meta.onFieldChange("date_of_birth", value)}
                  hasError={!!errors.date_of_birth}
                />
                {errors.date_of_birth && <p className="mt-1 text-xs text-danger">{errors.date_of_birth}</p>}
              </div>
            );
          }
          return formatDateDisplay(info.getValue());
        },
      }),
      columnHelper.accessor("gender", {
        header: "Gender",
        enableSorting: false, // not a meaningful sort key
        cell: (info) => {
          const patient = info.row.original;
          const meta = info.table.options.meta!;
          if (meta.editingId === patient.id && meta.editDraft) {
            const draft = meta.editDraft;
            const errors = validateDraft(draft);
            return (
              <div>
                <select
                  value={draft.gender}
                  onChange={(event) => meta.onFieldChange("gender", event.target.value)}
                  className={inputClass(!!errors.gender)}
                >
                  {GENDERS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                {errors.gender && <p className="mt-1 text-xs text-danger">{errors.gender}</p>}
              </div>
            );
          }
          return info.getValue();
        },
      }),
    ];

    // Actions column (Edit/Save/Cancel) only exists for editors.
    if (canEdit) {
      base.push(
        columnHelper.display({
          id: "actions",
          header: "Actions",
          cell: (info) => {
            const patient = info.row.original;
            const meta = info.table.options.meta!;
            const isSaving = meta.savingId === patient.id;

            if (meta.editingId === patient.id) {
              const errors = meta.editDraft ? validateDraft(meta.editDraft) : {};
              return (
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="xs" onClick={meta.onCancel} disabled={isSaving}>
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    onClick={() => meta.onSave(patient)}
                    disabled={isSaving || Object.keys(errors).length > 0}
                  >
                    {isSaving ? "Saving..." : "Save"}
                  </Button>
                </div>
              );
            }

            return (
              <Button
                variant="accent-outline"
                size="xs"
                onClick={() => meta.onEditClick(patient)}
                disabled={meta.editingId !== null} // only one row editable at a time
              >
                Edit
              </Button>
            );
          },
        }),
      );
    }

    return base;
    // Deliberately just [canEdit] -- editingId/editDraft/savingId are read
    // fresh each render via table.options.meta (see the TableMeta module
    // augmentation above) instead of being closed over here, so columns
    // (and its cell render functions) stay referentially stable while the
    // user types. TanStack's flexRender treats a column's `cell` as a
    // component type, not a plain function, so a new function reference
    // every keystroke would make React remount the cell's DOM -- e.g.
    // dropping input focus mid-edit.
  }, [canEdit]);

  function toggleGenderOption(option: string) {
    setGenderFilter((prev) =>
      prev.includes(option) ? prev.filter((value) => value !== option) : [...prev, option],
    );
  }

  // Select-all / clear-all for the Gender checklist.
  function toggleGenderAll() {
    setGenderFilter((prev) => (prev.length === GENDERS.length ? [] : [...GENDERS]));
  }

  // Maps each column id to its filter's config -- read by the header row
  // to decide which trigger/popover to render.
  const columnFilters: Record<string, ColumnFilterConfig> = {
    patient_code: { kind: "text", label: "Patient ID", value: patientCodeInput, onChange: setPatientCodeInput },
    first_name: { kind: "text", label: "First Name", value: firstNameInput, onChange: setFirstNameInput },
    last_name: { kind: "text", label: "Last Name", value: lastNameInput, onChange: setLastNameInput },
    gender: {
      kind: "checklist",
      label: "Gender",
      options: GENDERS,
      selected: genderFilter,
      onToggleOption: toggleGenderOption,
      onToggleAll: toggleGenderAll,
    },
    date_of_birth: { kind: "date-range", from: dobFrom, to: dobTo },
  };

  const table = useReactTable({
    data: patients ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    manualSorting: true, // sorting happens server-side via sortBy/sortDir above
    enableMultiSort: false,
    enableSortingRemoval: true, // clicking a sorted column a third time clears the sort
    getCoreRowModel: getCoreRowModel(),
    meta: {
      editingId,
      editDraft,
      savingId,
      onFieldChange: handleFieldChange,
      onEditClick: handleEditClick,
      onCancel: handleCancel,
      onSave: handleSave,
    },
  });

  // "X–Y of Z" pagination label inputs.
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const columnCount = table.getVisibleLeafColumns().length; // for colSpan on empty/error rows

  const activeColumnFilter = openFilterColumn ? columnFilters[openFilterColumn] : undefined;

  return (
    <>
    <div className="animate-rise-in overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40">
      <div className="border-b border-border px-6 py-5 sm:px-8">
        <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-teal uppercase">Patients</p>
        <h2 className="font-serif text-lg font-semibold text-foreground">Patient records</h2>
      </div>

      {patients === null && !loadError && <PulseDot />}

      {loadError && (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <p className="text-sm text-muted">Couldn&apos;t load patients.</p>
          <Button variant="secondary" onClick={loadPatients}>
            Retry
          </Button>
        </div>
      )}

      {patients !== null && !loadError && (
        <div className="overflow-x-auto overflow-y-hidden">
          <table className="w-full min-w-215 table-fixed text-left text-sm">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-border text-xs uppercase tracking-wide text-muted">
                  {headerGroup.headers.map((header, index) => {
                    const columnFilter = columnFilters[header.column.id];
                    const isLast = index === headerGroup.headers.length - 1;
                    return (
                      <th
                        key={header.id}
                        className={`relative px-4 py-3 align-top font-mono font-medium sm:px-6 ${COLUMN_WIDTHS[header.column.id] ?? ""}`}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          {header.column.getCanSort() ? (
                            <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className="flex items-center gap-1 transition-colors hover:text-foreground"
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              {sortIndicator(header.column.getIsSorted())}
                            </button>
                          ) : (
                            flexRender(header.column.columnDef.header, header.getContext())
                          )}
                          {/* Date of birth renders its own trigger+panel (needs Cancel/Apply) */}
                          {columnFilter?.kind === "date-range" && (
                            <DobRangeFilter
                              from={columnFilter.from}
                              to={columnFilter.to}
                              onApply={({ from, to }) => {
                                setDobFrom(from);
                                setDobTo(to);
                              }}
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
              {patients.length === 0 && (
                <tr>
                  <td colSpan={columnCount} className="py-16 text-center text-sm text-muted">
                    No patients found.
                  </td>
                </tr>
              )}
              {table.getRowModel().rows.map((row, index) => {
                const patient = row.original;
                const isEditing = editingId === patient.id;
                const error = rowErrors[patient.id];
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={`border-b border-border last:border-b-0 ${
                        isEditing
                          ? "border-l-2 border-l-accent bg-accent/5"
                          : "animate-rise-in hover:bg-surface-hover"
                      }`}
                      style={isEditing ? undefined : { animationDelay: `${Math.min(index * 0.04, 0.3)}s` }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id} className="px-4 py-3 align-top text-foreground sm:px-6">
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                    {/* Per-row save-error banner, spanning the full row */}
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
            onChange={(event) => setPageSize(Number(event.target.value))}
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
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page <= 1}
            >
              Prev
            </Button>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => setPage((prev) => prev + 1)}
              disabled={page * pageSize >= total}
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
