"use client";

import { ChartEmpty, ChartSurface, useChartTooltip } from "@/components/charts/ChartFrame";
import {
  DIVERGING_NEGATIVE,
  DIVERGING_NEUTRAL,
  DIVERGING_POSITIVE,
  SURFACE_COLOR,
  divergingColor,
} from "@/components/charts/chart-theme";

export interface CorrelationCell {
  xLabel: string;
  yLabel: string;
  // null when the pair had too few complete observations to correlate.
  r: number | null;
  n: number;
}

interface CorrelationHeatmapProps {
  labels: string[];
  cells: CorrelationCell[];
  emptyMessage: string;
}

const CELL = 46;
const LABEL_GUTTER = 92;
const TOP_GUTTER = 76;

export default function CorrelationHeatmap({ labels, cells, emptyMessage }: CorrelationHeatmapProps) {
  const { containerRef, tooltip, showTooltip, hideTooltip } = useChartTooltip();

  if (labels.length === 0) return <ChartEmpty message={emptyMessage} />;

  const byKey = new Map(cells.map((cell) => [`${cell.xLabel}|${cell.yLabel}`, cell]));
  const width = LABEL_GUTTER + labels.length * CELL;
  const height = TOP_GUTTER + labels.length * CELL;

  return (
    <div>
      {/* Correlation matrices get wide fast -- scroll inside the card rather
          than forcing the page to scroll sideways. */}
      <div className="overflow-x-auto overlay-scrollbar">
        <ChartSurface containerRef={containerRef} tooltip={tooltip}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            style={{ width, height, maxWidth: "none" }}
            role="img"
            aria-label="Correlation matrix of numeric fields"
          >
            {labels.map((label, column) => (
              <text
                key={`top-${label}`}
                x={LABEL_GUTTER + column * CELL + CELL / 2}
                y={TOP_GUTTER - 8}
                textAnchor="start"
                className="fill-muted"
                style={{ fontSize: 10 }}
                transform={`rotate(-45 ${LABEL_GUTTER + column * CELL + CELL / 2} ${TOP_GUTTER - 8})`}
              >
                {label}
              </text>
            ))}

            {labels.map((yLabel, row) => (
              <g key={`row-${yLabel}`}>
                <text
                  x={LABEL_GUTTER - 8}
                  y={TOP_GUTTER + row * CELL + CELL / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-muted"
                  style={{ fontSize: 10 }}
                >
                  {yLabel}
                </text>
                {labels.map((xLabel, column) => {
                  const cell = byKey.get(`${xLabel}|${yLabel}`);
                  const r = cell?.r ?? null;
                  const isDiagonal = xLabel === yLabel;
                  return (
                    <g
                      key={`${xLabel}-${yLabel}`}
                      onMouseMove={(event) =>
                        showTooltip(event, [
                          `${yLabel} × ${xLabel}`,
                          isDiagonal
                            ? "Same field"
                            : r == null
                              ? "Not enough overlapping values"
                              : `r = ${r.toFixed(3)}`,
                          ...(cell && !isDiagonal ? [`n = ${cell.n.toLocaleString()}`] : []),
                        ])
                      }
                      onMouseLeave={hideTooltip}
                    >
                      <rect
                        x={LABEL_GUTTER + column * CELL}
                        y={TOP_GUTTER + row * CELL}
                        width={CELL}
                        height={CELL}
                        rx={3}
                        // 2px surface gap so adjacent cells never touch.
                        stroke={SURFACE_COLOR}
                        strokeWidth={2}
                        fill={isDiagonal ? DIVERGING_NEUTRAL : r == null ? "transparent" : divergingColor(r)}
                        fillOpacity={isDiagonal ? 0.5 : 1}
                      />
                      {/* The number is always printed, so the cell is never
                          color-alone -- and the value is exact, not estimated
                          off a color ramp. */}
                      <text
                        x={LABEL_GUTTER + column * CELL + CELL / 2}
                        y={TOP_GUTTER + row * CELL + CELL / 2}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className={isDiagonal ? "fill-muted" : "fill-foreground"}
                        style={{ fontSize: 10, fontWeight: isDiagonal ? 400 : 500 }}
                      >
                        {isDiagonal ? "—" : r == null ? "·" : r.toFixed(2)}
                      </text>
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>
        </ChartSurface>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="text-[11px] text-muted">Pearson r:</span>
        {[
          { label: "−1.0 to −0.5", color: DIVERGING_NEGATIVE[1] },
          { label: "−0.5 to −0.15", color: DIVERGING_NEGATIVE[0] },
          { label: "≈ 0", color: DIVERGING_NEUTRAL },
          { label: "0.15 to 0.5", color: DIVERGING_POSITIVE[0] },
          { label: "0.5 to 1.0", color: DIVERGING_POSITIVE[1] },
        ].map((item) => (
          <span key={item.label} className="flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
            <span className="text-[11px] text-muted">{item.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
