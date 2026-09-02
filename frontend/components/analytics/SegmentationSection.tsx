"use client";

// Cohort comparison: current smokers vs. never smoked, compared on systolic
// blood pressure -- the sharpest categorical split in the statistics table
// (see StatisticsSection) shown as a direct two-group comparison, plus a
// check for whether it holds within every age subgroup or only in the
// pooled numbers (a Simpson's-paradox-shaped reversal).

import { useMemo } from "react";

import { ChartCard } from "@/components/charts/ChartFrame";
import { formatNumber } from "@/components/charts/chart-theme";
import type { AnalyticsRow } from "@/lib/analytics";
import { checkSubgroupConsistency, compareCohorts } from "@/lib/segmentation";

// Mirrors backend/scripts/generate_load_test_workbook.py's CURRENT_SMOKING_STATUSES:
// the closed enum has no single "current smoker" value, so "currently smokes"
// is these three statuses grouped together.
const CURRENT_SMOKER_STATUSES = new Set([
  "Current every day smoker",
  "Current some day smoker",
  "Heavy tobacco smoker",
]);
const NEVER_SMOKER_STATUS = "Never smoker";

const valueOf = (row: AnalyticsRow) => row.systolicBp;
const ageBracketOf = (row: AnalyticsRow) => row.ageBracket;

function formatP(p: number): string {
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

const DIRECTION_LABEL: Record<string, string> = {
  higher: "Cohort A higher",
  lower: "Cohort B higher",
  "no-difference": "No difference",
  "insufficient-data": "not enough data",
};

interface SegmentationSectionProps {
  rows: AnalyticsRow[];
}

export default function SegmentationSection({ rows }: SegmentationSectionProps) {
  const cohortARows = useMemo(
    () => rows.filter((row) => row.smokingStatus != null && CURRENT_SMOKER_STATUSES.has(row.smokingStatus)),
    [rows],
  );
  const cohortBRows = useMemo(() => rows.filter((row) => row.smokingStatus === NEVER_SMOKER_STATUS), [rows]);

  const comparison = useMemo(() => compareCohorts(cohortARows, cohortBRows, valueOf), [cohortARows, cohortBRows]);
  const consistency = useMemo(
    () => checkSubgroupConsistency(cohortARows, cohortBRows, valueOf, ageBracketOf),
    [cohortARows, cohortBRows],
  );

  // checkSubgroupConsistency reports `consistent` over the subgroups it could
  // actually check, so with none of them checkable (too few patients in one
  // cohort, or no smoking status on file at all) it comes back true over zero
  // real comparisons. Claiming a verified finding there would be the whole
  // point of this check inverted, so that case gets its own neutral state.
  const checkedSubgroups = consistency.outcomes.filter(
    (outcome) => outcome.direction !== "insufficient-data",
  ).length;

  return (
    <ChartCard
      title="Cohort comparison: smoking status"
      subtitle="Current smokers vs. never smoked, compared on systolic blood pressure (Welch's t-test)."
      footnote="“Current smoker” groups every day, some day, and heavy tobacco smoker statuses; “never smoked” is the never-smoker status on its own."
    >
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-background p-3">
          <p className="text-[10px] text-muted uppercase">Cohort A · current smoker</p>
          <p className="mt-1 font-serif text-lg font-semibold text-foreground">
            {comparison.cohortA.mean != null ? formatNumber(comparison.cohortA.mean, 1) : "—"}
          </p>
          <p className="text-[11px] text-muted">n = {formatNumber(comparison.cohortA.n, 0)}</p>
        </div>
        <div className="rounded-lg border border-border bg-background p-3">
          <p className="text-[10px] text-muted uppercase">Cohort B · never smoked</p>
          <p className="mt-1 font-serif text-lg font-semibold text-foreground">
            {comparison.cohortB.mean != null ? formatNumber(comparison.cohortB.mean, 1) : "—"}
          </p>
          <p className="text-[11px] text-muted">n = {formatNumber(comparison.cohortB.n, 0)}</p>
        </div>
        <div className="rounded-lg border border-border bg-background p-3">
          <p className="text-[10px] text-muted uppercase">Difference</p>
          {comparison.test ? (
            <>
              <p className="mt-1 font-serif text-lg font-semibold text-foreground">
                {comparison.test.p < 0.05 ? "Significant" : "Not significant"}
              </p>
              <p className="text-[11px] text-muted">
                p={formatP(comparison.test.p)}, Cohen&apos;s d={comparison.test.cohensD.toFixed(2)}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-muted">Not enough data in one or both cohorts.</p>
          )}
        </div>
      </div>

      <div
        className={`rounded-md border px-3 py-2 text-xs ${
          checkedSubgroups === 0
            ? "border-border bg-background text-muted"
            : consistency.consistent
              ? "border-teal/30 bg-teal/10 text-teal"
              : "border-danger/30 bg-danger/10 text-danger"
        }`}
      >
        {checkedSubgroups === 0
          ? "Not checked: no age subgroup has enough patients in both cohorts to compare, so the pooled result above stands on its own."
          : consistency.consistent
            ? `Consistent: every age subgroup with enough data agrees with the pooled result (${DIRECTION_LABEL[consistency.pooledDirection]}).`
            : `Inconsistent: at least one age subgroup disagrees with the pooled result (${DIRECTION_LABEL[consistency.pooledDirection]}).`}
      </div>
    </ChartCard>
  );
}
