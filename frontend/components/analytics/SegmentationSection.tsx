"use client";

// The rest of Phase 4: directly comparing two chosen cohorts, and checking
// whether that comparison actually holds within every subgroup or only
// appears in the pooled numbers (a Simpson's-paradox-shaped reversal). The
// global filter bar (narrowing every tab to a subgroup) lives in
// SegmentFilterBar.tsx / PatientAnalysis.tsx -- this is the dedicated
// side-by-side view on top of whatever that bar has already narrowed to.

import { useMemo, useState } from "react";

import { ChartCard, ChartEmpty } from "@/components/charts/ChartFrame";
import { formatNumber } from "@/components/charts/chart-theme";
import { NUMERIC_FIELDS, type AnalyticsRow } from "@/lib/analytics";
import {
  SEGMENT_FIELD_ACCESSORS,
  SEGMENT_FILTER_FIELDS,
  checkSubgroupConsistency,
  compareCohorts,
  filterOptionsFor,
  type SegmentFilters,
} from "@/lib/segmentation";

const selectClass =
  "rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground focus:border-accent focus:outline-none";

interface SegmentationSectionProps {
  rows: AnalyticsRow[];
}

function formatP(p: number): string {
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

const DIRECTION_LABEL: Record<string, string> = {
  higher: "Cohort A higher",
  lower: "Cohort B higher",
  "no-difference": "No difference",
  "insufficient-data": "Not enough data",
};

export default function SegmentationSection({ rows }: SegmentationSectionProps) {
  const [splitField, setSplitField] = useState<keyof SegmentFilters>("smokingStatus");
  const splitOptions = useMemo(() => filterOptionsFor(rows, splitField), [rows, splitField]);
  const [cohortAValue, setCohortAValue] = useState<string>("");
  const [cohortBValue, setCohortBValue] = useState<string>("");
  const [numericFieldKey, setNumericFieldKey] = useState("systolicBp");
  // Defaults to a different field than the split, so the first render isn't
  // the degenerate case of checking consistency across the same field the
  // cohorts were carved out of (every subgroup would trivially be 100% one
  // cohort or the other).
  const [consistencyField, setConsistencyField] = useState<keyof SegmentFilters>("ageBracket");

  const resolvedA = cohortAValue || splitOptions[0] || "";
  const resolvedB = cohortBValue || splitOptions[1] || splitOptions[0] || "";
  const splitAccessor = SEGMENT_FIELD_ACCESSORS[splitField];
  const numericField = NUMERIC_FIELDS.find((field) => field.key === numericFieldKey) ?? NUMERIC_FIELDS[0];

  const cohortARows = useMemo(
    () => rows.filter((row) => splitAccessor(row) === resolvedA),
    [rows, splitAccessor, resolvedA],
  );
  const cohortBRows = useMemo(
    () => rows.filter((row) => splitAccessor(row) === resolvedB),
    [rows, splitAccessor, resolvedB],
  );

  const comparison = useMemo(
    () => compareCohorts(cohortARows, cohortBRows, numericField.valueOf),
    [cohortARows, cohortBRows, numericField],
  );

  // consistencyField isn't reset when splitField changes, so the two can end
  // up equal (e.g. user sets "Split by" to the field the check was already
  // using) -- checking consistency by the same field the cohorts were split
  // on partitions them into disjoint subgroups, making every row read
  // "insufficient data" while the summary banner still claims "Consistent"
  // (vacuously true over zero real comparisons). Falling back the same way
  // resolvedA/resolvedB do keeps the select, the accessor, and the banner in
  // agreement no matter how the two fields ended up matching.
  const consistencyFieldOptions = SEGMENT_FILTER_FIELDS.filter((field) => field.key !== splitField);
  const resolvedConsistencyField =
    consistencyFieldOptions.find((field) => field.key === consistencyField)?.key ??
    consistencyFieldOptions[0]?.key ??
    consistencyField;
  const consistencyAccessor = SEGMENT_FIELD_ACCESSORS[resolvedConsistencyField];
  const consistency = useMemo(
    () => checkSubgroupConsistency(cohortARows, cohortBRows, numericField.valueOf, consistencyAccessor),
    [cohortARows, cohortBRows, numericField, consistencyAccessor],
  );

  const sameCohort = resolvedA !== "" && resolvedA === resolvedB;

  return (
    <div className="space-y-4">
      <ChartCard
        title="Compare two cohorts"
        subtitle="Pick a field to split by, then two of its values to compare directly."
        footnote="Uses Welch's t-test -- the same method Phase 3 uses for a binary target, applied here to two cohorts you choose instead of a fixed outcome."
      >
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-muted uppercase">Split by</span>
            <select
              className={selectClass}
              value={splitField}
              onChange={(event) => {
                const key = event.target.value as keyof SegmentFilters;
                setSplitField(key);
                setCohortAValue("");
                setCohortBValue("");
              }}
            >
              {SEGMENT_FILTER_FIELDS.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-muted uppercase">Cohort A</span>
            <select className={selectClass} value={resolvedA} onChange={(event) => setCohortAValue(event.target.value)}>
              {splitOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-muted uppercase">Cohort B</span>
            <select className={selectClass} value={resolvedB} onChange={(event) => setCohortBValue(event.target.value)}>
              {splitOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-muted uppercase">Compare</span>
            <select
              className={selectClass}
              value={numericFieldKey}
              onChange={(event) => setNumericFieldKey(event.target.value)}
            >
              {NUMERIC_FIELDS.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {sameCohort ? (
          <ChartEmpty message="Pick two different values to compare." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-[10px] text-muted uppercase">Cohort A · {resolvedA}</p>
              <p className="mt-1 font-serif text-lg font-semibold text-foreground">
                {comparison.cohortA.mean != null ? formatNumber(comparison.cohortA.mean, 1) : "—"}
              </p>
              <p className="text-[11px] text-muted">n = {formatNumber(comparison.cohortA.n, 0)}</p>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <p className="text-[10px] text-muted uppercase">Cohort B · {resolvedB}</p>
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
        )}
      </ChartCard>

      <ChartCard
        title="Does it hold across subgroups?"
        subtitle="Re-checks the same cohort comparison within each level of another field, to catch a result that only appears when everyone is pooled together."
        controls={
          <select
            className={selectClass}
            value={resolvedConsistencyField}
            onChange={(event) => setConsistencyField(event.target.value as keyof SegmentFilters)}
          >
            {consistencyFieldOptions.map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </select>
        }
        footnote="A subgroup needs at least 10 patients in both cohorts to be checked; smaller ones are marked instead of guessed at."
      >
        {sameCohort ? (
          <ChartEmpty message="Pick two different cohort values above first." />
        ) : (
          <>
            <div
              className={`mb-3 rounded-md border px-3 py-2 text-xs ${
                consistency.consistent
                  ? "border-teal/30 bg-teal/10 text-teal"
                  : "border-danger/30 bg-danger/10 text-danger"
              }`}
            >
              {consistency.consistent
                ? `Consistent: every subgroup with enough data agrees with the pooled result (${DIRECTION_LABEL[consistency.pooledDirection]}).`
                : `Inconsistent: at least one subgroup disagrees with the pooled result (${DIRECTION_LABEL[consistency.pooledDirection]}) -- see below.`}
            </div>
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] tracking-wide text-muted uppercase">
                  <th className="pb-1.5 font-normal">Subgroup</th>
                  <th className="pb-1.5 text-right font-normal">Cohort A</th>
                  <th className="pb-1.5 text-right font-normal">Cohort B</th>
                  <th className="pb-1.5 text-right font-normal">n</th>
                  <th className="pb-1.5 text-right font-normal">Result</th>
                </tr>
              </thead>
              <tbody>
                {consistency.outcomes.map((outcome) => (
                  <tr key={outcome.subgroup} className="border-t border-border">
                    <td className="py-1.5 text-xs text-foreground">{outcome.subgroup}</td>
                    <td className="py-1.5 text-right font-mono text-xs text-muted">
                      {outcome.cohortAMean != null ? formatNumber(outcome.cohortAMean, 1) : "—"}
                    </td>
                    <td className="py-1.5 text-right font-mono text-xs text-muted">
                      {outcome.cohortBMean != null ? formatNumber(outcome.cohortBMean, 1) : "—"}
                    </td>
                    <td className="py-1.5 text-right font-mono text-xs text-muted">
                      {formatNumber(outcome.n, 0)}
                    </td>
                    <td
                      className={`py-1.5 text-right text-xs ${
                        outcome.direction !== "insufficient-data" &&
                        outcome.direction !== "no-difference" &&
                        outcome.direction !== consistency.pooledDirection
                          ? "font-medium text-danger"
                          : "text-muted"
                      }`}
                    >
                      {DIRECTION_LABEL[outcome.direction]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </ChartCard>
    </div>
  );
}
