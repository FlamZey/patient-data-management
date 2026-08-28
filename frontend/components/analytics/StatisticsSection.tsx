"use client";

// Phase 3: does the pattern actually hold up statistically, or is it just
// what the chart happened to show? Runs every candidate field against the
// selected target, corrects for running many tests at once (Benjamini-
// Hochberg FDR), and reports only what survives -- with the raw numbers
// (method, effect size, sample size) always visible so nothing here has to
// be taken on faith.

import { useMemo } from "react";

import { ChartCard, ChartEmpty } from "@/components/charts/ChartFrame";
import { formatNumber } from "@/components/charts/chart-theme";
import { computeAssociations, type AssociationResult } from "@/lib/associations";
import type { AnalyticsRow, TargetVariable } from "@/lib/analytics";

interface StatisticsSectionProps {
  rows: AnalyticsRow[];
  target: TargetVariable;
}

function formatP(p: number): string {
  return p < 0.001 ? "<0.001" : p.toFixed(3);
}

function EffectBar({ magnitude }: { magnitude: number }) {
  // Effect sizes here (r, Cohen's d, eta-squared, Cramer's V) don't share one
  // scale, so this bar shows relative magnitude within its own 0-1-ish range
  // rather than pretending to compare across methods -- capped visually at 1
  // since Cohen's d can exceed it.
  const width = Math.min(100, Math.abs(magnitude) * 100);
  return (
    <div className="h-1.5 w-16 overflow-hidden rounded-full bg-background">
      <div className="h-full rounded-full bg-accent" style={{ width: `${width}%` }} />
    </div>
  );
}

function ResultRow({ result }: { result: AssociationResult }) {
  return (
    <tr className="border-t border-border">
      <td className="py-2.5 pr-3">
        <p className="text-xs font-medium text-foreground">{result.fieldLabel}</p>
        <p className="text-[10px] text-muted">{result.method}</p>
      </td>
      <td className="py-2.5 pr-3 text-right font-mono text-xs text-foreground">{formatP(result.p)}</td>
      <td className="py-2.5 pr-3 text-right font-mono text-xs text-foreground">
        {formatP(result.adjustedP)}
      </td>
      <td className="py-2.5 pr-3">
        <div className="flex items-center justify-end gap-2">
          <span className="font-mono text-xs text-foreground">
            {result.effectSizeName}={result.effectSize.toFixed(2)}
          </span>
          <EffectBar magnitude={result.effectSize} />
        </div>
        <p className="text-right text-[10px] text-muted">{result.effectLabel}</p>
      </td>
      <td className="py-2.5 pr-3 text-right font-mono text-xs text-muted">
        {formatNumber(result.n, 0)}
      </td>
      <td className="py-2.5 text-right">
        {result.significant ? (
          <span className="rounded-full bg-teal/15 px-2 py-0.5 text-[10px] font-medium text-teal">
            Significant
          </span>
        ) : (
          <span className="text-[10px] text-muted">—</span>
        )}
        {result.caveat ? (
          <p className="mt-0.5 text-[10px] leading-snug text-danger/80">{result.caveat}</p>
        ) : null}
      </td>
    </tr>
  );
}

export default function StatisticsSection({ rows, target }: StatisticsSectionProps) {
  const results = useMemo(() => computeAssociations(rows, target), [rows, target]);

  const sorted = useMemo(
    () => [...results].sort((a, b) => a.adjustedP - b.adjustedP),
    [results],
  );
  const significantCount = sorted.filter((result) => result.significant).length;

  return (
    <div className="space-y-4">
      <ChartCard
        title={`What's associated with ${target.label.toLowerCase()}`}
        subtitle={`${sorted.length} candidate fields tested, corrected for multiple comparisons (Benjamini-Hochberg FDR, α=0.05).`}
        footnote="A p-value below 0.05 alone isn't enough here -- running this many tests means some clear that bar by chance. The 'adjusted p' column is what actually decides significance; a numeric field is tested with Pearson correlation or Welch's t-test depending on the target's type, and a categorical field with one-way ANOVA or a chi-square test. Correlation is not causation: a significant result means the pattern is unlikely to be noise, not that one thing causes the other."
      >
        {sorted.length === 0 ? (
          <ChartEmpty message="Not enough data on file to test any candidate field against this target." />
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">
              <span className="font-medium text-foreground">{significantCount}</span> of {sorted.length}{" "}
              fields remain significant after correction.
            </p>
            <div className="overflow-x-auto overlay-scrollbar">
              <table className="w-full min-w-[560px] text-left">
                <thead>
                  <tr className="text-[10px] tracking-wide text-muted uppercase">
                    <th className="pb-2 font-normal">Field</th>
                    <th className="pb-2 text-right font-normal">p</th>
                    <th className="pb-2 text-right font-normal">Adjusted p</th>
                    <th className="pb-2 text-right font-normal">Effect size</th>
                    <th className="pb-2 text-right font-normal">n</th>
                    <th className="pb-2 text-right font-normal">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((result) => (
                    <ResultRow key={result.fieldKey} result={result} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </ChartCard>
    </div>
  );
}
