"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";

import Button from "@/components/Button";
import DatePickerField from "@/components/DatePickerField";
import DobRangeFilter from "@/components/DobRangeFilter";
import { apiGetPatients, apiPatchPatient, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateDisplay } from "@/lib/date";
import type { Gender, PatientRead, PatientUpdate } from "@/lib/types";

interface PatientTableProps {
  // Bumped by the parent (e.g. after a successful upload) to trigger a
  // reload without this component needing an imperative ref API.
  refreshSignal?: number;
}

interface EditDraft {
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
}

type ColumnFilterConfig =
  | { kind: "text"; label: string; value: string; onChange: (value: string) => void }
  | {
      kind: "checklist";
      label: string;
      options: string[];
      selected: string[];
      onToggleOption: (option: string) => void;
      onToggleAll: () => void;
    }
  // date-range doesn't route through the generic SearchIcon-triggered
  // popover below -- DobRangeFilter renders its own trigger and portaled
  // panel (it needs Cancel/Apply, unlike the other filters' apply-as-you-
  // type behavior), so this variant is only used for isColumnFilterActive.
  | { kind: "date-range"; from: string | null; to: string | null };

// Editable-cell state passed through table.options.meta rather than closed
// over directly in column defs. TanStack's flexRender renders a column's
// `cell` as a component type, so column defs need to stay referentially
// stable (see the `columns` useMemo below) -- meta is how those otherwise-
// static cell renderers still read current, per-keystroke edit state.
declare module "@tanstack/react-table" {
  interface TableMeta<TData> {
    editingId: string | null;
    editDraft: EditDraft | null;
    savingId: string | null;
    onFieldChange: (field: keyof EditDraft, value: string) => void;
    onEditClick: (patient: TData) => void;
    onCancel: () => void;
    onSave: (patient: TData) => void;
  }
}

const GENDERS: Gender[] = ["Male", "Female", "Other", "Prefer not to say"];
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
// Approximate rendered height of the filter popover panel, used to decide
// whether it should open below or above its trigger button.
const FILTER_PANEL_HEIGHT_ESTIMATE = 56;
// Taller estimate for a checklist filter's panel (one row per option, plus
// the "Select All" row).
const CHECKLIST_FILTER_PANEL_HEIGHT_ESTIMATE = 180;
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

function PulseDot() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
    </div>
  );
}

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

function sortIndicator(direction: false | "asc" | "desc") {
  if (!direction) return null;
  return <span className="ml-1">{direction === "asc" ? "↑" : "↓"}</span>;
}

function SearchIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16.5 16.5 13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ChecklistFilterIcon() {
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
  indeterminate,
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

const columnHelper = createColumnHelper<PatientRead>();

export default function PatientTable({ refreshSignal }: PatientTableProps) {
  const { currentUser } = useAuth();
  const permissionCodes = currentUser?.role.permissions.map((p) => p.code) ?? [];
  const canEdit = permissionCodes.includes("patient.edit");

  const [patients, setPatients] = useState<PatientRead[] | null>(null);
  const [total, setTotal] = useState(0);
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
  // Which column's filter popover is currently open -- closing it hides the
  // popover but doesn't clear its value, so the filter stays applied. The
  // anchor rect is the trigger button's position, used to place the
  // portaled popover so it floats over the table instead of pushing rows
  // down.
  const [openFilterColumn, setOpenFilterColumn] = useState<string | null>(null);
  const [filterAnchorRect, setFilterAnchorRect] = useState<DOMRect | null>(null);
  const filterButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const filterPanelRef = useRef<HTMLDivElement | null>(null);
  const [sorting, setSorting] = useState<SortingState>([{ id: "patient_code", desc: false }]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editSnapshot, setEditSnapshot] = useState<PatientRead | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

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

  const sortBy = (sorting[0]?.id ?? "patient_code") as
    | "patient_code"
    | "first_name"
    | "last_name"
    | "date_of_birth";
  const sortDir = sorting[0]?.desc ? "desc" : "asc";

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

  // Close the floating filter popover on an outside click, Escape, or any
  // scroll/resize (its position is only computed once, on open, so it'd
  // otherwise drift out of place instead of tracking the trigger button).
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

  function handleCancel() {
    setEditingId(null);
    setEditDraft(null);
    setEditSnapshot(null);
  }

  function handleFieldChange(field: keyof EditDraft, value: string) {
    setEditDraft((prev) => prev && { ...prev, [field]: value });
  }

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
        enableSorting: false,
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
                disabled={meta.editingId !== null}
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

  function toggleGenderAll() {
    setGenderFilter((prev) => (prev.length === GENDERS.length ? [] : [...GENDERS]));
  }

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
  const isColumnFilterActive = (config: ColumnFilterConfig) => {
    if (config.kind === "checklist") return config.selected.length < config.options.length;
    if (config.kind === "date-range") return Boolean(config.from || config.to);
    return Boolean(config.value);
  };

  const table = useReactTable({
    data: patients ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    manualSorting: true,
    enableMultiSort: false,
    enableSortingRemoval: true,
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

  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const columnCount = table.getVisibleLeafColumns().length;

  const activeColumnFilter = openFilterColumn ? columnFilters[openFilterColumn] : undefined;
  const activeFilterPanelHeightEstimate =
    activeColumnFilter?.kind === "checklist" ? CHECKLIST_FILTER_PANEL_HEIGHT_ESTIMATE : FILTER_PANEL_HEIGHT_ESTIMATE;

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
                          {columnFilter && columnFilter.kind !== "date-range" && (
                            <button
                              type="button"
                              ref={(el) => {
                                if (el) filterButtonRefs.current.set(header.column.id, el);
                                else filterButtonRefs.current.delete(header.column.id);
                              }}
                              onClick={() => toggleFilterOpen(header.column.id)}
                              aria-label={`Filter by ${columnFilter.label}`}
                              aria-expanded={openFilterColumn === header.column.id}
                              className={`transition-colors hover:text-foreground ${
                                isColumnFilterActive(columnFilter) ? "text-accent" : ""
                              }`}
                            >
                              {columnFilter.kind === "checklist" ? <ChecklistFilterIcon /> : <SearchIcon />}
                            </button>
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
    {activeColumnFilter &&
      filterAnchorRect &&
      createPortal(
        <div
          ref={filterPanelRef}
          style={{
            position: "fixed",
            // Flip above the trigger when there's no room below -- e.g. a
            // header row scrolled near the bottom of the viewport.
            top:
              filterAnchorRect.bottom + 6 + activeFilterPanelHeightEstimate > window.innerHeight
                ? Math.max(8, filterAnchorRect.top - activeFilterPanelHeightEstimate - 6)
                : filterAnchorRect.bottom + 6,
            left: Math.min(filterAnchorRect.left, window.innerWidth - 232),
          }}
          className="animate-panel-in z-50 w-56 rounded-lg border border-border bg-surface p-1.5 shadow-2xl shadow-black/40"
        >
          {activeColumnFilter.kind === "checklist" ? (
            <div className="max-h-72 overflow-y-auto">
              <ChecklistOption
                label="(Select All)"
                checked={activeColumnFilter.selected.length === activeColumnFilter.options.length}
                indeterminate={
                  activeColumnFilter.selected.length > 0 &&
                  activeColumnFilter.selected.length < activeColumnFilter.options.length
                }
                onChange={activeColumnFilter.onToggleAll}
              />
              {activeColumnFilter.options.map((option) => (
                <ChecklistOption
                  key={option}
                  label={option}
                  checked={activeColumnFilter.selected.includes(option)}
                  onChange={() => activeColumnFilter.onToggleOption(option)}
                />
              ))}
            </div>
          ) : activeColumnFilter.kind === "text" ? (
            <div className="relative">
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted">
                <SearchIcon />
              </span>
              <input
                type="text"
                autoFocus
                value={activeColumnFilter.value}
                onChange={(event) => activeColumnFilter.onChange(event.target.value)}
                placeholder="Filter..."
                className="block w-full rounded-md border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
          ) : null}
        </div>,
        document.body,
      )}
    </>
  );
}
