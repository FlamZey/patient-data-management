"use client";

// A part-to-whole breakdown as labeled percentage bars rather than a donut --
// the pattern the design mockup this dashboard is built from uses for every
// multi-category split (gender, care department, BMI category): a label, its
// share of the total, and a thin track filled to that percentage. Plain divs
// like DataOverview's coverage bars, not an SVG chart -- there's no axis or
// hover geometry here, just a filled rectangle per row.

import { ChartEmpty } from "@/components/charts/ChartFrame";
import { rankOrNeutralColor } from "@/components/charts/chart-theme";

export interface ShareDatum {
  label: string;
  value: number;
  // Overrides the default rank-by-position color -- for a chart whose order
  // is semantic rather than sorted by size (BMI category's clinical order),
  // the caller supplies a fixed color per category instead.
  color?: string;
}

interface ShareBarsProps {
  data: ShareDatum[];
  emptyMessage: string;
}

export default function ShareBars({ data, emptyMessage }: ShareBarsProps) {
  const total = data.reduce((sum, datum) => sum + datum.value, 0);
  if (data.length === 0 || total === 0) return <ChartEmpty message={emptyMessage} />;

  return (
    <div className="flex flex-col gap-3">
      {data.map((datum, index) => {
        const percent = (100 * datum.value) / total;
        const color = datum.color ?? rankOrNeutralColor(datum.label, index);
        return (
          <div key={datum.label}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-xs text-foreground">{datum.label}</span>
              {/* A category under half a percent still draws a visible bar,
                  so rounding it to a flat "0%" would contradict the row it
                  labels -- those get a decimal, everything else stays whole
                  the way the design shows it. */}
              <span className="font-mono text-[11px] text-muted">
                {percent < 0.5 ? percent.toFixed(1) : percent.toFixed(0)}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-background">
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.max(percent, percent > 0 ? 1.5 : 0)}%`, backgroundColor: color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
