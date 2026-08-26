// Turns the columnar, dictionary-encoded payload from
// GET /patients/analytics-dataset into row records the charts can read, plus
// the derived variables the dashboard analyses (BMI, age brackets, condition
// counts, and the selectable outcome/target variables).
//
// The wire format is columnar specifically to keep the payload small (~89
// bytes/row vs ~1.4KB for the full patient record); this module is where it
// gets turned back into something ergonomic, once, at load time.

import type { AnalyticsDataset, AnalyticsQuality } from "@/lib/types";

// One patient, decoded. Every field is nullable because every optional column
// genuinely can be absent -- a workbook may include any subset of them.
export interface AnalyticsRow {
  gender: string | null;
  state: string | null;
  raceEthnicity: string | null;
  maritalStatus: string | null;
  insuranceProvider: string | null;
  preferredPharmacy: string | null;
  bloodType: string | null;
  smokingStatus: string | null;
  alcoholUse: string | null;
  careDepartment: string | null;

  age: number | null;
  heightIn: number | null;
  weightLbs: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;

  chronicConditions: string[];
  currentMedications: string[];

  registrationMonth: string | null;
  lastVisitMonth: string | null;

  // --- derived ---
  bmi: number | null;
  ageBracket: string | null;
  conditionCount: number;
  medicationCount: number;
}

export const AGE_BRACKETS = ["0-17", "18-29", "30-44", "45-59", "60-74", "75+"] as const;

// Matches the bands the sample generator conditions its rates on
// (backend/scripts/generate_random_workbook.py `_age_band_index`), so a
// chart bucketed this way lines up with how the data was actually shaped.
export function ageBracketOf(age: number | null): string | null {
  if (age == null) return null;
  if (age < 18) return "0-17";
  if (age < 30) return "18-29";
  if (age < 45) return "30-44";
  if (age < 60) return "45-59";
  if (age < 75) return "60-74";
  return "75+";
}

// Imperial BMI. Guards height 0 rather than trusting the upload bounds --
// a divide-by-zero here would silently produce Infinity and poison every
// downstream mean.
export function bmiOf(heightIn: number | null, weightLbs: number | null): number | null {
  if (heightIn == null || weightLbs == null || heightIn <= 0) return null;
  return (703 * weightLbs) / (heightIn * heightIn);
}

export function bmiCategoryOf(bmi: number | null): string | null {
  if (bmi == null) return null;
  if (bmi < 18.5) return "Underweight";
  if (bmi < 25) return "Normal";
  if (bmi < 30) return "Overweight";
  return "Obese";
}

function decodeCategory(code: number | null, values: string[]): string | null {
  return code == null ? null : (values[code] ?? null);
}

export function decodeDataset(dataset: AnalyticsDataset): AnalyticsRow[] {
  const { columns, categories, multi_value_categories: multiValue } = dataset;
  const conditionValues = multiValue.chronic_conditions ?? [];
  const medicationValues = multiValue.current_medications ?? [];

  const rows: AnalyticsRow[] = new Array(dataset.total);
  for (let i = 0; i < dataset.total; i += 1) {
    const heightIn = columns.height_in[i];
    const weightLbs = columns.weight_lbs[i];
    const bmi = bmiOf(heightIn, weightLbs);
    const age = columns.age[i];
    const chronicConditions = (columns.chronic_conditions[i] ?? []).map(
      (code) => conditionValues[code] ?? "",
    );
    const currentMedications = (columns.current_medications[i] ?? []).map(
      (code) => medicationValues[code] ?? "",
    );

    rows[i] = {
      gender: decodeCategory(columns.gender[i], categories.gender ?? []),
      state: decodeCategory(columns.state[i], categories.state ?? []),
      raceEthnicity: decodeCategory(columns.race_ethnicity[i], categories.race_ethnicity ?? []),
      maritalStatus: decodeCategory(columns.marital_status[i], categories.marital_status ?? []),
      insuranceProvider: decodeCategory(
        columns.insurance_provider[i],
        categories.insurance_provider ?? [],
      ),
      preferredPharmacy: decodeCategory(
        columns.preferred_pharmacy[i],
        categories.preferred_pharmacy ?? [],
      ),
      bloodType: decodeCategory(columns.blood_type[i], categories.blood_type ?? []),
      smokingStatus: decodeCategory(columns.smoking_status[i], categories.smoking_status ?? []),
      alcoholUse: decodeCategory(columns.alcohol_use[i], categories.alcohol_use ?? []),
      careDepartment: decodeCategory(columns.care_department[i], categories.care_department ?? []),

      age,
      heightIn,
      weightLbs,
      systolicBp: columns.systolic_bp[i],
      diastolicBp: columns.diastolic_bp[i],

      chronicConditions,
      currentMedications,

      registrationMonth: columns.registration_month[i],
      lastVisitMonth: columns.last_visit_month[i],

      bmi,
      ageBracket: ageBracketOf(age),
      conditionCount: chronicConditions.length,
      medicationCount: currentMedications.length,
    };
  }
  return rows;
}

// --- target (outcome) variables ---------------------------------------------
// The dashboard has no natural outcome column -- the patient record has no
// mortality, readmission, or cost field -- so the analysable outcomes are all
// derived from what IS on file. Each is offered as a selectable target so the
// reader picks what "associated with" means rather than having one baked in.

export type TargetKind = "binary" | "count";

export interface TargetVariable {
  id: string;
  label: string;
  description: string;
  kind: TargetKind;
  // Rows where the target can't be computed (its inputs aren't on file) are
  // excluded from that target's analyses rather than silently counted as 0.
  valueOf: (row: AnalyticsRow) => number | null;
}

const HYPERTENSION_SYSTOLIC = 130;
const HYPERTENSION_DIASTOLIC = 80;
const POLYPHARMACY_THRESHOLD = 5;
const OBESITY_BMI = 30;

export const TARGET_VARIABLES: TargetVariable[] = [
  {
    id: "condition_burden",
    label: "Chronic condition burden",
    description: "Number of chronic conditions on file per patient.",
    kind: "count",
    valueOf: (row) => row.conditionCount,
  },
  {
    id: "has_condition",
    label: "Has any chronic condition",
    description: "Whether the patient has at least one chronic condition on file.",
    kind: "binary",
    valueOf: (row) => (row.conditionCount > 0 ? 1 : 0),
  },
  {
    id: "polypharmacy",
    label: `Polypharmacy (${POLYPHARMACY_THRESHOLD}+ medications)`,
    description: `Whether the patient is on ${POLYPHARMACY_THRESHOLD} or more concurrent medications.`,
    kind: "binary",
    valueOf: (row) => (row.medicationCount >= POLYPHARMACY_THRESHOLD ? 1 : 0),
  },
  {
    id: "obesity",
    label: "Obesity (BMI 30+)",
    description: "Derived from height and weight; excludes patients missing either.",
    kind: "binary",
    valueOf: (row) => (row.bmi == null ? null : row.bmi >= OBESITY_BMI ? 1 : 0),
  },
  {
    id: "elevated_bp",
    label: "Elevated blood pressure (130/80+)",
    description:
      "Measured reading at or above 130 systolic or 80 diastolic -- distinct from a recorded hypertension diagnosis.",
    kind: "binary",
    valueOf: (row) => {
      if (row.systolicBp == null || row.diastolicBp == null) return null;
      return row.systolicBp >= HYPERTENSION_SYSTOLIC || row.diastolicBp >= HYPERTENSION_DIASTOLIC ? 1 : 0;
    },
  },
  {
    id: "medication_count",
    label: "Medication count",
    description: "Number of concurrent medications on file per patient.",
    kind: "count",
    valueOf: (row) => row.medicationCount,
  },
];

export const DEFAULT_TARGET_ID = "condition_burden";

// --- field coverage ----------------------------------------------------------

export interface FieldCoverage {
  field: string;
  label: string;
  populated: number;
  total: number;
}

// Which fields the coverage panel reports on, and how to tell "on file" from
// "absent" for each. Multi-value fields count an empty list as absent, since
// that's what the backend emits for a patient with none recorded.
const COVERAGE_FIELDS: { field: keyof AnalyticsRow; label: string }[] = [
  { field: "age", label: "Age (from date of birth)" },
  { field: "gender", label: "Gender" },
  { field: "state", label: "State" },
  { field: "raceEthnicity", label: "Race/Ethnicity" },
  { field: "maritalStatus", label: "Marital status" },
  { field: "insuranceProvider", label: "Insurance provider" },
  { field: "preferredPharmacy", label: "Preferred pharmacy" },
  { field: "careDepartment", label: "Care department" },
  { field: "bloodType", label: "Blood type" },
  { field: "heightIn", label: "Height" },
  { field: "weightLbs", label: "Weight" },
  { field: "systolicBp", label: "Systolic BP" },
  { field: "diastolicBp", label: "Diastolic BP" },
  { field: "smokingStatus", label: "Smoking status" },
  { field: "alcoholUse", label: "Alcohol use" },
  { field: "chronicConditions", label: "Chronic conditions" },
  { field: "currentMedications", label: "Current medications" },
  { field: "registrationMonth", label: "Registration date" },
  { field: "lastVisitMonth", label: "Last visit date" },
];

function isPopulated(value: AnalyticsRow[keyof AnalyticsRow]): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value != null && value !== "";
}

export function computeCoverage(rows: AnalyticsRow[]): FieldCoverage[] {
  return COVERAGE_FIELDS.map(({ field, label }) => ({
    field: String(field),
    label,
    populated: rows.reduce((count, row) => count + (isPopulated(row[field]) ? 1 : 0), 0),
    total: rows.length,
  }));
}

// --- client-side quality flags ----------------------------------------------
// These are the checks computable from the de-identified projection alone. The
// ones that need real PHI (duplicate name+DOB, dates before birth) are counted
// server-side instead and arrive in AnalyticsQuality -- see the endpoint.

export interface QualityFlag {
  id: string;
  label: string;
  count: number;
  detail: string;
  // Whether these rows are dropped from analyses that use the affected field.
  excluded: boolean;
}

// Wider than any real adult BMI on either side -- this is looking for data
// entry errors (a height in feet, a weight in kg), not clinical outliers, so
// the bounds deliberately sit outside even severe real-world extremes.
const IMPLAUSIBLE_BMI_LOW = 10;
const IMPLAUSIBLE_BMI_HIGH = 70;
const IMPLAUSIBLE_AGE = 110;

export function computeQualityFlags(
  rows: AnalyticsRow[],
  serverQuality: AnalyticsQuality,
): QualityFlag[] {
  let implausibleBmi = 0;
  let implausibleAge = 0;
  let bpInverted = 0;

  for (const row of rows) {
    if (row.bmi != null && (row.bmi < IMPLAUSIBLE_BMI_LOW || row.bmi > IMPLAUSIBLE_BMI_HIGH)) {
      implausibleBmi += 1;
    }
    if (row.age != null && row.age > IMPLAUSIBLE_AGE) implausibleAge += 1;
    if (row.systolicBp != null && row.diastolicBp != null && row.diastolicBp >= row.systolicBp) {
      bpInverted += 1;
    }
  }

  return [
    {
      id: "implausible_bmi",
      label: "Implausible BMI",
      count: implausibleBmi,
      detail: `BMI below ${IMPLAUSIBLE_BMI_LOW} or above ${IMPLAUSIBLE_BMI_HIGH}, which usually means a height or weight entered in the wrong unit.`,
      excluded: true,
    },
    {
      id: "implausible_age",
      label: "Implausible age",
      count: implausibleAge,
      detail: `Age over ${IMPLAUSIBLE_AGE}, which passes upload validation but is almost certainly a mistyped date of birth.`,
      excluded: false,
    },
    {
      id: "bp_inverted",
      label: "Diastolic >= systolic",
      count: bpInverted,
      detail: "A blood pressure reading where the two numbers are equal or reversed.",
      excluded: true,
    },
    {
      id: "duplicate_identity",
      label: "Possible duplicate patients",
      count: serverQuality.duplicate_identity_rows,
      detail: `${serverQuality.duplicate_identity_groups} name + date-of-birth ${
        serverQuality.duplicate_identity_groups === 1 ? "group" : "groups"
      } shared by more than one record. Checked on the server so names never leave it. Two real people can share both, so these are flagged for review, not removed.`,
      excluded: false,
    },
    {
      id: "dates_before_birth",
      label: "Dates before birth",
      count: serverQuality.dates_before_birth,
      detail:
        "A registration or last-visit date earlier than the patient's date of birth. Newer uploads reject these; older records predate that rule.",
      excluded: false,
    },
    {
      id: "visit_before_registration",
      label: "Visit before registration",
      count: serverQuality.last_visit_before_registration,
      detail: "A last-visit date earlier than the registration date.",
      excluded: false,
    },
    {
      id: "unreadable",
      label: "Unreadable records",
      count: serverQuality.unreadable_rows,
      detail:
        "Records whose encrypted fields could not be decrypted. These are excluded entirely from every figure on this page.",
      excluded: true,
    },
  ].filter((flag) => flag.count > 0);
}

// --- aggregation helpers -----------------------------------------------------

export interface CountBucket {
  label: string;
  count: number;
}

// Counts by category, biggest first. `topN` folds the tail into "Other"
// rather than emitting more colors -- past ~7 classes a chart stops being
// readable, and a generated 9th hue is indistinguishable under CVD anyway.
export function countBy(
  rows: AnalyticsRow[],
  accessor: (row: AnalyticsRow) => string | null,
  topN?: number,
): CountBucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = accessor(row);
    if (key == null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  if (topN == null || sorted.length <= topN) return sorted;
  const head = sorted.slice(0, topN);
  const tail = sorted.slice(topN);
  return [...head, { label: "Other", count: tail.reduce((sum, bucket) => sum + bucket.count, 0) }];
}

// Counts by category in a caller-supplied order (age brackets, BMI categories)
// rather than by size -- an ordered scale must not be re-sorted by magnitude.
export function countByOrdered(
  rows: AnalyticsRow[],
  accessor: (row: AnalyticsRow) => string | null,
  order: readonly string[],
): CountBucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = accessor(row);
    if (key == null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return order.map((label) => ({ label, count: counts.get(label) ?? 0 }));
}

export function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Single pass rather than Math.min(...values) / Math.max(...values). Spreading
// an array into a call passes one argument per element, which throws
// RangeError once the array outgrows the engine's argument limit -- these
// arrays hold one entry per patient, and nothing caps how many patients a
// manager can upload.
export function minMax(values: number[]): { min: number; max: number } | null {
  if (values.length === 0) return null;
  let min = values[0];
  let max = values[0];
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i];
    if (value < min) min = value;
    else if (value > max) max = value;
  }
  return { min, max };
}

// Linear-interpolated percentile on an already-sorted ascending array -- the
// same definition used for the box plot's quartiles and whiskers.
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

export interface BoxStats {
  label: string;
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

// Tukey box plot: whiskers reach the furthest point within 1.5x IQR, not the
// absolute min/max, so genuine outliers don't stretch the whole scale.
export function boxStatsFor(label: string, values: number[]): BoxStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const median = percentile(sorted, 0.5);
  const q3 = percentile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - 1.5 * iqr;
  const upperFence = q3 + 1.5 * iqr;
  const withinLower = sorted.find((value) => value >= lowerFence) ?? sorted[0];
  let withinUpper = sorted[sorted.length - 1];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i] <= upperFence) {
      withinUpper = sorted[i];
      break;
    }
  }
  return { label, n: values.length, min: withinLower, q1, median, q3, max: withinUpper };
}

export interface HistogramBin {
  start: number;
  end: number;
  count: number;
}

export function histogram(values: number[], binCount: number): HistogramBin[] {
  const bounds = minMax(values);
  if (bounds === null) return [];
  const { min, max } = bounds;
  if (min === max) return [{ start: min, end: min, count: values.length }];

  const width = (max - min) / binCount;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    start: min + i * width,
    end: min + (i + 1) * width,
    count: 0,
  }));
  for (const value of values) {
    // The max value would land one past the last bin by pure division.
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    bins[index].count += 1;
  }
  return bins;
}

// Pearson correlation over the rows where BOTH values are present -- pairwise
// deletion, not zero-filling, since a missing value is not a zero.
export function pearson(pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

export interface NumericField {
  key: string;
  label: string;
  valueOf: (row: AnalyticsRow) => number | null;
}

export const NUMERIC_FIELDS: NumericField[] = [
  { key: "age", label: "Age", valueOf: (row) => row.age },
  { key: "bmi", label: "BMI", valueOf: (row) => row.bmi },
  { key: "heightIn", label: "Height", valueOf: (row) => row.heightIn },
  { key: "weightLbs", label: "Weight", valueOf: (row) => row.weightLbs },
  { key: "systolicBp", label: "Systolic BP", valueOf: (row) => row.systolicBp },
  { key: "diastolicBp", label: "Diastolic BP", valueOf: (row) => row.diastolicBp },
  { key: "conditionCount", label: "Conditions", valueOf: (row) => row.conditionCount },
  { key: "medicationCount", label: "Medications", valueOf: (row) => row.medicationCount },
];

export function pairsFor(
  rows: AnalyticsRow[],
  x: (row: AnalyticsRow) => number | null,
  y: (row: AnalyticsRow) => number | null,
): [number, number][] {
  const pairs: [number, number][] = [];
  for (const row of rows) {
    const xValue = x(row);
    const yValue = y(row);
    if (xValue != null && yValue != null && Number.isFinite(xValue) && Number.isFinite(yValue)) {
      pairs.push([xValue, yValue]);
    }
  }
  return pairs;
}

// Ordinary least squares fit, for the scatter plot's trendline.
export function linearFit(pairs: [number, number][]): { slope: number; intercept: number } | null {
  const n = pairs.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    num += dx * (y - meanY);
    den += dx * dx;
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: meanY - slope * meanX };
}

// Monthly series for the trend chart, gap-filled across the full observed
// range so a month with no patients reads as zero rather than being skipped
// (which would silently compress the time axis).
export function monthlySeries(
  rows: AnalyticsRow[],
  accessor: (row: AnalyticsRow) => string | null,
): { month: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const month = accessor(row);
    if (month == null) continue;
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  if (counts.size === 0) return [];

  const months = [...counts.keys()].sort();
  const [startYear, startMonth] = months[0].split("-").map(Number);
  const [endYear, endMonth] = months[months.length - 1].split("-").map(Number);

  const series: { month: string; count: number }[] = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    series.push({ month: key, count: counts.get(key) ?? 0 });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return series;
}
