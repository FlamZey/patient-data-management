"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createColumnHelper, type ColumnDef, type SortingState } from "@tanstack/react-table";

import { type ColumnFilterConfig } from "@/components/ColumnFilters";
import DatePickerField from "@/components/DatePickerField";
import PatientUploadCard from "@/components/PatientUploadCard";
import {
  CellActions,
  CellFieldError,
  checklistFilter,
  dateRangeFilter,
  DataTableCard,
  DEBOUNCE_DELAY_MS,
  InlineEditActionsCell,
  MonoCell,
  tableInputClass,
  TextCell,
  textFilter,
  useDataTable,
  useDebouncedFilters,
  useInlineRowEdit,
  useTablePagination,
} from "@/components/table-primitives";
import { apiGetPatients, apiPatchPatient, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { formatDateDisplay } from "@/lib/date";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import type { Gender, PatientRead, PatientUpdate } from "@/lib/types";

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
  patient_code: "w-40",
  first_name: "w-40",
  last_name: "w-40",
  date_of_birth: "w-40",
  gender: "w-44",
  actions: "w-40",
};

// A closed set, so each value gets a fixed color -- the same pattern
// StatusBadge uses for account status.
const GENDER_BADGE_STYLES: Record<Gender, string> = {
  Male: "bg-accent/15 text-accent border-accent/30",
  Female: "bg-teal/15 text-teal border-teal/30",
  Other: "bg-muted/15 text-muted border-muted/30",
  "Prefer not to say": "bg-muted/15 text-muted border-muted/30",
};

function GenderBadge({ value }: { value: string }) {
  const style = GENDER_BADGE_STYLES[value as Gender] ?? "bg-muted/15 text-muted border-muted/30";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {value}
    </span>
  );
}

// Mirrors backend/app/services/patient_import.py's Literal enums for the
// optional PHI fields -- kept in sync by hand, same convention as GENDERS
// and PatientUploadCard's TEMPLATE_COLUMNS.
const RELATIONSHIPS = [
  "Spouse", "Parent", "Sibling", "Child", "Friend", "Partner",
  "Grandparent", "Grandchild", "Caregiver", "Other Relative",
] as const;
const RACE_ETHNICITIES = [
  "White", "Black or African American", "Asian", "Hispanic or Latino",
  "American Indian or Alaska Native", "Native Hawaiian or Other Pacific Islander",
  "Middle Eastern or North African", "Two or More Races", "Prefer not to say",
] as const;
const MARITAL_STATUSES = ["Single", "Married", "Divorced", "Widowed", "Separated", "Domestic Partnership"] as const;
const CARE_DEPARTMENTS = [
  "Primary Care", "Pediatrics", "Cardiology", "Endocrinology", "Pulmonology",
  "Orthopedics", "Psychiatry", "Nephrology", "General Medicine",
] as const;
const BLOOD_TYPES = ["O+", "A+", "B+", "AB+", "O-", "A-", "B-", "AB-"] as const;
const SMOKING_STATUSES = [
  "Never smoker", "Former smoker", "Current every day smoker", "Current some day smoker",
  "Light tobacco smoker", "Heavy tobacco smoker", "Smoker, current status unknown", "Unknown if ever smoked",
] as const;
const ALCOHOL_USE = ["Never", "Rarely", "Occasional", "Moderate", "Heavy", "In recovery"] as const;

type OptionalFieldKind = "text" | "email" | "int" | "date" | "multi" | "enum";

// Every PatientRead key except the always-editable-elsewhere required
// fields and the server-owned ones -- the 27 optional PHI fields the detail
// panel below makes editable.
type OptionalFieldKey = Exclude<
  keyof PatientRead,
  | "id"
  | "patient_code"
  | "first_name"
  | "last_name"
  | "date_of_birth"
  | "gender"
  | "uploaded_by"
  | "created_at"
  | "updated_at"
>;

interface OptionalFieldConfig {
  key: OptionalFieldKey;
  label: string;
  kind: OptionalFieldKind;
  options?: readonly string[]; // enum kind only
}

interface OptionalFieldGroup {
  label: string;
  fields: OptionalFieldConfig[];
}

// The optional fields' editable form, grouped the same way buildDetailGroups
// displays them read-only below -- unlike that function, every field appears
// here regardless of whether it's currently populated, since editing is how
// a blank one gets filled in.
const OPTIONAL_FIELD_GROUPS: OptionalFieldGroup[] = [
  {
    label: "Address",
    fields: [
      { key: "street_address", label: "Street Address", kind: "text" },
      { key: "city", label: "City", kind: "text" },
      { key: "state", label: "State", kind: "text" },
      { key: "zip_code", label: "Zip", kind: "text" },
    ],
  },
  {
    label: "Contact",
    fields: [
      { key: "phone", label: "Phone", kind: "text" },
      { key: "email", label: "Email", kind: "email" },
      { key: "emergency_contact_name", label: "Emergency Contact", kind: "text" },
      { key: "emergency_contact_relationship", label: "Relationship", kind: "enum", options: RELATIONSHIPS },
      { key: "emergency_contact_phone", label: "Emergency Phone", kind: "text" },
    ],
  },
  {
    label: "Demographics",
    fields: [
      { key: "preferred_language", label: "Preferred Language", kind: "text" },
      { key: "race_ethnicity", label: "Race/Ethnicity", kind: "enum", options: RACE_ETHNICITIES },
      { key: "marital_status", label: "Marital Status", kind: "enum", options: MARITAL_STATUSES },
      { key: "occupation", label: "Occupation", kind: "text" },
    ],
  },
  {
    label: "Insurance & Care",
    fields: [
      { key: "insurance_provider", label: "Insurance Provider", kind: "text" },
      { key: "policy_number", label: "Policy Number", kind: "text" },
      { key: "pcp_name", label: "PCP", kind: "text" },
      { key: "care_department", label: "Care Department", kind: "enum", options: CARE_DEPARTMENTS },
      { key: "registration_date", label: "Registration Date", kind: "date" },
      { key: "last_visit_date", label: "Last Visit Date", kind: "date" },
      { key: "preferred_pharmacy", label: "Preferred Pharmacy", kind: "text" },
    ],
  },
  {
    label: "Clinical",
    fields: [
      { key: "blood_type", label: "Blood Type", kind: "enum", options: BLOOD_TYPES },
      { key: "height_in", label: "Height (in)", kind: "int" },
      { key: "weight_lbs", label: "Weight (lbs)", kind: "int" },
      { key: "systolic_bp", label: "Systolic BP", kind: "int" },
      { key: "diastolic_bp", label: "Diastolic BP", kind: "int" },
      { key: "smoking_status", label: "Smoking Status", kind: "enum", options: SMOKING_STATUSES },
      { key: "alcohol_use", label: "Alcohol Use", kind: "enum", options: ALCOHOL_USE },
      { key: "allergies", label: "Allergies", kind: "multi" },
      { key: "current_medications", label: "Current Medications", kind: "multi" },
      { key: "chronic_conditions", label: "Chronic Conditions", kind: "multi" },
      { key: "immunization_history", label: "Immunization History", kind: "multi" },
    ],
  },
];

const ALL_OPTIONAL_FIELDS = OPTIONAL_FIELD_GROUPS.flatMap((group) => group.fields);

const TODAY_ISO = new Date().toISOString().slice(0, 10);

// Converts a patient's stored value for one optional field into the plain
// string an <input>/<select> binds to (InlineEditDraft is always
// Record<string, string> -- see table-primitives.tsx). null/undefined
// becomes "" (an empty, editable field); a multi-value field joins as a
// comma-separated list.
function serializeOptionalField(kind: OptionalFieldKind, value: string | number | string[] | null): string {
  if (kind === "multi") return ((value as string[] | null) ?? []).join(", ");
  return value == null ? "" : String(value);
}

// The inverse of serializeOptionalField, applied to what the user typed --
// blank means "clear this field" (sent as null) for every kind except multi,
// where it means "no items". An unparseable int becomes null too, same as
// leaving it blank, rather than sending text the backend would 422 on.
function parseOptionalField(kind: OptionalFieldKind, raw: string): string | number | string[] | null {
  if (kind === "multi") {
    const items = raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : null;
  }
  if (raw.trim() === "") return null;
  if (kind === "int") {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return raw;
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

// One optional field's label + already-formatted display value, or null if
// the patient has no value for it (filtered out before rendering -- most
// patients will have most of these 27 fields empty, so only showing what's
// actually on file is what keeps the detail panel small). A string[] value
// (allergies, medications, etc.) renders as wrapping pills instead of one
// long comma-joined line, which is what was cramping the Clinical card.
interface DetailField {
  label: string;
  value: string | string[] | null;
}

interface DetailGroup {
  label: string;
  fields: DetailField[];
}

function hasDetailValue(value: DetailField["value"]): boolean {
  return Array.isArray(value) ? value.length > 0 : value != null && value !== "";
}

// Groups the 27 optional fields the same way backend/app/schemas.py orders
// them, into the sections the expanded row displays. A group renders only
// if it has at least one populated field.
function buildDetailGroups(patient: PatientRead): DetailGroup[] {
  const groups: DetailGroup[] = [
    {
      label: "Address",
      fields: [
        { label: "Street Address", value: patient.street_address },
        { label: "City", value: patient.city },
        { label: "State", value: patient.state },
        { label: "Zip", value: patient.zip_code },
      ],
    },
    {
      label: "Contact",
      fields: [
        { label: "Phone", value: patient.phone },
        { label: "Email", value: patient.email },
        { label: "Emergency Contact", value: patient.emergency_contact_name },
        { label: "Relationship", value: patient.emergency_contact_relationship },
        { label: "Emergency Phone", value: patient.emergency_contact_phone },
      ],
    },
    {
      label: "Demographics",
      fields: [
        { label: "Preferred Language", value: patient.preferred_language },
        { label: "Race/Ethnicity", value: patient.race_ethnicity },
        { label: "Marital Status", value: patient.marital_status },
        { label: "Occupation", value: patient.occupation },
      ],
    },
    {
      label: "Insurance & Care",
      fields: [
        { label: "Insurance Provider", value: patient.insurance_provider },
        { label: "Policy Number", value: patient.policy_number },
        { label: "PCP", value: patient.pcp_name },
        { label: "Care Department", value: patient.care_department },
        {
          label: "Registration Date",
          value: patient.registration_date ? formatDateDisplay(patient.registration_date) : null,
        },
        {
          label: "Last Visit Date",
          value: patient.last_visit_date ? formatDateDisplay(patient.last_visit_date) : null,
        },
        { label: "Preferred Pharmacy", value: patient.preferred_pharmacy },
      ],
    },
    {
      label: "Clinical",
      fields: [
        // Scalars first so they pack into neat grid cells; the list fields
        // below each claim a full-width row of pills instead.
        { label: "Blood Type", value: patient.blood_type },
        { label: "Height", value: patient.height_in != null ? `${patient.height_in} in` : null },
        { label: "Weight", value: patient.weight_lbs != null ? `${patient.weight_lbs} lbs` : null },
        {
          label: "Blood Pressure",
          value:
            patient.systolic_bp != null && patient.diastolic_bp != null
              ? `${patient.systolic_bp}/${patient.diastolic_bp} mmHg`
              : null,
        },
        { label: "Smoking Status", value: patient.smoking_status },
        { label: "Alcohol Use", value: patient.alcohol_use },
        { label: "Allergies", value: patient.allergies },
        { label: "Current Medications", value: patient.current_medications },
        { label: "Chronic Conditions", value: patient.chronic_conditions },
        { label: "Immunization History", value: patient.immunization_history },
      ],
    },
  ];

  return groups
    .map((group) => ({ ...group, fields: group.fields.filter((field) => hasDetailValue(field.value)) }))
    .filter((group) => group.fields.length > 0);
}

// One glyph per detail-panel section, drawn in the same hand-rolled style as
// ExpandChevron in table-primitives.tsx (20x20 viewBox, 1.5 stroke) -- a
// quick visual anchor for scanning a record, the way a chart summary would.
function SectionIcon({ label }: { label: string }) {
  const props = {
    viewBox: "0 0 20 20",
    fill: "none",
    className: "h-3.5 w-3.5 shrink-0",
    "aria-hidden": true,
  } as const;
  switch (label) {
    case "Address":
      return (
        <svg {...props}>
          <path
            d="M10 17.5S16 12.3 16 8a6 6 0 1 0-12 0c0 4.3 6 9.5 6 9.5Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="10" cy="8" r="2.25" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "Contact":
      return (
        <svg {...props}>
          <path
            d="M6.6 4H4.6A1.6 1.6 0 0 0 3 5.6C3 12.4 8.6 18 15.4 18a1.6 1.6 0 0 0 1.6-1.6v-2a1 1 0 0 0-.8-.98l-2.7-.55a1 1 0 0 0-.98.27l-1 1a9.4 9.4 0 0 1-4.65-4.65l1-1a1 1 0 0 0 .27-.98L7.58 4.8A1 1 0 0 0 6.6 4Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "Demographics":
      return (
        <svg {...props}>
          <circle cx="10" cy="6.75" r="3" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M4 17c0-3.3 2.7-6 6-6s6 2.7 6 6"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    case "Insurance & Care":
      return (
        <svg {...props}>
          <path
            d="M10 2.5 16 4.75V9c0 4.5-2.9 7.9-6 8.9-3.1-1-6-4.4-6-8.9V4.75L10 2.5Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M7.25 9.8 9 11.6l3.5-3.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Clinical":
      return (
        <svg {...props}>
          <path
            d="M2.5 10.5h3l1.5-3.5 2.5 6.5 1.7-4.5 1.2 1.5h4.1"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return null;
  }
}

// Content for a patient row's expanded detail panel -- the 27 optional
// fields, compact and grouped into cards, skipping anything not on file.
// Clinical tends to carry the most (and longest) fields, so it gets extra
// width to breathe instead of squeezing into the same card size as the rest.
function PatientDetailPanel({
  patient,
  isEditing,
  draft,
  onFieldChange,
}: {
  patient: PatientRead;
  isEditing: boolean;
  draft: EditDraft | null;
  onFieldChange: (field: string, value: string) => void;
}) {
  if (isEditing && draft) {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {OPTIONAL_FIELD_GROUPS.map((group) => (
          <div
            key={group.label}
            className={`rounded-lg border border-border bg-background/50 p-4 ${
              group.label === "Clinical" ? "md:col-span-2" : ""
            }`}
          >
            <div className="mb-3 flex items-center gap-1.5 border-b border-border pb-2 text-teal">
              <SectionIcon label={group.label} />
              <p className="font-mono text-[10px] tracking-[0.2em] uppercase">{group.label}</p>
            </div>
            <dl
              className={`grid grid-cols-1 gap-x-5 gap-y-2.5 sm:grid-cols-2 ${
                group.label === "Clinical" ? "lg:grid-cols-3" : ""
              }`}
            >
              {group.fields.map((config) => (
                <div key={config.key}>
                  <dt className="text-[10px] tracking-wide text-muted uppercase">{config.label}</dt>
                  <dd className="mt-1">
                    {config.kind === "enum" ? (
                      <select
                        value={draft[config.key]}
                        onChange={(event) => onFieldChange(config.key, event.target.value)}
                        className={tableInputClass()}
                      >
                        <option value="">—</option>
                        {config.options!.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={
                          config.kind === "int"
                            ? "number"
                            : config.kind === "date"
                              ? "date"
                              : config.kind === "email"
                                ? "email"
                                : "text"
                        }
                        value={draft[config.key]}
                        onChange={(event) => onFieldChange(config.key, event.target.value)}
                        placeholder={config.kind === "multi" ? "Comma-separated" : undefined}
                        max={config.kind === "date" ? TODAY_ISO : undefined}
                        className={tableInputClass()}
                      />
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    );
  }

  const groups = buildDetailGroups(patient);

  if (groups.length === 0) {
    return <p className="text-xs text-muted">No additional information on file.</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {groups.map((group) => (
        <div
          key={group.label}
          className={`rounded-lg border border-border bg-background/50 p-4 ${
            group.label === "Clinical" ? "md:col-span-2" : ""
          }`}
        >
          <div className="mb-3 flex items-center gap-1.5 border-b border-border pb-2 text-teal">
            <SectionIcon label={group.label} />
            <p className="font-mono text-[10px] tracking-[0.2em] uppercase">{group.label}</p>
          </div>
          <dl
            className={`grid grid-cols-1 gap-x-5 gap-y-2.5 sm:grid-cols-2 ${
              group.label === "Clinical" ? "lg:grid-cols-3" : ""
            }`}
          >
            {group.fields.map((field) => (
              <div key={field.label} className={Array.isArray(field.value) ? "col-span-full" : undefined}>
                <dt className="text-[10px] tracking-wide text-muted uppercase">{field.label}</dt>
                {Array.isArray(field.value) ? (
                  <dd className="mt-1.5 flex flex-wrap gap-1.5">
                    {field.value.map((item) => (
                      <span
                        key={item}
                        className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs font-medium text-foreground"
                      >
                        {item}
                      </span>
                    ))}
                  </dd>
                ) : (
                  <dd className="mt-0.5 text-sm font-medium text-foreground">{field.value}</dd>
                )}
              </div>
            ))}
          </dl>
        </div>
      ))}
    </div>
  );
}

// Patient records table: server-driven sort/filter/pagination, plus inline
// row editing (click Edit, fields become inputs, Save/Cancel). Self-
// contained -- owns its own fetch, loading/error state, and permission
// checks; the shared shell/table chrome comes from DataTableCard.
export default function PatientTable() {
  const { currentUser } = useAuth();
  const canEdit = hasPermission(currentUser, PERMISSIONS.patientEdit); // gates the Edit/Save/Cancel controls within the Actions column

  const [patients, setPatients] = useState<PatientRead[] | null>(null); // null until the first load resolves
  const [total, setTotal] = useState(0); // total matching rows across all pages
  const [loadError, setLoadError] = useState(false);
  const [isFetching, setIsFetching] = useState(false); // true while a sort/filter/page reload is in flight
  // Guards against an older, slower request's response landing after (and
  // overwriting) a newer one's -- loadPatients claims the next id before
  // doing anything async, and only applies its result if it's still the
  // most recently claimed id by the time that work finishes. Two filter
  // changes fired in quick succession, resolved out of order, would
  // otherwise leave the table showing the first (now-stale) filter's rows.
  const latestRequestIdRef = useRef(0);
  // The in-flight request's controller, if any -- loadPatients aborts it
  // before starting a new request so a burst of clicks (e.g. spamming a
  // sort header) never has more than one /patients call in flight. Without
  // this, superseded requests still run to completion server-side and pile
  // up against the browser's per-origin connection limit, so the table can
  // sit on the spinner for however long it takes ALL of them to drain even
  // though only the last one's result is ever applied (latestRequestIdRef
  // above already discards the rest).
  const inFlightAbortRef = useRef<AbortController | null>(null);

  // Which row's detail panel (the 27 optional fields) is open, if any --
  // one at a time, so the page doesn't grow tall with several open at once.
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

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
  const [sorting, setSorting] = useState<SortingState>([{ id: "patient_code", desc: false }]); // tanstack's single-column sort state -- drives the header's sort indicator immediately, undebounced
  // Debounced the same way as the text filters above, so spamming a sort
  // header doesn't fire one request per click -- only the value after
  // clicks settle down actually gets queried. sortBy/sortDir (below) are
  // what loadPatients and the reset-to-page-1 key use; `sorting` itself
  // stays undebounced so the header's chevron still flips on every click.
  const rawSortBy = (sorting[0]?.id ?? "patient_code") as
    | "patient_code"
    | "first_name"
    | "last_name"
    | "date_of_birth";
  const rawSortDir = sorting[0]?.desc ? "desc" : "asc";
  const debouncedSort = useDebouncedFilters({
    sort_by: rawSortBy,
    sort_dir: rawSortDir,
  });
  // useDebouncedFilters' Record<string, string> constraint widens these back
  // to plain `string` the same way sorting[0]?.id already is -- cast back to
  // the narrow unions apiGetPatients expects.
  const sortBy = debouncedSort.sort_by as typeof rawSortBy;
  const sortDir = debouncedSort.sort_dir as typeof rawSortDir;

  // Marks isFetching as soon as a debounced input changes, not just once its
  // debounce window ends and loadPatients actually starts fetching -- so the
  // spinner covers the whole "something's about to change" window. Doing
  // this from a comparison of raw vs. debounced values instead (i.e. "true
  // while they differ") looks equivalent but isn't: the debounced value
  // settles one render before loadPatients's own effect re-fires and calls
  // setIsFetching(true), leaving a one-tick gap where both are false.
  // useDelayedFlag (driving the spinner below) treats any false tick as
  // "done" and resets its show-delay, so that gap reads as the spinner
  // stopping and a new one starting once the request actually began.
  //
  // Set during render rather than in an effect -- same pattern
  // useDelayedFlag itself uses (see its own comment) -- so there's no extra
  // render where isFetching is still false after the raw input changed.
  const rawInputsKey = `${patientCodeInput}|${firstNameInput}|${lastNameInput}|${rawSortBy}|${rawSortDir}`;
  const [prevRawInputsKey, setPrevRawInputsKey] = useState(rawInputsKey);
  if (rawInputsKey !== prevRawInputsKey) {
    setPrevRawInputsKey(rawInputsKey);
    setIsFetching(true);
  }
  // Invalidates whatever's in flight the instant a raw input changes --
  // not just once the new debounced request actually starts (up to
  // DEBOUNCE_DELAY_MS later). Without this, a slow request from before the
  // change can still resolve and render during that window (nothing had
  // marked it stale yet), only to be visibly overwritten a moment later
  // once the new debounced request finally lands -- old results flash on
  // screen, then get replaced right behind them. Bumping the id here ends
  // that response's eligibility even if it resolves before this effect's
  // abort takes effect; aborting also stops it from doing further wasted
  // work at all whenever it can.
  useEffect(() => {
    inFlightAbortRef.current?.abort();
    latestRequestIdRef.current += 1;
  }, [rawInputsKey]);
  // Fallback for the above: if a raw input change ends up settling back to
  // whatever's already debounced (e.g. sort clicked away and back within
  // one debounce window), useDebouncedFilters intentionally keeps its same
  // output value (see its own comment) rather than "spuriously" changing --
  // so loadPatients's identity never changes, its effect never re-fires,
  // and nothing ever calls setIsFetching(false) to undo the eager set
  // above. Once the same window a real change would need has passed,
  // clear it here instead -- but only if no real request actually started
  // in the meantime (requestId unchanged), so a genuinely in-flight fetch
  // -- which can easily run longer than this window -- still gets to own
  // clearing isFetching itself via its own finally block.
  useEffect(() => {
    const requestIdAtChange = latestRequestIdRef.current;
    const timer = setTimeout(() => {
      if (latestRequestIdRef.current === requestIdAtChange) setIsFetching(false);
    }, DEBOUNCE_DELAY_MS + 50);
    return () => clearTimeout(timer);
  }, [rawInputsKey]);
  // 1-indexed page + page size; any change to the filters or sort below
  // sends it back to page 1.
  const { page, setPage, pageSize, setPageSize } = useTablePagination(25, [
    patientCodeFilter,
    firstNameFilter,
    lastNameFilter,
    genderFilter,
    dobFrom,
    dobTo,
    sortBy,
    sortDir,
  ]);

  // Inline-edit lifecycle (edit/save/rollback, one row at a time) -- shared
  // with UserManagementTable via useInlineRowEdit; only the draft shape,
  // field-level validation, and column defs below are this table's own.
  const inlineEdit = useInlineRowEdit<PatientRead, EditDraft>({
    setRows: setPatients,
    toRow: (patient, draft) => {
      const optionalUpdates: Record<string, unknown> = {};
      for (const config of ALL_OPTIONAL_FIELDS) {
        optionalUpdates[config.key] = parseOptionalField(config.kind, draft[config.key]);
      }
      return {
        ...patient,
        first_name: draft.first_name,
        last_name: draft.last_name,
        date_of_birth: draft.date_of_birth,
        gender: draft.gender as Gender,
        ...optionalUpdates,
      } as PatientRead;
    },
    changedFields: (draft, patient) => {
      const fields: string[] = [];
      if (draft.first_name !== patient.first_name) fields.push("first_name");
      if (draft.last_name !== patient.last_name) fields.push("last_name");
      if (draft.date_of_birth !== patient.date_of_birth) fields.push("date_of_birth");
      if (draft.gender !== patient.gender) fields.push("gender");
      for (const config of ALL_OPTIONAL_FIELDS) {
        if (draft[config.key] !== serializeOptionalField(config.kind, patient[config.key])) {
          fields.push(config.key);
        }
      }
      return fields;
    },
    request: (id, draft, fields) => {
      // Only sends fields that actually changed.
      const changes: PatientUpdate = {};
      if (fields.includes("first_name")) changes.first_name = draft.first_name;
      if (fields.includes("last_name")) changes.last_name = draft.last_name;
      if (fields.includes("date_of_birth")) changes.date_of_birth = draft.date_of_birth;
      if (fields.includes("gender")) changes.gender = draft.gender as Gender;
      for (const config of ALL_OPTIONAL_FIELDS) {
        if (fields.includes(config.key)) {
          (changes as Record<string, unknown>)[config.key] = parseOptionalField(config.kind, draft[config.key]);
        }
      }
      return apiPatchPatient(id, changes);
    },
    errorMessage: (err) => {
      if (err instanceof ApiError && err.status === 404) {
        return "This patient no longer exists. Refresh to update the list.";
      }
      // A 422 here is almost always one optional field failing its format/
      // range check (a bad phone number, an out-of-range height, ...) --
      // surfacing the server's own message beats a generic one, since
      // nothing client-side validates these 27 fields before Save.
      if (err instanceof ApiError && err.status === 422) {
        const detail = (err.body as { detail?: Array<{ msg?: string }> } | null)?.detail;
        const message = detail?.[0]?.msg;
        if (message) return message.replace(/^Value error,\s*/, "");
      }
      return "Could not save changes. Please try again.";
    },
  });

  // Enters edit mode for one row, seeding the draft from its current values.
  // Also opens the detail panel: that's the only place the 27 optional
  // fields' inputs render, and Edit should reach all of them, not just the
  // 4 always-visible columns.
  function handleEditClick(patient: PatientRead) {
    const optionalDraft: Record<string, string> = {};
    for (const config of ALL_OPTIONAL_FIELDS) {
      optionalDraft[config.key] = serializeOptionalField(config.kind, patient[config.key]);
    }
    inlineEdit.onEditClick(patient, {
      first_name: patient.first_name,
      last_name: patient.last_name,
      date_of_birth: patient.date_of_birth,
      gender: patient.gender,
      ...optionalDraft,
    });
    setExpandedRowId(patient.id);
  }

  // Cancels an in-progress edit before switching the expanded panel to a
  // different patient (same as clicking Cancel would) -- otherwise that
  // edit would be stranded open (Save/Cancel still showing on its row)
  // with no visible way to reach its optional-field inputs, since the
  // panel that hosts them just moved to the row being opened.
  function handleToggleExpand(patient: PatientRead) {
    if (inlineEdit.editingId && inlineEdit.editingId !== patient.id) {
      inlineEdit.onCancel();
    }
    setExpandedRowId((prev) => (prev === patient.id ? null : patient.id));
  }

  // Fetches the current page from the server using all active filters/
  // sort/pagination state.
  const loadPatients = useCallback(async () => {
    const requestId = ++latestRequestIdRef.current;

    // Cancel whatever's still in flight before starting this one -- see
    // inFlightAbortRef's declaration for why.
    inFlightAbortRef.current?.abort();
    const controller = new AbortController();
    inFlightAbortRef.current = controller;

    // No gender checked means the filter matches nothing -- short-circuit
    // rather than sending an empty `gender` param, which the API would
    // read as "no filter" (i.e. every row) instead of "no rows". Nothing
    // async happens before this, so it can never itself be superseded --
    // it always is the latest request the instant it runs.
    if (genderFilter.length === 0) {
      setPatients([]);
      setTotal(0);
      setLoadError(false);
      return;
    }

    setIsFetching(true);
    try {
      const data = await apiGetPatients(
        {
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
        },
        { signal: controller.signal },
      );
      // A newer request already started (and will apply its own result) by
      // the time this one resolved -- discard rather than clobber it.
      if (requestId !== latestRequestIdRef.current) return;
      setPatients(data.items);
      setTotal(data.total);
      setLoadError(false);
    } catch (err) {
      // Expected whenever this request lost the abort race above -- the
      // request that superseded it already owns updating state.
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (requestId !== latestRequestIdRef.current) return;
      setLoadError(true);
    } finally {
      if (requestId === latestRequestIdRef.current) setIsFetching(false);
    }
  }, [patientCodeFilter, firstNameFilter, lastNameFilter, genderFilter, dobFrom, dobTo, sortBy, sortDir, page, pageSize]);

  useEffect(() => {
    (async () => {
      await loadPatients();
    })();
  }, [loadPatients]);

  // Abort any still-in-flight request on unmount so it doesn't try to
  // update state (or keep the server working) after the table is gone.
  useEffect(() => {
    return () => inFlightAbortRef.current?.abort();
  }, []);

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
          return <TextCell>{info.getValue()}</TextCell>;
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
          return <TextCell>{info.getValue()}</TextCell>;
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
          return <TextCell>{formatDateDisplay(info.getValue())}</TextCell>;
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
          return <GenderBadge value={info.getValue()} />;
        },
      }),
    ];

    // Actions column: edit controls only -- the expand toggle lives in
    // DataTableCard's own leading column instead (see showExpandColumn
    // below), so a viewer without patient.edit sees this column empty.
    base.push(
      columnHelper.display({
        id: "actions",
        header: "Actions",
        cell: (info) => {
          if (!canEdit) return null;
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
      title="Patient records"
      headerActions={<PatientUploadCard onUploaded={loadPatients} />}
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
      expandedRowId={expandedRowId}
      onToggleExpand={handleToggleExpand}
      renderExpandedContent={(patient) => (
        <PatientDetailPanel
          patient={patient}
          isEditing={inlineEdit.editingId === patient.id}
          draft={inlineEdit.editingId === patient.id ? (inlineEdit.editDraft as EditDraft) : null}
          onFieldChange={inlineEdit.onFieldChange}
        />
      )}
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
    />
  );
}
