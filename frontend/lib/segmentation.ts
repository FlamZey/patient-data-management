// Cohort comparison: directly comparing two patient subgroups on a numeric
// field, and checking whether that comparison actually holds within every
// subgroup or only appears in the pooled numbers (a Simpson's-paradox-shaped
// reversal).

import type { AnalyticsRow } from "@/lib/analytics";
import { welchTTest, type TTestResult } from "@/lib/stats";

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
// Welch's t-test.
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
