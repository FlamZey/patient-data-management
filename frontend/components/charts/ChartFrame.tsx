"use client";

// Shared chrome for every chart: the titled card, the legend, the empty/
// insufficient-data state, and the hover tooltip. Charts here are hand-rolled
// SVG rather than a charting library -- the same reasoning as
// table-primitives.tsx and calendar-primitives.tsx elsewhere in this app: the
// form that matters most here (the correlation heatmap) isn't in the common
// libraries anyway, and this keeps the "records desk" palette and the app's
// existing card styling intact.

import { useCallback, useRef, useState, type ReactNode } from "react";

interface ChartCardProps {
  title: string;
  // One line saying what the reader is looking at -- always present, because
  // a chart title alone rarely says what the axes mean.
  subtitle?: string;
  // Rendered top-right: a bin-count selector, a field picker, etc.
  controls?: ReactNode;
  footnote?: ReactNode;
  children: ReactNode;
}

export function ChartCard({ title, subtitle, controls, footnote, children }: ChartCardProps) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-serif text-sm font-semibold text-foreground">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
        </div>
        {controls ? <div className="shrink-0">{controls}</div> : null}
      </div>
      {children}
      {footnote ? <p className="mt-2.5 text-[11px] leading-relaxed text-muted">{footnote}</p> : null}
    </section>
  );
}

// Shown instead of an empty plot when a chart's inputs aren't on file. Says
// which field is missing rather than rendering blank axes, since "no data"
// and "this column wasn't in your upload" are different problems.
export function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex h-40 items-center justify-center rounded border border-dashed border-border px-4">
      <p className="text-center text-xs text-muted">{message}</p>
    </div>
  );
}

export interface TooltipState {
  x: number;
  y: number;
  lines: string[];
}

// Positions a tooltip against the chart container. Kept in a hook so each
// chart wires up the same show/hide behavior without repeating the math.
export function useChartTooltip() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const showTooltip = useCallback((event: { clientX: number; clientY: number }, lines: string[]) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setTooltip({ x: event.clientX - bounds.left, y: event.clientY - bounds.top, lines });
  }, []);

  const hideTooltip = useCallback(() => setTooltip(null), []);

  return { containerRef, tooltip, showTooltip, hideTooltip };
}

export function ChartTooltip({ tooltip }: { tooltip: TooltipState | null }) {
  if (!tooltip) return null;
  return (
    <div
      // Flipped to the left of the cursor past the midpoint so it never runs
      // off the right edge of the card.
      className="pointer-events-none absolute z-10 max-w-[16rem] rounded border border-border bg-background/95 px-2.5 py-1.5 shadow-lg"
      style={{
        left: tooltip.x,
        top: tooltip.y,
        transform: `translate(${tooltip.x > 220 ? "-105%" : "12px"}, -50%)`,
      }}
      role="status"
    >
      {tooltip.lines.map((line, index) => (
        <p
          key={line}
          className={index === 0 ? "text-xs font-medium text-foreground" : "text-[11px] text-muted"}
        >
          {line}
        </p>
      ))}
    </div>
  );
}

// Wraps the SVG so tooltips can be absolutely positioned against it, and so
// wide charts scroll inside their own card instead of widening the page.
export function ChartSurface({
  containerRef,
  children,
  tooltip,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  children: ReactNode;
  tooltip: TooltipState | null;
}) {
  return (
    <div ref={containerRef} className="relative">
      {children}
      <ChartTooltip tooltip={tooltip} />
    </div>
  );
}
