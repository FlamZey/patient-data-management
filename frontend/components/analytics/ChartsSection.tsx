"use client";

// Phase 2: the visualisations. Every chart here is bound to a field that
// actually exists in the patient record -- where the original brief asked for
// something the schema has no column for (admissions, lab values, length of
// stay), the nearest real equivalent is charted instead and the card says so.

import { useMemo, useState } from "react";

import BarChart from "@/components/charts/BarChart";
import BoxPlot from "@/components/charts/BoxPlot";
import { ChartCard } from "@/components/charts/ChartFrame";
import CorrelationHeatmap, { type CorrelationCell } from "@/components/charts/CorrelationHeatmap";
import DonutChart from "@/components/charts/DonutChart";
import LineChart from "@/components/charts/LineChart";
import ScatterChart from "@/components/charts/ScatterChart";
import { formatNumber, formatPercent } from "@/components/charts/chart-theme";
import {
  AGE_BRACKETS,
  NUMERIC_FIELDS,
  boxStatsFor,
  bmiCategoryOf,
  countBy,
  countByOrdered,
  histogram,
  meanOf,
  monthlySeries,
  pairsFor,
  pearson,
  type AnalyticsRow,
  type TargetVariable,
} from "@/lib/analytics";

const BMI_CATEGORIES = ["Underweight", "Normal", "Overweight", "Obese"] as const;

const selectClass =
  "rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground focus:border-accent focus:outline-none";

interface ChartsSectionProps {
  rows: AnalyticsRow[];
  target: TargetVariable;
}

export default function ChartsSection({ rows, target }: ChartsSectionProps) {
  const [histogramField, setHistogramField] = useState("age");
  const [binCount, setBinCount] = useState(20);
  const [boxGroupField, setBoxGroupField] = useState("smokingStatus");
  const [scatterX, setScatterX] = useState("age");
  const [scatterY, setScatterY] = useState("systolicBp");

  // --- pie/donut: three genuine part-to-whole splits ---
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
  // The selected target is what makes this chart answer a different question
  // each time rather than being a fixed "conditions by age" bar.
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

  // --- box plot: a numeric distribution compared across a categorical ---
  const boxGroups = useMemo(() => {
    const accessor = (row: AnalyticsRow) =>
      boxGroupField === "smokingStatus"
        ? row.smokingStatus
        : boxGroupField === "ageBracket"
          ? row.ageBracket
          : boxGroupField === "careDepartment"
            ? row.careDepartment
            : row.bloodType;

    const grouped = new Map<string, number[]>();
    for (const row of rows) {
      const key = accessor(row);
      if (key == null || row.systolicBp == null) continue;
      // Excluded per the quality panel: an inverted reading isn't a real
      // measurement, so it must not shift a group's median.
      if (row.diastolicBp != null && row.diastolicBp >= row.systolicBp) continue;
      const bucket = grouped.get(key);
      if (bucket) bucket.push(row.systolicBp);
      else grouped.set(key, [row.systolicBp]);
    }

    const order =
      boxGroupField === "ageBracket"
        ? [...AGE_BRACKETS]
        : [...grouped.keys()].sort((a, b) => (grouped.get(b)?.length ?? 0) - (grouped.get(a)?.length ?? 0));

    return order
      .map((label) => boxStatsFor(label, grouped.get(label) ?? []))
      .filter((stats): stats is NonNullable<typeof stats> => stats != null)
      .slice(0, 8);
  }, [rows, boxGroupField]);

  // --- scatter ---
  const scatterFieldX = NUMERIC_FIELDS.find((field) => field.key === scatterX) ?? NUMERIC_FIELDS[0];
  const scatterFieldY = NUMERIC_FIELDS.find((field) => field.key === scatterY) ?? NUMERIC_FIELDS[1];
  const scatterPairs = useMemo(
    () => pairsFor(rows, scatterFieldX.valueOf, scatterFieldY.valueOf),
    [rows, scatterFieldX, scatterFieldY],
  );

  // --- histogram ---
  const histogramFieldDef =
    NUMERIC_FIELDS.find((field) => field.key === histogramField) ?? NUMERIC_FIELDS[0];
  const histogramBars = useMemo(() => {
    const values = rows
      .map(histogramFieldDef.valueOf)
      .filter((value): value is number => value != null && Number.isFinite(value));
    return histogram(values, binCount).map((bin) => ({
      label: formatNumber(bin.start, bin.end - bin.start < 2 ? 1 : 0),
      value: bin.count,
      detail: `${formatNumber(bin.start, 1)} to ${formatNumber(bin.end, 1)}`,
    }));
  }, [rows, histogramFieldDef, binCount]);

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

  const bmiSplit = useMemo(
    () => countByOrdered(rows, (row) => bmiCategoryOf(row.bmi), BMI_CATEGORIES),
    [rows],
  );

  const targetUnit = target.kind === "binary" ? "% of patients" : "average count";

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard
        title="Gender split"
        subtitle="Share of patients by recorded gender."
        footnote="Patients with no gender on file are excluded from this split."
      >
        <DonutChart data={genderSplit} emptyMessage="No gender values on file." />
      </ChartCard>

      <ChartCard
        title="Care department split"
        subtitle="Which department each patient is filed under."
        footnote="Departments past the top five are folded into “Other” — adding more colours past that point makes the chart harder to read, not more informative."
      >
        <DonutChart data={departmentSplit} emptyMessage="No care department values on file." />
      </ChartCard>

      <ChartCard
        title={`${target.label} by age bracket`}
        subtitle={`${target.kind === "binary" ? "Percentage of patients" : "Average per patient"}, split by age. Change the target above to re-cut this chart.`}
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
        footnote="The brief asked for admissions over time; the record has no encounter or admission table, so registration date — the one real time series on file — is charted instead."
      >
        <LineChart
          data={registrationTrend}
          valueLabel="Registrations"
          emptyMessage="No registration dates on file, so there's no time series to plot."
        />
      </ChartCard>

      <ChartCard
        title="Systolic BP distribution by group"
        subtitle="Median, interquartile range, and 1.5×IQR whiskers per group."
        controls={
          <select
            className={selectClass}
            value={boxGroupField}
            onChange={(event) => setBoxGroupField(event.target.value)}
            aria-label="Group blood pressure by"
          >
            <option value="smokingStatus">Smoking status</option>
            <option value="ageBracket">Age bracket</option>
            <option value="careDepartment">Care department</option>
            <option value="bloodType">Blood type</option>
          </select>
        }
        footnote="Groups with fewer than 5 patients are omitted — a box drawn over a handful of readings looks like a distribution but isn't one. Readings where diastolic ≥ systolic are excluded."
      >
        <BoxPlot
          data={boxGroups}
          valueLabel="Systolic BP"
          emptyMessage="Needs both blood pressure readings and the selected grouping field."
        />
      </ChartCard>

      <ChartCard
        title="Relationship between two measures"
        subtitle="Each dot is one patient; the line is an ordinary least-squares fit."
        controls={
          <div className="flex gap-1.5">
            <select
              className={selectClass}
              value={scatterX}
              onChange={(event) => setScatterX(event.target.value)}
              aria-label="Horizontal axis field"
            >
              {NUMERIC_FIELDS.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>
            <select
              className={selectClass}
              value={scatterY}
              onChange={(event) => setScatterY(event.target.value)}
              aria-label="Vertical axis field"
            >
              {NUMERIC_FIELDS.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>
          </div>
        }
        footnote="r and the trendline are computed on every complete pair; only the plotted dots are sampled down when the dataset is large, so the statistics don't depend on the sample."
      >
        <ScatterChart
          pairs={scatterPairs}
          xLabel={scatterFieldX.label}
          yLabel={scatterFieldY.label}
          emptyMessage="Not enough patients have both of these values on file."
        />
      </ChartCard>

      <ChartCard
        title="Distribution"
        subtitle={`How ${histogramFieldDef.label.toLowerCase()} is spread across the patient population.`}
        controls={
          <div className="flex gap-1.5">
            <select
              className={selectClass}
              value={histogramField}
              onChange={(event) => setHistogramField(event.target.value)}
              aria-label="Histogram field"
            >
              {NUMERIC_FIELDS.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>
            <select
              className={selectClass}
              value={binCount}
              onChange={(event) => setBinCount(Number(event.target.value))}
              aria-label="Number of bins"
            >
              {[10, 15, 20, 30].map((count) => (
                <option key={count} value={count}>
                  {count} bins
                </option>
              ))}
            </select>
          </div>
        }
        footnote="Bin width changes the shape a histogram shows, so the bin count is adjustable rather than fixed at one value."
      >
        <BarChart
          data={histogramBars}
          valueLabel="Patients"
          orientation="vertical"
          height={240}
          emptyMessage={`No ${histogramFieldDef.label.toLowerCase()} values on file.`}
          formatValue={(value) => formatNumber(value, 0)}
        />
      </ChartCard>

      <ChartCard
        title="BMI category"
        subtitle="Derived from height and weight, using standard WHO cut-points."
        footnote="An ordered scale, so these stay in clinical order rather than being sorted by size. Patients missing height or weight are excluded."
      >
        <BarChart
          data={bmiSplit.map((bucket) => ({
            label: bucket.label,
            value: bucket.count,
            detail: formatPercent(bucket.count, rows.length),
          }))}
          valueLabel="Patients"
          orientation="vertical"
          height={220}
          emptyMessage="Needs both height and weight to derive BMI."
          formatValue={(value) => formatNumber(value, 0)}
        />
      </ChartCard>

      <ChartCard
        title="Correlation between numeric fields"
        subtitle="Pearson r for every pair, computed on patients who have both values."
        footnote="Correlation is not causation, and r says nothing about significance on its own — a weak r over thousands of patients and a strong r over a dozen look identical here. Hover any cell for its sample size."
      >
        <CorrelationHeatmap
          labels={correlation.labels}
          cells={correlation.cells}
          emptyMessage="No numeric fields on file to correlate."
        />
      </ChartCard>
    </div>
  );
}
