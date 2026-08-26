"use client";

// Phase 1 of the analytics dashboard: what's actually in the data, and what's
// wrong with it -- shown BEFORE any chart, so a reader knows what the figures
// below are built on rather than discovering the gaps afterward.

import { useMemo } from "react";

import { SEQUENTIAL, formatNumber, formatPercent } from "@/components/charts/chart-theme";
import {
  computeCoverage,
  computeQualityFlags,
  meanOf,
  minMax,
  type AnalyticsRow,
} from "@/lib/analytics";
import type { AnalyticsQuality } from "@/lib/types";

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3.5">
      <p className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">{label}</p>
      <p className="mt-1.5 font-serif text-xl font-semibold text-foreground">{value}</p>
      {detail ? <p className="mt-0.5 text-[11px] text-muted">{detail}</p> : null}
    </div>
  );
}

function CoverageBar({ populated, total }: { populated: number; total: number }) {
  const ratio = total === 0 ? 0 : populated / total;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-background">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.max(ratio * 100, ratio > 0 ? 1.5 : 0)}%`,
          // More coverage reads brighter -- the same sequential ramp the
          // magnitude charts use, so "more" looks consistent page-wide.
          backgroundColor: SEQUENTIAL[Math.min(SEQUENTIAL.length - 1, Math.floor(ratio * SEQUENTIAL.length))],
        }}
      />
    </div>
  );
}

interface DataOverviewProps {
  rows: AnalyticsRow[];
  quality: AnalyticsQuality;
}

export default function DataOverview({ rows, quality }: DataOverviewProps) {
  const coverage = useMemo(() => computeCoverage(rows), [rows]);
  const flags = useMemo(() => computeQualityFlags(rows, quality), [rows, quality]);

  const summary = useMemo(() => {
    const ages = rows.map((row) => row.age).filter((age): age is number => age != null);
    const months = rows
      .map((row) => row.registrationMonth)
      .filter((month): month is string => month != null)
      .sort();
    const withConditions = rows.filter((row) => row.conditionCount > 0).length;

    const ageBounds = minMax(ages);
    return {
      meanAge: meanOf(ages),
      ageRange: ageBounds,
      firstMonth: months[0] ?? null,
      lastMonth: months[months.length - 1] ?? null,
      withConditions,
    };
  }, [rows]);

  const flaggedTotal = flags.reduce((sum, flag) => sum + flag.count, 0);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Patients" value={formatNumber(rows.length, 0)} detail="in this analysis" />
        <StatTile
          label="Mean age"
          value={summary.meanAge != null ? `${formatNumber(summary.meanAge, 0)} yrs` : "—"}
          detail={
            summary.ageRange ? `range ${summary.ageRange.min}–${summary.ageRange.max}` : "no ages on file"
          }
        />
        <StatTile
          label="With a condition"
          value={formatPercent(summary.withConditions, rows.length)}
          detail={`${formatNumber(summary.withConditions, 0)} patients`}
        />
        <StatTile
          label="Registered"
          value={summary.firstMonth && summary.lastMonth ? `${summary.firstMonth} →` : "—"}
          detail={summary.lastMonth ? `through ${summary.lastMonth}` : "no dates on file"}
        />
      </div>

      <section>
        <h3 className="mb-1 font-serif text-sm font-semibold text-foreground">Field coverage</h3>
        <p className="mb-3 text-xs text-muted">
          How much of each field is actually filled in. Every optional column is opt-in on upload, so a
          low bar here means the data was never provided — not that patients lack the attribute. Charts
          below that depend on a sparse field say so.
        </p>
        <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {coverage.map((field) => (
            <div key={field.field}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-foreground">{field.label}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted">
                  {formatPercent(field.populated, field.total)}
                </span>
              </div>
              <CoverageBar populated={field.populated} total={field.total} />
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-1 font-serif text-sm font-semibold text-foreground">Data quality</h3>
        <p className="mb-3 text-xs text-muted">
          Values that pass upload validation but are still suspect. Nothing here is silently corrected —
          flags marked <span className="text-foreground">excluded</span> are dropped from the charts that
          use that field; the rest are reported and kept.
        </p>

        {flags.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="text-xs text-muted">
              No quality issues found across {formatNumber(rows.length, 0)} patients — no implausible
              vitals, impossible dates, or possible duplicate records.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {flags.map((flag) => (
                <div key={flag.id} className="rounded-lg border border-border bg-surface p-3.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-xs font-medium text-foreground">{flag.label}</p>
                    <span
                      className={`shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] tracking-wide uppercase ${
                        flag.excluded
                          ? "border-danger/40 text-danger"
                          : "border-border text-muted"
                      }`}
                    >
                      {flag.excluded ? "excluded" : "flagged"}
                    </span>
                  </div>
                  <p className="mt-1.5 font-serif text-lg font-semibold text-foreground">
                    {formatNumber(flag.count, 0)}
                    <span className="ml-1.5 font-sans text-[11px] font-normal text-muted">
                      {formatPercent(flag.count, rows.length)}
                    </span>
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted">{flag.detail}</p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              {formatNumber(flaggedTotal, 0)} flag
              {flaggedTotal === 1 ? "" : "s"} raised across {formatNumber(rows.length, 0)} patients. A
              record can raise more than one, so this total can exceed the number of affected patients.
            </p>
          </>
        )}
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h3 className="mb-1.5 font-serif text-sm font-semibold text-foreground">What was excluded</h3>
        <ul className="space-y-1.5 text-[11px] leading-relaxed text-muted">
          <li>
            <span className="text-foreground">Identifiers never leave the server.</span> Names, address,
            phone, email, policy number, PCP, and patient ID are not part of this analysis — the endpoint
            behind it returns a de-identified projection, with date of birth reduced to an age and dates
            to year-month.
          </li>
          <li>
            <span className="text-foreground">Duplicate and date-order checks run server-side.</span>{" "}
            Those need real names and exact dates, so only their counts cross the wire.
          </li>
          <li>
            <span className="text-foreground">Occupation, allergies, and immunisation history are not
            analysed.</span> Occupation is free text with too many distinct values to chart; the other two
            aren&apos;t used by any figure here yet.
          </li>
        </ul>
      </section>
    </div>
  );
}
