"use client";

import {
  ChartEmpty,
  ChartLegend,
  ChartSurface,
  useChartTooltip,
} from "@/components/charts/ChartFrame";
import { SURFACE_COLOR, categoricalColor, formatNumber } from "@/components/charts/chart-theme";

export interface SliceDatum {
  label: string;
  value: number;
}

interface DonutChartProps {
  data: SliceDatum[];
  emptyMessage: string;
  // What one unit is, for the tooltip ("patients").
  unitLabel?: string;
}

const SIZE = 200;
const RADIUS = 84;
const INNER_RADIUS = 52;
// A 2px surface-colored ring between slices, so adjacent fills never touch.
const SLICE_GAP_STROKE = 2;

function polarToCartesian(angleRadians: number, radius: number): [number, number] {
  return [SIZE / 2 + radius * Math.cos(angleRadians), SIZE / 2 + radius * Math.sin(angleRadians)];
}

// Standard SVG donut-segment path: outer arc forward, inner arc back.
function arcPath(startAngle: number, endAngle: number): string {
  const [outerStartX, outerStartY] = polarToCartesian(startAngle, RADIUS);
  const [outerEndX, outerEndY] = polarToCartesian(endAngle, RADIUS);
  const [innerEndX, innerEndY] = polarToCartesian(endAngle, INNER_RADIUS);
  const [innerStartX, innerStartY] = polarToCartesian(startAngle, INNER_RADIUS);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M ${outerStartX} ${outerStartY}`,
    `A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${outerEndX} ${outerEndY}`,
    `L ${innerEndX} ${innerEndY}`,
    `A ${INNER_RADIUS} ${INNER_RADIUS} 0 ${largeArc} 0 ${innerStartX} ${innerStartY}`,
    "Z",
  ].join(" ");
}

// A donut rather than a pie: the hole carries the total, which is the number
// readers usually want alongside the split, and the ring makes small slices
// easier to compare than wedges converging on a point.
export default function DonutChart({ data, emptyMessage, unitLabel = "patients" }: DonutChartProps) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useChartTooltip();

  const total = data.reduce((sum, slice) => sum + slice.value, 0);
  if (data.length === 0 || total === 0) return <ChartEmpty message={emptyMessage} />;

  // Cumulative offsets are precomputed rather than accumulated inside the
  // map: mutating a variable across map iterations during render is exactly
  // what React Compiler's immutability rule forbids.
  const offsets = data.reduce<number[]>(
    (running, slice) => [...running, running[running.length - 1] + slice.value],
    [0],
  );
  const slices = data.map((slice, index) => {
    // -PI/2 puts the first slice's edge at 12 o'clock.
    const startAngle = -Math.PI / 2 + (offsets[index] / total) * Math.PI * 2;
    const endAngle = -Math.PI / 2 + (offsets[index + 1] / total) * Math.PI * 2;
    return { ...slice, path: arcPath(startAngle, endAngle), color: categoricalColor(index) };
  });

  return (
    <div className="flex flex-col items-center">
      <ChartSurface containerRef={containerRef} tooltip={tooltip}>
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="w-full"
          style={{ maxHeight: SIZE }}
          role="img"
          aria-label="Distribution"
        >
          {slices.map((slice) => (
            <path
              key={slice.label}
              d={slice.path}
              fill={slice.color}
              stroke={SURFACE_COLOR}
              strokeWidth={SLICE_GAP_STROKE}
              onMouseMove={(event) =>
                showTooltip(event, [
                  slice.label,
                  `${formatNumber(slice.value, 0)} ${unitLabel}`,
                  `${((100 * slice.value) / total).toFixed(1)}% of total`,
                ])
              }
              onMouseLeave={hideTooltip}
            />
          ))}
          <text
            x={SIZE / 2}
            y={SIZE / 2 - 4}
            textAnchor="middle"
            className="fill-foreground"
            style={{ fontSize: 18, fontWeight: 600 }}
          >
            {formatNumber(total, 0)}
          </text>
          <text
            x={SIZE / 2}
            y={SIZE / 2 + 12}
            textAnchor="middle"
            className="fill-muted"
            style={{ fontSize: 10 }}
          >
            {unitLabel}
          </text>
        </svg>
      </ChartSurface>
      <ChartLegend
        items={slices.map((slice) => ({
          // The legend carries the share too, so the split is readable
          // without hovering every slice.
          label: `${slice.label} · ${((100 * slice.value) / total).toFixed(1)}%`,
          color: slice.color,
        }))}
      />
    </div>
  );
}
