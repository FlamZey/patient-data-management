"use client";

import { ChartEmpty, ChartSurface, useChartTooltip } from "@/components/charts/ChartFrame";
import {
  AXIS_COLOR,
  CATEGORICAL,
  GRID_COLOR,
  SURFACE_COLOR,
  formatNumber,
  niceTicks,
} from "@/components/charts/chart-theme";
import type { BoxStats } from "@/lib/analytics";

interface BoxPlotProps {
  data: BoxStats[];
  valueLabel: string;
  emptyMessage: string;
  height?: number;
  // Groups thinner than this are dropped rather than drawn -- a "box" over
  // 3 patients is visual noise that reads as a real distribution.
  minGroupSize?: number;
}

const WIDTH = 520;
const PADDING_LEFT = 44;
const PADDING_TOP = 8;
// Past this many groups, horizontal centered labels start to collide with
// their neighbors regardless of truncation -- rotating removes the overlap
// instead of shortening labels until they're unreadable.
const ROTATE_LABELS_PAST = 4;

function truncate(label: string, maxChars: number): string {
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
}

export default function BoxPlot({
  data,
  valueLabel,
  emptyMessage,
  height = 260,
  minGroupSize = 5,
}: BoxPlotProps) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useChartTooltip();

  const groups = data.filter((group) => group.n >= minGroupSize);
  if (groups.length === 0) return <ChartEmpty message={emptyMessage} />;

  const shouldRotateLabels = groups.length > ROTATE_LABELS_PAST;
  // Rotated labels need more vertical room than one horizontal line does.
  const paddingBottom = shouldRotateLabels ? 46 : 34;
  const plotHeight = height - paddingBottom - PADDING_TOP;
  const plotWidth = WIDTH - PADDING_LEFT - 8;
  const low = Math.min(...groups.map((group) => group.min));
  const high = Math.max(...groups.map((group) => group.max));
  const span = high - low || 1;
  // A little headroom so the extreme whiskers aren't flush with the frame.
  const axisLow = low - span * 0.08;
  const axisHigh = high + span * 0.08;
  const ticks = niceTicks(axisLow, axisHigh, 4);

  const yAt = (value: number) =>
    PADDING_TOP + plotHeight - ((value - axisLow) / (axisHigh - axisLow)) * plotHeight;

  const slot = plotWidth / groups.length;
  const boxWidth = Math.min(46, slot * 0.55);

  return (
    <ChartSurface containerRef={containerRef} tooltip={tooltip}>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`${valueLabel} distribution by group`}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PADDING_LEFT} x2={WIDTH - 8} y1={yAt(tick)} y2={yAt(tick)} stroke={GRID_COLOR} strokeWidth={1} />
            <text
              x={PADDING_LEFT - 6}
              y={yAt(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted"
              style={{ fontSize: 10 }}
            >
              {formatNumber(tick, 0)}
            </text>
          </g>
        ))}
        <line
          x1={PADDING_LEFT}
          x2={WIDTH - 8}
          y1={PADDING_TOP + plotHeight}
          y2={PADDING_TOP + plotHeight}
          stroke={AXIS_COLOR}
          strokeWidth={1}
        />

        {groups.map((group, index) => {
          const center = PADDING_LEFT + index * slot + slot / 2;
          const left = center - boxWidth / 2;
          const boxTop = yAt(group.q3);
          const boxBottom = yAt(group.q1);

          return (
            <g
              key={group.label}
              onMouseMove={(event) =>
                showTooltip(event, [
                  group.label,
                  `Median ${formatNumber(group.median, 1)}`,
                  `IQR ${formatNumber(group.q1, 1)} – ${formatNumber(group.q3, 1)}`,
                  `Range ${formatNumber(group.min, 1)} – ${formatNumber(group.max, 1)}`,
                  `n = ${formatNumber(group.n, 0)}`,
                ])
              }
              onMouseLeave={hideTooltip}
            >
              <rect
                x={PADDING_LEFT + index * slot}
                y={PADDING_TOP}
                width={slot}
                height={plotHeight}
                fill="transparent"
              />
              {/* Whiskers reach the furthest point within 1.5x IQR (Tukey),
                  computed in boxStatsFor -- not the absolute min/max. */}
              <line
                x1={center}
                x2={center}
                y1={yAt(group.max)}
                y2={boxTop}
                stroke={AXIS_COLOR}
                strokeWidth={1}
              />
              <line
                x1={center}
                x2={center}
                y1={boxBottom}
                y2={yAt(group.min)}
                stroke={AXIS_COLOR}
                strokeWidth={1}
              />
              <line
                x1={center - boxWidth / 4}
                x2={center + boxWidth / 4}
                y1={yAt(group.max)}
                y2={yAt(group.max)}
                stroke={AXIS_COLOR}
                strokeWidth={1}
              />
              <line
                x1={center - boxWidth / 4}
                x2={center + boxWidth / 4}
                y1={yAt(group.min)}
                y2={yAt(group.min)}
                stroke={AXIS_COLOR}
                strokeWidth={1}
              />

              <rect
                x={left}
                y={boxTop}
                width={boxWidth}
                height={Math.max(2, boxBottom - boxTop)}
                rx={3}
                fill={CATEGORICAL[0]}
                fillOpacity={0.55}
                stroke={CATEGORICAL[0]}
                strokeWidth={1}
              />
              {/* Median drawn in the surface color so it reads against the
                  box fill rather than disappearing into it. */}
              <line
                x1={left}
                x2={left + boxWidth}
                y1={yAt(group.median)}
                y2={yAt(group.median)}
                stroke={SURFACE_COLOR}
                strokeWidth={2}
              />

              {/* Past ~4 groups, horizontal centered labels start to overlap
                  their neighbors regardless of truncation length -- rotating
                  removes the collision instead of fighting it with shorter
                  and shorter ellipsis. Sample size moved into the tooltip
                  (already shown there) rather than a second always-visible
                  line, which was adding clutter this chart doesn't need. */}
              {shouldRotateLabels ? (
                <text
                  x={center}
                  y={PADDING_TOP + plotHeight + 8}
                  textAnchor="end"
                  className="fill-muted"
                  style={{ fontSize: 10 }}
                  transform={`rotate(-35 ${center} ${PADDING_TOP + plotHeight + 8})`}
                >
                  {truncate(group.label, 16)}
                </text>
              ) : (
                <text
                  x={center}
                  y={PADDING_TOP + plotHeight + 14}
                  textAnchor="middle"
                  className="fill-muted"
                  style={{ fontSize: 10 }}
                >
                  {truncate(group.label, 12)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </ChartSurface>
  );
}
