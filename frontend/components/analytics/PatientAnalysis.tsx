"use client";

// The patient analysis report: a single read-only scroll -- KPIs, field
// coverage/quality, visualisations, a statistics table, a cohort comparison,
// and key insights -- for the patients the current user can see. No tabs,
// filters, or per-chart controls: every figure is a fixed cut of the full
// dataset, computed against one fixed target (whether the patient has any
// chronic condition on file).
//
// Fetches on mount rather than lazily: this is now its own destination in
// the sidebar (see app/data-analysis/page.tsx), so mounting it already means
// the reader asked to see the analysis -- unlike when this was a collapsible
// panel embedded next to the patients table.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ChartsSection from "@/components/analytics/ChartsSection";
import DataOverview from "@/components/analytics/DataOverview";
import KeyInsights from "@/components/analytics/KeyInsights";
import SegmentationSection from "@/components/analytics/SegmentationSection";
import StatisticsSection from "@/components/analytics/StatisticsSection";
import Spinner from "@/components/Spinner";
import { formatNumber, formatPercent } from "@/components/charts/chart-theme";
import { ApiError, apiGetAnalyticsDataset, type AnalyticsProgress } from "@/lib/api";
import { TARGET_VARIABLES, decodeDataset, meanOf, minMax, type AnalyticsRow } from "@/lib/analytics";
import type { AnalyticsQuality } from "@/lib/types";

// The report's target variable is fixed rather than selectable -- "has any
// chronic condition" is the one outcome every other section (charts,
// statistics, insights) is written to read naturally as "associated with a
// chronic condition."
const TARGET = TARGET_VARIABLES.find((variable) => variable.id === "has_condition")!;

interface LoadedDataset {
  rows: AnalyticsRow[];
  quality: AnalyticsQuality;
}

function Divider() {
  return <hr className="border-border" />;
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3.5">
      <p className="font-mono text-[10px] tracking-[0.18em] text-muted uppercase">{label}</p>
      <p className="mt-1.5 font-serif text-xl font-semibold text-foreground">{value}</p>
      {detail ? <p className="mt-0.5 text-[11px] text-muted">{detail}</p> : null}
    </div>
  );
}

export default function PatientAnalysis() {
  const [dataset, setDataset] = useState<LoadedDataset | null>(null);
  const [progress, setProgress] = useState<AnalyticsProgress | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setProgress(null);
    try {
      const raw = await apiGetAnalyticsDataset(setProgress);
      setDataset({ rows: decodeDataset(raw), quality: raw.quality });
    } catch (caught) {
      setDataset(null);
      setError(
        caught instanceof ApiError && caught.status === 403
          ? "You don't have permission to view patient analytics."
          : "Couldn't load the analysis. Try again.",
      );
    } finally {
      setIsLoading(false);
      setProgress(null);
    }
  }, []);

  // Guarded against a second run rather than fetching on every effect
  // invocation: this endpoint decrypts every in-scope patient row and is rate
  // limited to 10/minute, and React's dev-mode double-invoke would otherwise
  // spend two of that budget -- and two full sweeps -- on every page view.
  // Retry re-runs load() directly, so it isn't affected by this.
  // ponytail: a mount-scoped ref, not request cancellation -- if navigating
  // away mid-fetch needs to actually stop the server's sweep, thread an
  // AbortSignal through apiGetAnalyticsDataset instead.
  const hasFetchedRef = useRef(false);
  useEffect(() => {
    if (hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    (async () => {
      await load();
    })();
  }, [load]);

  const percent =
    progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : null;

  const summary = useMemo(() => {
    if (!dataset) return null;
    const ages = dataset.rows.map((row) => row.age).filter((age): age is number => age != null);
    const months = dataset.rows
      .map((row) => row.registrationMonth)
      .filter((month): month is string => month != null)
      .sort();
    const withCondition = dataset.rows.filter((row) => row.conditionCount > 0).length;
    return {
      meanAge: meanOf(ages),
      ageRange: minMax(ages),
      firstMonth: months[0] ?? null,
      lastMonth: months[months.length - 1] ?? null,
      withCondition,
    };
  }, [dataset]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24">
        <Spinner />
        <p className="text-xs text-muted">
          {percent == null
            ? "Preparing the analysis…"
            : `Decrypting patient records — ${progress?.processed.toLocaleString()} of ${progress?.total.toLocaleString()}`}
        </p>
        {percent != null ? (
          <div className="h-1 w-56 overflow-hidden rounded-full bg-background">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${percent}%` }}
            />
          </div>
        ) : null}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-20">
        <p className="text-xs text-danger">{error}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-hover"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!dataset || dataset.rows.length === 0) {
    return (
      <p className="py-20 text-center text-xs text-muted">
        No patient records to analyse yet. Upload a workbook first.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {summary ? (
        <p className="text-xs text-muted">
          {formatNumber(dataset.rows.length, 0)} patients in view
          {summary.ageRange ? ` · ages ${summary.ageRange.min}–${summary.ageRange.max}` : ""}
          {summary.firstMonth && summary.lastMonth ? ` · registered ${summary.firstMonth} – ${summary.lastMonth}` : ""}
          {` · generated ${new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`}
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Patients" value={formatNumber(dataset.rows.length, 0)} detail="in this analysis" />
        <Stat
          label="Mean age"
          value={summary?.meanAge != null ? `${formatNumber(summary.meanAge, 0)} yrs` : "—"}
          detail={summary?.ageRange ? `range ${summary.ageRange.min}–${summary.ageRange.max}` : "no ages on file"}
        />
        <Stat
          label="With a chronic condition"
          value={formatPercent(summary?.withCondition ?? 0, dataset.rows.length)}
          detail={`${formatNumber(summary?.withCondition ?? 0, 0)} patients`}
        />
        <Stat
          label="Registered"
          value={summary?.firstMonth && summary.lastMonth ? `${summary.firstMonth} →` : "—"}
          detail={summary?.lastMonth ? `through ${summary.lastMonth}` : "no dates on file"}
        />
      </div>

      <Divider />
      <DataOverview rows={dataset.rows} quality={dataset.quality} />

      <Divider />
      <ChartsSection rows={dataset.rows} target={TARGET} />

      <Divider />
      <StatisticsSection rows={dataset.rows} target={TARGET} />

      <Divider />
      <SegmentationSection rows={dataset.rows} />

      <Divider />
      <KeyInsights rows={dataset.rows} target={TARGET} />

      <Divider />
      <p className="text-[11px] leading-relaxed text-muted">
        Identifiers — name, address, phone, email, policy number, primary care physician, patient ID — are
        excluded from this analysis; date of birth is reduced to age and dates to year-month. Duplicate and
        date-order checks run server-side against real names and dates, so only their counts appear above.
        Occupation, allergies, and immunisation history are not yet analysed.
      </p>
    </div>
  );
}
