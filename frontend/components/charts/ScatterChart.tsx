"use client";

import { useMemo } from "react";

import { ChartEmpty, ChartSurface, useChartTooltip } from "@/components/charts/ChartFrame";
import {
  AXIS_COLOR,
  CATEGORICAL,
  GRID_COLOR,
  formatNumber,
  niceTicks,
} from "@/components/charts/chart-theme";
import { linearFit, pearson } from "@/lib/analytics";

interface ScatterChartProps {
  pairs: [number, number][];
  xLabel: string;
  yLabel: string;
  emptyMessage: string;
  height?: number;
  // Plotting 10,000 overlapping dots is both slow and unreadable -- past this
  // many points the series is sampled down (see below).
  maxPoints?: number;
}

const WIDTH = 520;
const PADDING_LEFT = 44;
const PADDING_BOTTOM = 34;
const PADDING_TOP = 10;

export default function ScatterChart({
  pairs,
  xLabel,
  yLabel,
  emptyMessage,
  height = 280,
  maxPoints = 2000,
}: ScatterChartProps) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useChartTooltip();

  // Deterministic every-Nth sample rather than random: the chart must not
  // reshuffle its points on each re-render. The trendline and r below are
  // computed on the FULL set, so the statistics never depend on the sample.
  const shown = useMemo(() => {
    if (pairs.length <= maxPoints) return pairs;
    const stride = Math.ceil(pairs.length / maxPoints);
    return pairs.filter((_, index) => index % stride === 0);
  }, [pairs, maxPoints]);

  const fit = useMemo(() => linearFit(pairs), [pairs]);
  const r = useMemo(() => pearson(pairs), [pairs]);

  // Axis bounds derive from a single pass rather than four spread-based
  // Math.min/Math.max calls: spreading 10,000 numbers into a call four times
  // is both slower and risks a stack overflow on very large inputs.
  const scale = useMemo(() => {
    if (pairs.length < 2) return null;
    let xLow = Infinity;
    let xHigh = -Infinity;
    let yLow = Infinity;
    let yHigh = -Infinity;
    for (const [x, y] of pairs) {
      if (x < xLow) xLow = x;
      if (x > xHigh) xHigh = x;
      if (y < yLow) yLow = y;
      if (y > yHigh) yHigh = y;
    }
    const xSpan = xHigh - xLow || 1;
    const ySpan = yHigh - yLow || 1;
    const plotHeight = height - PADDING_BOTTOM - PADDING_TOP;
    const plotWidth = WIDTH - PADDING_LEFT - 10;
    const xMin = xLow - xSpan * 0.04;
    const xMax = xHigh + xSpan * 0.04;
    const yMin = yLow - ySpan * 0.06;
    const yMax = yHigh + ySpan * 0.06;
    return {
      xMin,
      xMax,
      yMin,
      yMax,
      plotHeight,
      plotWidth,
      xAt: (value: number) => PADDING_LEFT + ((value - xMin) / (xMax - xMin)) * plotWidth,
      yAt: (value: number) =>
        PADDING_TOP + plotHeight - ((value - yMin) / (yMax - yMin)) * plotHeight,
    };
  }, [pairs, height]);

  // The dots are memoized as a single element so moving the cursor -- which
  // updates tooltip state on this component -- doesn't re-reconcile all 2,000
  // of them. Measured before this change: hover cost p50 33.7ms / p95 67.2ms,
  // well past the ~16.7ms frame budget, so the chart visibly stuttered.
  const marks = useMemo(() => {
    if (!scale) return null;
    const { xAt, yAt } = scale;
    return (
      <g>
        {shown.map(([x, y], index) => (
          <circle
            key={index}
            cx={xAt(x)}
            cy={yAt(y)}
            r={2.5}
            fill={CATEGORICAL[0]}
            // Low opacity so density reads through overplotting -- with
            // thousands of points the dark clusters ARE the information.
            fillOpacity={0.35}
          />
        ))}
      </g>
    );
  }, [shown, scale]);

  if (pairs.length < 2 || !scale) return <ChartEmpty message={emptyMessage} />;

  const { xMin, xMax, yMin, yMax, plotHeight, plotWidth, xAt, yAt } = scale;
  const xTicks = niceTicks(xMin, xMax, 5);
  const yTicks = niceTicks(yMin, yMax, 4);

  return (
    <ChartSurface containerRef={containerRef} tooltip={tooltip}>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`${yLabel} against ${xLabel}`}
      >
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line x1={PADDING_LEFT} x2={WIDTH - 10} y1={yAt(tick)} y2={yAt(tick)} stroke={GRID_COLOR} strokeWidth={1} />
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
        {xTicks.map((tick) => (
          <text
            key={`x-${tick}`}
            x={xAt(tick)}
            y={PADDING_TOP + plotHeight + 14}
            textAnchor="middle"
            className="fill-muted"
            style={{ fontSize: 10 }}
          >
            {formatNumber(tick, 0)}
          </text>
        ))}
        <line
          x1={PADDING_LEFT}
          x2={WIDTH - 10}
          y1={PADDING_TOP + plotHeight}
          y2={PADDING_TOP + plotHeight}
          stroke={AXIS_COLOR}
          strokeWidth={1}
        />

        {marks}

        {fit ? (
          <line
            x1={xAt(xMin)}
            y1={yAt(fit.intercept + fit.slope * xMin)}
            x2={xAt(xMax)}
            y2={yAt(fit.intercept + fit.slope * xMax)}
            stroke={CATEGORICAL[1]}
            strokeWidth={2}
          />
        ) : null}

        <text
          x={PADDING_LEFT + plotWidth / 2}
          y={height - 4}
          textAnchor="middle"
          className="fill-muted"
          style={{ fontSize: 10 }}
        >
          {xLabel}
        </text>
        <text
          x={10}
          y={PADDING_TOP + plotHeight / 2}
          textAnchor="middle"
          className="fill-muted"
          style={{ fontSize: 10 }}
          transform={`rotate(-90 10 ${PADDING_TOP + plotHeight / 2})`}
        >
          {yLabel}
        </text>

        {/* Invisible hit layer: reports the value under the cursor rather
            than requiring the reader to hit a 2.5px dot. */}
        <rect
          x={PADDING_LEFT}
          y={PADDING_TOP}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          onMouseMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            const xValue = xMin + ((event.clientX - bounds.left) / bounds.width) * (xMax - xMin);
            const yValue = yMax - ((event.clientY - bounds.top) / bounds.height) * (yMax - yMin);
            showTooltip(event, [
              `${xLabel}: ${formatNumber(xValue, 1)}`,
              `${yLabel}: ${formatNumber(yValue, 1)}`,
            ]);
          }}
          onMouseLeave={hideTooltip}
        />
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: CATEGORICAL[0] }} />
          <span className="text-[11px] text-muted">
            {pairs.length > shown.length
              ? `${formatNumber(shown.length, 0)} of ${formatNumber(pairs.length, 0)} patients shown`
              : `${formatNumber(pairs.length, 0)} patients`}
          </span>
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-0.5 w-4 shrink-0" style={{ backgroundColor: CATEGORICAL[1] }} />
          <span className="text-[11px] text-muted">
            Trendline{r != null ? ` · r = ${r.toFixed(3)} (all ${formatNumber(pairs.length, 0)} points)` : ""}
          </span>
        </li>
      </ul>
    </ChartSurface>
  );
}
