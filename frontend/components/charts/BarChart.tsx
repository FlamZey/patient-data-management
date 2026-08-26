"use client";

import { ChartEmpty, ChartSurface, useChartTooltip } from "@/components/charts/ChartFrame";
import {
  AXIS_COLOR,
  GRID_COLOR,
  formatNumber,
  niceAxis,
  sequentialColor,
} from "@/components/charts/chart-theme";

export interface BarDatum {
  label: string;
  value: number;
  // Extra tooltip lines (e.g. "12.4% of patients").
  detail?: string;
}

interface BarChartProps {
  data: BarDatum[];
  // Axis label for the measured dimension, e.g. "Patients".
  valueLabel: string;
  emptyMessage: string;
  // Horizontal is the default: category names here (departments, insurers,
  // conditions) are long, and horizontal bars give them room to be read
  // without rotating the labels.
  orientation?: "horizontal" | "vertical";
  height?: number;
  formatValue?: (value: number) => string;
}

const LABEL_WIDTH = 132;
const VALUE_GUTTER = 46;
const BAR_GAP = 6;
const ROUNDED_END = 4;

export default function BarChart({
  data,
  valueLabel,
  emptyMessage,
  orientation = "horizontal",
  height,
  formatValue = (value) => formatNumber(value, 1),
}: BarChartProps) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useChartTooltip();

  if (data.length === 0) return <ChartEmpty message={emptyMessage} />;

  const maxValue = Math.max(...data.map((datum) => datum.value), 0);
  // A flat-zero series would otherwise divide by zero below.
  const scaleMax = maxValue === 0 ? 1 : maxValue;

  if (orientation === "horizontal") {
    const rowHeight = 26;
    const chartHeight = data.length * rowHeight;
    const plotWidth = 520 - LABEL_WIDTH - VALUE_GUTTER;

    return (
      <ChartSurface containerRef={containerRef} tooltip={tooltip}>
        <svg
          viewBox={`0 0 520 ${chartHeight}`}
          className="w-full"
          style={{ height: height ?? chartHeight }}
          role="img"
          aria-label={`${valueLabel} by category`}
        >
          {data.map((datum, index) => {
            const y = index * rowHeight;
            const barHeight = rowHeight - BAR_GAP;
            const width = Math.max(0, (datum.value / scaleMax) * plotWidth);
            return (
              <g
                key={datum.label}
                onMouseMove={(event) =>
                  showTooltip(event, [
                    datum.label,
                    `${formatValue(datum.value)} ${valueLabel.toLowerCase()}`,
                    ...(datum.detail ? [datum.detail] : []),
                  ])
                }
                onMouseLeave={hideTooltip}
              >
                {/* Full-row hit target, wider than the bar itself. */}
                <rect x={0} y={y} width={520} height={rowHeight} fill="transparent" />
                <text
                  x={LABEL_WIDTH - 8}
                  y={y + barHeight / 2 + 1}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-muted"
                  style={{ fontSize: 11 }}
                >
                  {datum.label.length > 20 ? `${datum.label.slice(0, 19)}…` : datum.label}
                </text>
                <rect
                  x={LABEL_WIDTH}
                  y={y}
                  width={Math.max(width, 2)}
                  height={barHeight}
                  rx={ROUNDED_END}
                  fill={sequentialColor(datum.value / scaleMax)}
                />
                <text
                  x={LABEL_WIDTH + Math.max(width, 2) + 6}
                  y={y + barHeight / 2 + 1}
                  dominantBaseline="middle"
                  className="fill-foreground"
                  style={{ fontSize: 11 }}
                >
                  {formatValue(datum.value)}
                </text>
              </g>
            );
          })}
        </svg>
      </ChartSurface>
    );
  }

  // Vertical: for ordered scales (age brackets, BMI categories) where the
  // left-to-right reading order carries meaning.
  const chartHeight = height ?? 220;
  // Without top padding the topmost tick's label sits at y=0 and gets clipped
  // by the SVG edge, since it's vertically centred on its gridline.
  const PADDING_TOP = 10;
  const plotHeight = chartHeight - 34 - PADDING_TOP;
  const barWidth = Math.max(10, 520 / data.length - 12);
  // Bars and gridlines share axisMax so the tallest bar stops at the top
  // gridline rather than the plot edge.
  const { ticks, axisMax } = niceAxis(scaleMax, 4);
  // Axis ticks need enough decimals to stay distinct: a count target whose
  // ticks step by 0.5 would otherwise render as "0, 1, 1, 2" at zero decimals.
  const tickStep = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : axisMax;
  const tickDecimals = tickStep >= 1 ? 0 : tickStep >= 0.1 ? 1 : 2;
  // With many bars (a histogram's) every label would collide -- show every
  // Nth instead, the same way the line chart thins its time axis.
  const labelStride = Math.max(1, Math.ceil(data.length / 12));

  return (
    <ChartSurface containerRef={containerRef} tooltip={tooltip}>
      <svg
        viewBox={`0 0 520 ${chartHeight}`}
        className="w-full"
        style={{ height: chartHeight }}
        role="img"
        aria-label={`${valueLabel} by category`}
      >
        {ticks.map((tick) => {
          const y = PADDING_TOP + plotHeight - (tick / axisMax) * plotHeight;
          return (
            <g key={tick}>
              <line x1={34} x2={520} y1={y} y2={y} stroke={GRID_COLOR} strokeWidth={1} />
              <text
                x={28}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted"
                style={{ fontSize: 10 }}
              >
                {formatNumber(tick, tickDecimals)}
              </text>
            </g>
          );
        })}
        <line
          x1={34}
          x2={520}
          y1={PADDING_TOP + plotHeight}
          y2={PADDING_TOP + plotHeight}
          stroke={AXIS_COLOR}
          strokeWidth={1}
        />

        {data.map((datum, index) => {
          const slot = (520 - 34) / data.length;
          const x = 34 + index * slot + (slot - barWidth) / 2;
          const barHeight = Math.max(2, (datum.value / axisMax) * plotHeight);
          return (
            <g
              key={datum.label}
              onMouseMove={(event) =>
                showTooltip(event, [
                  datum.label,
                  `${formatValue(datum.value)} ${valueLabel.toLowerCase()}`,
                  ...(datum.detail ? [datum.detail] : []),
                ])
              }
              onMouseLeave={hideTooltip}
            >
              <rect
                x={34 + index * slot}
                y={PADDING_TOP}
                width={slot}
                height={plotHeight}
                fill="transparent"
              />
              <rect
                x={x}
                y={PADDING_TOP + plotHeight - barHeight}
                width={barWidth}
                height={barHeight}
                rx={ROUNDED_END}
                fill={sequentialColor(datum.value / axisMax)}
              />
              {index % labelStride === 0 ? (
                <text
                  x={x + barWidth / 2}
                  y={PADDING_TOP + plotHeight + 14}
                  textAnchor="middle"
                  className="fill-muted"
                  style={{ fontSize: 10 }}
                >
                  {datum.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </ChartSurface>
  );
}
