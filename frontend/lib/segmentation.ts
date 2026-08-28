// Phase 4 (Segmentation): filtering the whole dashboard down to a subgroup,
// comparing two cohorts directly, and checking whether a headline finding
// actually holds within subgroups instead of only in the pooled data.

import { AGE_BRACKETS, type AnalyticsRow } from "@/lib/analytics";
import { welchTTest, type TTestResult } from "@/lib/stats";

// Fields the global filter bar can slice by -- a deliberately short list
// (not "every field"): these are the dimensions a reader actually wants to
// segment a patient population by, and each has a small enough category
// count to show as a checklist rather than needing search/pagination.
export interface SegmentFilters {
  ageBracket: string[];
  gender: string[];
  insuranceProvider: string[];
  careDepartment: string[];
  smokingStatus: string[];
}

export const EMPTY_SEGMENT_FILTERS: SegmentFilters = {
  ageBracket: [],
  gender: [],
  insuranceProvider: [],
  careDepartment: [],
  smokingStatus: [],
};

export const SEGMENT_FILTER_FIELDS: { key: keyof SegmentFilters; label: string }[] = [
  { key: "ageBracket", label: "Age bracket" },
  { key: "gender", label: "Gender" },
  { key: "insuranceProvider", label: "Insurance" },
  { key: "careDepartment", label: "Department" },
  { key: "smokingStatus", label: "Smoking status" },
];

// Exported so the Segmentation tab's cohort-split and "check across" pickers
// can read the same field a filter checkbox represents, without redeclaring
// the row->value mapping a second time.
export const SEGMENT_FIELD_ACCESSORS: Record<keyof SegmentFilters, (row: AnalyticsRow) => string | null> = {
  ageBracket: (row) => row.ageBracket,
  gender: (row) => row.gender,
  insuranceProvider: (row) => row.insuranceProvider,
  careDepartment: (row) => row.careDepartment,
  smokingStatus: (row) => row.smokingStatus,
};

export function isFilterActive(filters: SegmentFilters): boolean {
  return SEGMENT_FILTER_FIELDS.some(({ key }) => filters[key].length > 0);
}

// A row matches when every field WITH an active selection includes that
// row's value -- an empty selection for a field means "don't filter on
// this field at all", not "match nothing".
export function applySegmentFilters(rows: AnalyticsRow[], filters: SegmentFilters): AnalyticsRow[] {
  const activeFields = SEGMENT_FILTER_FIELDS.filter(({ key }) => filters[key].length > 0);
  if (activeFields.length === 0) return rows;
  return rows.filter((row) =>
    activeFields.every(({ key }) => {
      const value = SEGMENT_FIELD_ACCESSORS[key](row);
      return value != null && filters[key].includes(value);
    }),
  );
}

// Distinct values a field actually takes across these rows, for populating
// the filter checklist -- age bracket keeps its natural young-to-old order
// instead of being alphabetized (which would scramble it).
export function filterOptionsFor(rows: AnalyticsRow[], key: keyof SegmentFilters): string[] {
  if (key === "ageBracket") return [...AGE_BRACKETS];
  const accessor = SEGMENT_FIELD_ACCESSORS[key];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = accessor(row);
    if (value != null) seen.add(value);
  }
  return [...seen].sort();
}

// --- cohort comparison ---------------------------------------------------

export interface CohortSummary {
  n: number;
  mean: number | null;
}

export function summarizeCohort(rows: AnalyticsRow[], valueOf: (row: AnalyticsRow) => number | null): CohortSummary {
  const values = rows.map(valueOf).filter((value): value is number => value != null);
  if (values.length === 0) return { n: 0, mean: null };
  return { n: values.length, mean: values.reduce((sum, value) => sum + value, 0) / values.length };
}

export interface CohortComparison {
  cohortA: CohortSummary;
  cohortB: CohortSummary;
  test: TTestResult | null;
}

// Compares one numeric field between two already-filtered cohorts with
// Welch's t-test -- the same test used for a binary target in Phase 3, just
// applied to two user-chosen subgroups instead of a target's two outcome
// values.
export function compareCohorts(
  cohortARows: AnalyticsRow[],
  cohortBRows: AnalyticsRow[],
  valueOf: (row: AnalyticsRow) => number | null,
): CohortComparison {
  const valuesA = cohortARows.map(valueOf).filter((value): value is number => value != null);
  const valuesB = cohortBRows.map(valueOf).filter((value): value is number => value != null);
  return {
    cohortA: summarizeCohort(cohortARows, valueOf),
    cohortB: summarizeCohort(cohortBRows, valueOf),
    test: welchTTest(valuesA, valuesB),
  };
}

// --- subgroup consistency check -------------------------------------------

export interface SubgroupOutcome {
  subgroup: string;
  n: number;
  cohortAMean: number | null;
  cohortBMean: number | null;
  // Positive means cohort A's mean is higher within this subgroup.
  direction: "higher" | "lower" | "no-difference" | "insufficient-data";
}

export interface ConsistencyCheckResult {
  outcomes: SubgroupOutcome[];
  // True when every subgroup that has enough data agrees on direction with
  // the pooled (unsplit) comparison -- false is the actual finding worth
  // flagging, since it means a pooled result can hide a reversal in a
  // subgroup (a Simpson's-paradox-shaped pattern).
  consistent: boolean;
  pooledDirection: SubgroupOutcome["direction"];
}

const MIN_SUBGROUP_SIZE = 10;

// Re-runs a cohort comparison within each level of `splitBy`, to check
// whether a pooled finding actually holds across every subgroup or only
// appears because one large subgroup dominates the pooled average.
export function checkSubgroupConsistency(
  cohortARows: AnalyticsRow[],
  cohortBRows: AnalyticsRow[],
  valueOf: (row: AnalyticsRow) => number | null,
  splitBy: (row: AnalyticsRow) => string | null,
): ConsistencyCheckResult {
  const direction = (meanA: number | null, meanB: number | null): SubgroupOutcome["direction"] => {
    if (meanA == null || meanB == null) return "insufficient-data";
    const diff = meanA - meanB;
    if (Math.abs(diff) < 1e-9) return "no-difference";
    return diff > 0 ? "higher" : "lower";
  };

  const pooled = summarizeCohort(cohortARows, valueOf);
  const pooledB = summarizeCohort(cohortBRows, valueOf);
  const pooledDirection = direction(pooled.mean, pooledB.mean);

  const subgroups = new Set<string>();
  for (const row of [...cohortARows, ...cohortBRows]) {
    const key = splitBy(row);
    if (key != null) subgroups.add(key);
  }

  const outcomes: SubgroupOutcome[] = [...subgroups].sort().map((subgroup) => {
    const groupA = cohortARows.filter((row) => splitBy(row) === subgroup);
    const groupB = cohortBRows.filter((row) => splitBy(row) === subgroup);
    const summaryA = summarizeCohort(groupA, valueOf);
    const summaryB = summarizeCohort(groupB, valueOf);
    const n = summaryA.n + summaryB.n;
    const hasEnoughData = summaryA.n >= MIN_SUBGROUP_SIZE && summaryB.n >= MIN_SUBGROUP_SIZE;
    return {
      subgroup,
      n,
      cohortAMean: summaryA.mean,
      cohortBMean: summaryB.mean,
      direction: hasEnoughData ? direction(summaryA.mean, summaryB.mean) : "insufficient-data",
    };
  });

  const consistent = outcomes.every(
    (outcome) =>
      outcome.direction === "insufficient-data" ||
      outcome.direction === "no-difference" ||
      outcome.direction === pooledDirection,
  );

  return { outcomes, consistent, pooledDirection };
}
