"use client";

// Phase 5: the "so what" summary. Reads the same computeAssociations output
// Phase 3's statistics table shows in full, so nothing said here can
// disagree with the underlying numbers -- it's a different altitude on the
// identical computation, not a separate judgment call.

import { useMemo } from "react";

import { ChartCard, ChartEmpty } from "@/components/charts/ChartFrame";
import { formatNumber } from "@/components/charts/chart-theme";
import { computeAssociations } from "@/lib/associations";
import { computeOutlierCallouts, describeAssociation, suggestNextSteps, topFactors } from "@/lib/insights";
import type { AnalyticsRow, TargetVariable } from "@/lib/analytics";

interface KeyInsightsProps {
  rows: AnalyticsRow[];
  target: TargetVariable;
}

export default function KeyInsights({ rows, target }: KeyInsightsProps) {
  const associations = useMemo(() => computeAssociations(rows, target), [rows, target]);
  const top = useMemo(() => topFactors(associations, 5), [associations]);
  const callouts = useMemo(() => computeOutlierCallouts(rows), [rows]);
  const nextSteps = useMemo(() => suggestNextSteps(top, target), [top, target]);

  return (
    <div className="space-y-4">
      <ChartCard
        title={`Top factors associated with ${target.label.toLowerCase()}`}
        subtitle={`Ranked by effect size among fields that survived correction for multiple comparisons, out of ${associations.length} tested.`}
        footnote="A plain-language summary of the statistics table above, not a separate analysis -- every number here also appears there."
      >
        {top.length === 0 ? (
          <ChartEmpty message={`No field tested here holds up as significant against ${target.label.toLowerCase()} after correction.`} />
        ) : (
          <ol className="space-y-3">
            {top.map((result, index) => (
              <li key={result.fieldKey} className="flex gap-3 rounded-lg border border-border bg-background p-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-xs font-medium text-accent">
                  {index + 1}
                </span>
                <p className="text-xs leading-relaxed text-foreground">{describeAssociation(result, target)}</p>
              </li>
            ))}
          </ol>
        )}
      </ChartCard>

      {callouts.length > 0 ? (
        <ChartCard title="Patterns worth flagging" subtitle="Computed directly from the data on file, independent of the target variable used elsewhere on this page.">
          <div className="grid gap-3 sm:grid-cols-2">
            {callouts.map((callout) => (
              <div key={callout.label} className="rounded-lg border border-border bg-background p-3">
                <p className="text-[10px] tracking-wide text-muted uppercase">{callout.label}</p>
                <p className="mt-1 text-xs text-foreground">{callout.detail}</p>
              </div>
            ))}
          </div>
        </ChartCard>
      ) : null}

      <ChartCard title="What to investigate next" subtitle="Templated from the findings above -- not a generic checklist.">
        <ul className="space-y-2">
          {nextSteps.map((step) => (
            <li key={step} className="flex gap-2 text-xs leading-relaxed text-foreground">
              <span aria-hidden className="text-accent">
                →
              </span>
              {step}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-muted">Based on {formatNumber(rows.length, 0)} patients in the current view.</p>
      </ChartCard>
    </div>
  );
}
