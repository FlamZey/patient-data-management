"use client";

import { useMemo, useState } from "react";

import { ChartEmpty, ChartSurface, useChartTooltip } from "@/components/charts/ChartFrame";
import {
  AXIS_COLOR,
  CATEGORICAL,
  GRID_COLOR,
  SURFACE_COLOR,
  formatNumber,
  niceAxis,
} from "@/components/charts/chart-theme";

export interface LinePoint {
  label: string;
  value: number;
}

interface LineChartProps {
  data: LinePoint[];
  valueLabel: string;
  emptyMessage: string;
  // Rolling mean window in points; 0 disables it. A monthly count series is
  // noisy enough that the trend is hard to see without one.
  smoothingWindow?: number;
  height?: number;
}

const WIDTH = 520;
const PADDING_LEFT = 38;
const PADDING_BOTTOM = 26;
const PADDING_TOP = 8;

function rollingMean(values: number[], window: number): (number | null)[] {
  if (window <= 1) return values;
  return values.map((_, index) => {
    if (index < window - 1) return null; // no full window yet -- don't fake one
    let sum = 0;
    for (let offset = 0; offset < window; offset += 1) sum += values[index - offset];
    return sum / window;
  });
}

export default function LineChart({
  data,
  valueLabel,
  emptyMessage,
  smoothingWindow = 12,
  height = 240,
}: LineChartProps) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useChartTooltip();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Geometry and both path strings are memoized together: they depend only on
  // the data, never on hover state, so moving the cursor (which updates
  // hoverIndex + tooltip state) must not recompute them. Same reasoning as
  // ScatterChart's memoized marks.
  const chart = useMemo(() => {
    if (data.length < 2) return null;
    const plotHeight = height - PADDING_BOTTOM - PADDING_TOP;
    const plotWidth = WIDTH - PADDING_LEFT - 8;
    const maxValue = Math.max(...data.map((point) => point.value));
    // Same headroom reasoning as BarChart: the peak should stop at the top
    // gridline, not at the plot edge.
    const { ticks, axisMax } = niceAxis(maxValue === 0 ? 1 : maxValue, 4);

    const xAt = (index: number) => PADDING_LEFT + (index / (data.length - 1)) * plotWidth;
    const yAt = (value: number) => PADDING_TOP + plotHeight - (value / axisMax) * plotHeight;

    const linePath = data
      .map((point, index) => `${index === 0 ? "M" : "L"} ${xAt(index)} ${yAt(point.value)}`)
      .join(" ");

    const smoothed =
      smoothingWindow > 1 ? rollingMean(data.map((point) => point.value), smoothingWindow) : [];
    // Broken into segments so the leading nulls (before the first full window)
    // don't get drawn as a line back to zero.
    const smoothedPath = smoothed
      .map((value, index) =>
        value == null
          ? null
          : `${index === 0 || smoothed[index - 1] == null ? "M" : "L"} ${xAt(index)} ${yAt(value)}`,
      )
      .filter((segment): segment is string => segment !== null)
      .join(" ");

    return {
      plotHeight,
      plotWidth,
      ticks,
      xAt,
      yAt,
      linePath,
      smoothedPath,
      smoothed,
      // Label every Nth tick so a long series doesn't collide along the x-axis.
      labelStride: Math.max(1, Math.ceil(data.length / 8)),
    };
  }, [data, height, smoothingWindow]);

  if (!chart) return <ChartEmpty message={emptyMessage} />;

  const { plotHeight, plotWidth, ticks, xAt, yAt, linePath, smoothedPath, smoothed, labelStride } =
    chart;

  return (
    <ChartSurface containerRef={containerRef} tooltip={tooltip}>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`${valueLabel} over time`}
        onMouseLeave={() => {
          hideTooltip();
          setHoverIndex(null);
        }}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - bounds.left) / bounds.width;
          const index = Math.round(((ratio * WIDTH - PADDING_LEFT) / plotWidth) * (data.length - 1));
          const clamped = Math.max(0, Math.min(data.length - 1, index));
          setHoverIndex(clamped);
          const point = data[clamped];
          const trend = smoothed[clamped];
          showTooltip(event, [
            point.label,
            `${formatNumber(point.value, 0)} ${valueLabel.toLowerCase()}`,
            ...(trend != null ? [`${smoothingWindow}-month average: ${formatNumber(trend, 1)}`] : []),
          ]);
        }}
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

        <path d={linePath} fill="none" stroke={CATEGORICAL[0]} strokeWidth={2} strokeLinejoin="round" />
        {smoothedPath ? (
          <path
            d={smoothedPath}
            fill="none"
            stroke={CATEGORICAL[1]}
            strokeWidth={2}
            strokeDasharray="5 3"
            strokeLinejoin="round"
          />
        ) : null}

        {hoverIndex != null ? (
          <>
            <line
              x1={xAt(hoverIndex)}
              x2={xAt(hoverIndex)}
              y1={PADDING_TOP}
              y2={PADDING_TOP + plotHeight}
              stroke={AXIS_COLOR}
              strokeWidth={1}
            />
            <circle
              cx={xAt(hoverIndex)}
              cy={yAt(data[hoverIndex].value)}
              r={4}
              fill={CATEGORICAL[0]}
              stroke={SURFACE_COLOR}
              strokeWidth={2}
            />
          </>
        ) : null}

        {data.map((point, index) =>
          index % labelStride === 0 ? (
            <text
              key={point.label}
              x={xAt(index)}
              y={PADDING_TOP + plotHeight + 14}
              textAnchor="middle"
              className="fill-muted"
              style={{ fontSize: 10 }}
            >
              {point.label}
            </text>
          ) : null,
        )}
      </svg>
      {smoothingWindow > 1 ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="h-0.5 w-4 shrink-0" style={{ backgroundColor: CATEGORICAL[0] }} />
            <span className="text-[11px] text-muted">Monthly {valueLabel.toLowerCase()}</span>
          </li>
          <li className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-0.5 w-4 shrink-0"
              style={{
                backgroundImage: `repeating-linear-gradient(to right, ${CATEGORICAL[1]} 0 5px, transparent 5px 8px)`,
              }}
            />
            <span className="text-[11px] text-muted">{smoothingWindow}-month rolling average</span>
          </li>
        </ul>
      ) : null}
    </ChartSurface>
  );
}
