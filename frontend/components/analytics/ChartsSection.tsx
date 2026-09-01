"use client";

// The visualisations: six charts bound to fields that actually exist in the
// patient record. Read-only -- no per-chart pickers -- so every chart here
// is a fixed cut of the data rather than one end of a control.

import { useMemo } from "react";

import BarChart from "@/components/charts/BarChart";
import { ChartCard } from "@/components/charts/ChartFrame";
import CorrelationHeatmap, { type CorrelationCell } from "@/components/charts/CorrelationHeatmap";
import LineChart from "@/components/charts/LineChart";
import ShareBars from "@/components/charts/ShareBars";
import { NEUTRAL, RANK_RAMP, formatNumber } from "@/components/charts/chart-theme";
import {
  AGE_BRACKETS,
  NUMERIC_FIELDS,
  bmiCategoryOf,
  countBy,
  countByOrdered,
  meanOf,
  monthlySeries,
  pairsFor,
  pearson,
  type AnalyticsRow,
  type TargetVariable,
} from "@/lib/analytics";

const BMI_CATEGORIES = ["Underweight", "Normal", "Overweight", "Obese"] as const;

// Colored by clinical meaning, not by rank: "Normal" is the reference
// category and gets the brightest step regardless of its share, matching the
// design mockup this dashboard is built from (Underweight and Obese -- the
// two extremes -- read as muted, not as "large" or "small").
const BMI_COLORS: Record<(typeof BMI_CATEGORIES)[number], string> = {
  Underweight: NEUTRAL,
  Normal: RANK_RAMP[0],
  Overweight: RANK_RAMP[1],
  Obese: RANK_RAMP[2],
};

interface ChartsSectionProps {
  rows: AnalyticsRow[];
  target: TargetVariable;
}

export default function ChartsSection({ rows, target }: ChartsSectionProps) {
  // --- two genuine part-to-whole splits ---
  const genderSplit = useMemo(
    () => countBy(rows, (row) => row.gender, 5).map((bucket) => ({ label: bucket.label, value: bucket.count })),
    [rows],
  );
  const departmentSplit = useMemo(
    () =>
      countBy(rows, (row) => row.careDepartment, 5).map((bucket) => ({
        label: bucket.label,
        value: bucket.count,
      })),
    [rows],
  );

  // --- target rate by age bracket ---
  const targetByAge = useMemo(() => {
    return AGE_BRACKETS.map((bracket) => {
      const inBracket = rows.filter((row) => row.ageBracket === bracket);
      const values = inBracket
        .map((row) => target.valueOf(row))
        .filter((value): value is number => value != null);
      const mean = meanOf(values);
      return {
        label: bracket,
        value: mean == null ? 0 : target.kind === "binary" ? mean * 100 : mean,
        detail: `${formatNumber(values.length, 0)} patients with this measure on file`,
      };
    });
  }, [rows, target]);

  // --- registrations over time ---
  const registrationTrend = useMemo(
    () => monthlySeries(rows, (row) => row.registrationMonth).map((point) => ({ label: point.month, value: point.count })),
    [rows],
  );

  // --- BMI category ---
  const bmiSplit = useMemo(
    () =>
      countByOrdered(rows, (row) => bmiCategoryOf(row.bmi), BMI_CATEGORIES).map((bucket) => ({
        label: bucket.label,
        value: bucket.count,
        color: BMI_COLORS[bucket.label as (typeof BMI_CATEGORIES)[number]],
      })),
    [rows],
  );

  // --- correlation heatmap ---
  const correlation = useMemo(() => {
    const labels = NUMERIC_FIELDS.map((field) => field.label);
    const cells: CorrelationCell[] = [];
    for (const yField of NUMERIC_FIELDS) {
      for (const xField of NUMERIC_FIELDS) {
        const pairs = pairsFor(rows, xField.valueOf, yField.valueOf);
        cells.push({
          xLabel: xField.label,
          yLabel: yField.label,
          r: pairs.length >= 3 ? pearson(pairs) : null,
          n: pairs.length,
        });
      }
    }
    return { labels, cells };
  }, [rows]);

  const targetUnit = target.kind === "binary" ? "% of patients" : "average count";

  return (
    <div>
      <p className="mb-3 text-xs text-muted">
        Target variable: {target.label.toLowerCase()} ({target.kind}).
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard
          title="Gender split"
          subtitle="Share of patients by recorded gender."
          footnote="Patients with no gender on file are excluded from this split."
        >
          <ShareBars data={genderSplit} emptyMessage="No gender values on file." />
        </ChartCard>

        <ChartCard
          title="Care department split"
          subtitle="Which department each patient is filed under."
          footnote="Departments past the top five are folded into “Other” — adding more colours past that point makes the chart harder to read, not more informative."
        >
          <ShareBars data={departmentSplit} emptyMessage="No care department values on file." />
        </ChartCard>

        {/* Worded around the target's label rather than prefixing it raw: the
            labels are noun phrases ("a chronic condition", "obesity"), so
            "{label} by age bracket" reads as a fragment for some of them. */}
        <ChartCard
          title={
            target.kind === "binary"
              ? `Share of patients with ${target.label.toLowerCase()}, by age bracket`
              : `Average ${target.label.toLowerCase()} by age bracket`
          }
          subtitle={target.kind === "binary" ? "Percentage of patients, split by age." : "Average per patient, split by age."}
          footnote={target.description}
        >
          <BarChart
            data={targetByAge}
            valueLabel={targetUnit}
            orientation="vertical"
            emptyMessage="No ages on file, so patients can't be bracketed."
            formatValue={(value) => (target.kind === "binary" ? `${value.toFixed(1)}%` : value.toFixed(2))}
          />
        </ChartCard>

        <ChartCard
          title="Registrations over time"
          subtitle="New patient registrations per month."
          footnote="The one real time series on file -- there is no separate encounter or admission table."
        >
          <LineChart
            data={registrationTrend}
            valueLabel="Registrations"
            emptyMessage="No registration dates on file, so there's no time series to plot."
          />
        </ChartCard>

        <ChartCard
          title="BMI category"
          subtitle="Derived from height and weight, using standard WHO cut-points."
          footnote="An ordered scale, so these stay in clinical order rather than being sorted by size. Patients missing height or weight are excluded."
        >
          <ShareBars data={bmiSplit} emptyMessage="Needs both height and weight to derive BMI." />
        </ChartCard>

        <ChartCard
          title="Correlation between numeric fields"
          subtitle="Pearson r for every pair, computed on patients who have both values."
          footnote="Correlation is not causation, and r says nothing about significance on its own. Hover any cell for its sample size."
        >
          <CorrelationHeatmap
            labels={correlation.labels}
            cells={correlation.cells}
            emptyMessage="No numeric fields on file to correlate."
          />
        </ChartCard>
      </div>
    </div>
  );
}
