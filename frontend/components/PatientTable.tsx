"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createColumnHelper, type ColumnDef, type SortingState } from "@tanstack/react-table";

import { type ColumnFilterConfig } from "@/components/ColumnFilters";
import DatePickerField from "@/components/DatePickerField";
import {
  CellActions,
  CellFieldError,
  checklistFilter,
  dateRangeFilter,
  DataTableCard,
  InlineEditActionsCell,
  MonoCell,
  tableInputClass,
  textFilter,
  useDataTable,
  useDebouncedFilters,
  useInlineRowEdit,
  useTablePagination,
} from "@/components/table-primitives";
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
  // The index signature is what lets this satisfy useInlineRowEdit's
  // InlineEditDraft constraint -- every inline-edit draft is a flat bag of
  // strings, so the shared hook works with any of them opaquely. The named
  // properties below still get their own typo/completeness checking.
  [key: string]: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  gender: string;
}

const GENDERS: Gender[] = ["Male", "Female", "Other", "Prefer not to say"];
// Mirrors backend/app/services/patient_import.py's MAX_AGE_YEARS -- also
// enforced server-side by PatientUpdate's date_of_birth validator.
const MAX_AGE_YEARS = 130;
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

// Mirrors the DOB/Gender rules from backend/app/services/patient_import.py
// (reused server-side by PatientUpdate in schemas.py) -- this is in
// addition to, not instead of, that server-side validation.
function validateDraft(draft: EditDraft): { date_of_birth?: string; gender?: string } {
  const errors: { date_of_birth?: string; gender?: string } = {};

  if (!GENDERS.includes(draft.gender as Gender)) {
    errors.gender = "Must be one of the listed options.";
  }

  const parsed = new Date(draft.date_of_birth);
  const earliest = new Date();
  earliest.setFullYear(earliest.getFullYear() - MAX_AGE_YEARS);
  if (!draft.date_of_birth || Number.isNaN(parsed.getTime())) {
    errors.date_of_birth = "Must be a valid date.";
  } else if (parsed.getTime() > Date.now()) {
    errors.date_of_birth = "Cannot be in the future.";
  } else if (parsed.getTime() < earliest.getTime()) {
    // DatePickerField's own calendar already caps how far back its month
    // picker scrolls to the same bound, so this shouldn't be reachable
    // through the UI -- kept as a backstop so a stale/out-of-range draft
    // can never look valid client-side while the server would still
    // reject it.
    errors.date_of_birth = `Cannot be more than ${MAX_AGE_YEARS} years in the past.`;
  }

  return errors;
}

const columnHelper = createColumnHelper<PatientRead>();

// Patient records table: server-driven sort/filter/pagination, plus inline
// row editing (click Edit, fields become inputs, Save/Cancel). Self-
// contained -- owns its own fetch, loading/error state, and permission
// checks; the shared shell/table chrome comes from DataTableCard.
export default function PatientTable({ refreshSignal }: PatientTableProps) {
  const { currentUser } = useAuth();
  const canEdit = hasPermission(currentUser, "patient.edit"); // gates the Actions column entirely

  const [patients, setPatients] = useState<PatientRead[] | null>(null); // null until the first load resolves
  const [total, setTotal] = useState(0); // total matching rows across all pages
  const [loadError, setLoadError] = useState(false);
  const [isFetching, setIsFetching] = useState(false); // true while a sort/filter/page reload is in flight

  // Per-keystroke values for each text column's filter input; the debounced
  // copy below is what actually gets queried.
  const [patientCodeInput, setPatientCodeInput] = useState("");
  const [firstNameInput, setFirstNameInput] = useState("");
  const [lastNameInput, setLastNameInput] = useState("");
  const {
    patient_code: patientCodeFilter,
    first_name: firstNameFilter,
    last_name: lastNameFilter,
  } = useDebouncedFilters({
    patient_code: patientCodeInput,
    first_name: firstNameInput,
    last_name: lastNameInput,
  });
  // Gender is a closed set (GENDERS above), filtered via a checklist rather
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
  const [sorting, setSorting] = useState<SortingState>([{ id: "patient_code", desc: false }]); // tanstack's single-column sort state
  // 1-indexed page + page size; any change to the filters or sort below
  // sends it back to page 1.
  const { page, setPage, pageSize, setPageSize } = useTablePagination(25, [
    patientCodeFilter,
    firstNameFilter,
    lastNameFilter,
    genderFilter,
    dobFrom,
    dobTo,
    sorting,
  ]);

  // Inline-edit lifecycle (edit/save/rollback, one row at a time) -- shared
  // with UserManagementTable via useInlineRowEdit; only the draft shape,
  // field-level validation, and column defs below are this table's own.
  const inlineEdit = useInlineRowEdit<PatientRead, EditDraft>({
    setRows: setPatients,
    toRow: (patient, draft) => ({ ...patient, ...draft }),
    changedFields: (draft, patient) => {
      const fields: string[] = [];
      if (draft.first_name !== patient.first_name) fields.push("first_name");
      if (draft.last_name !== patient.last_name) fields.push("last_name");
      if (draft.date_of_birth !== patient.date_of_birth) fields.push("date_of_birth");
      if (draft.gender !== patient.gender) fields.push("gender");
      return fields;
    },
    request: (id, draft, fields) => {
      // Only sends fields that actually changed.
      const changes: PatientUpdate = {};
      if (fields.includes("first_name")) changes.first_name = draft.first_name;
      if (fields.includes("last_name")) changes.last_name = draft.last_name;
      if (fields.includes("date_of_birth")) changes.date_of_birth = draft.date_of_birth;
      if (fields.includes("gender")) changes.gender = draft.gender as Gender;
      return apiPatchPatient(id, changes);
    },
    errorMessage: (err) =>
      err instanceof ApiError && err.status === 404
        ? "This patient no longer exists. Refresh to update the list."
        : "Could not save changes. Please try again.",
  });

  // Enters edit mode for one row, seeding the draft from its current values.
  function handleEditClick(patient: PatientRead) {
    inlineEdit.onEditClick(patient, {
      first_name: patient.first_name,
      last_name: patient.last_name,
      date_of_birth: patient.date_of_birth,
      gender: patient.gender,
    });
  }

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

    setIsFetching(true);
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
    } finally {
      setIsFetching(false);
    }
  }, [patientCodeFilter, firstNameFilter, lastNameFilter, genderFilter, dobFrom, dobTo, sortBy, sortDir, page, pageSize]);

  useEffect(() => {
    (async () => {
      await loadPatients();
    })();
    // refreshSignal isn't read by loadPatients -- it's purely a trigger so
    // a parent (e.g. after a successful upload) can force a reload.
  }, [loadPatients, refreshSignal]);

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
        cell: (info) => <MonoCell>{info.getValue()}</MonoCell>,
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
                className={tableInputClass()}
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
                className={tableInputClass()}
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
            // meta.editDraft is typed loosely (InlineEditDraft, shared
            // across every table via useInlineRowEdit) -- this table always
            // constructs it as an EditDraft (see handleEditClick below).
            const draft = meta.editDraft as EditDraft;
            const errors = validateDraft(draft);
            return (
              <div>
                <DatePickerField
                  value={draft.date_of_birth}
                  onChange={(value) => meta.onFieldChange("date_of_birth", value)}
                  hasError={!!errors.date_of_birth}
                />
                {errors.date_of_birth && <CellFieldError>{errors.date_of_birth}</CellFieldError>}
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
            const draft = meta.editDraft as EditDraft;
            const errors = validateDraft(draft);
            return (
              <div>
                <select
                  value={draft.gender}
                  onChange={(event) => meta.onFieldChange("gender", event.target.value)}
                  className={tableInputClass(!!errors.gender)}
                >
                  {GENDERS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                {errors.gender && <CellFieldError>{errors.gender}</CellFieldError>}
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
            const errors =
              meta.editingId === patient.id && meta.editDraft
                ? validateDraft(meta.editDraft as EditDraft)
                : {};
            return (
              <CellActions>
                <InlineEditActionsCell
                  row={patient}
                  editingId={meta.editingId}
                  savingId={meta.savingId}
                  hasErrors={Object.keys(errors).length > 0}
                  onEditClick={meta.onEditClick}
                  onCancel={meta.onCancel}
                  onSave={meta.onSave}
                />
              </CellActions>
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

  // Maps each column id to its filter's config -- read by the header row
  // to decide which trigger/popover to render.
  const columnFilters: Record<string, ColumnFilterConfig> = {
    patient_code: textFilter("Patient ID", patientCodeInput, setPatientCodeInput),
    first_name: textFilter("First Name", firstNameInput, setFirstNameInput),
    last_name: textFilter("Last Name", lastNameInput, setLastNameInput),
    gender: checklistFilter("Gender", GENDERS, genderFilter, setGenderFilter),
    date_of_birth: dateRangeFilter(dobFrom, dobTo, ({ from, to }) => {
      setDobFrom(from);
      setDobTo(to);
    }),
  };

  const table = useDataTable({
    data: patients ?? [],
    columns,
    sorting,
    onSortingChange: setSorting,
    meta: {
      editingId: inlineEdit.editingId,
      editDraft: inlineEdit.editDraft,
      savingId: inlineEdit.savingId,
      onFieldChange: inlineEdit.onFieldChange,
      onEditClick: handleEditClick,
      onCancel: inlineEdit.onCancel,
      onSave: inlineEdit.onSave,
    },
  });

  return (
    <DataTableCard
      eyebrow="Patients"
      title="Patient records"
      table={table}
      rows={patients}
      isFetching={isFetching}
      loadError={loadError}
      onRetry={loadPatients}
      errorMessage="Couldn't load patients."
      emptyMessage="No patients found."
      columnWidths={COLUMN_WIDTHS}
      columnFilters={columnFilters}
      editingRowId={inlineEdit.editingId}
      savingRowId={inlineEdit.savingId}
      flashedRow={inlineEdit.flashedRow}
      rowError={(patient) => inlineEdit.rowErrors[patient.id]}
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
    />
  );
}
