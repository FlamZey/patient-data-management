"use client";

// Container for the analytics dashboard: owns the dataset fetch (with live
// progress), the target-variable selection, and the collapse state.
//
// Deliberately lazy: the dataset endpoint decrypts every patient row the
// caller can see, so it only runs when the reader actually opens this panel,
// never as a side effect of loading the patients page.

import { useCallback, useMemo, useRef, useState } from "react";

import ChartsSection from "@/components/analytics/ChartsSection";
import DataOverview from "@/components/analytics/DataOverview";
import Spinner from "@/components/Spinner";
import { ApiError, apiGetAnalyticsDataset, type AnalyticsProgress } from "@/lib/api";
import {
  DEFAULT_TARGET_ID,
  TARGET_VARIABLES,
  decodeDataset,
  type AnalyticsRow,
} from "@/lib/analytics";
import type { AnalyticsQuality } from "@/lib/types";

type Tab = "overview" | "charts";

interface LoadedDataset {
  rows: AnalyticsRow[];
  quality: AnalyticsQuality;
}

export default function PatientAnalysis({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("charts");
  const [dataset, setDataset] = useState<LoadedDataset | null>(null);
  const [progress, setProgress] = useState<AnalyticsProgress | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState(DEFAULT_TARGET_ID);

  // The refreshSignal value the currently-held dataset was loaded at, so a
  // new upload invalidates it -- without this, reopening the panel after an
  // upload would silently show pre-upload figures.
  const loadedSignalRef = useRef<number | null>(null);

  const target = useMemo(
    () => TARGET_VARIABLES.find((variable) => variable.id === targetId) ?? TARGET_VARIABLES[0],
    [targetId],
  );

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setProgress(null);
    try {
      const raw = await apiGetAnalyticsDataset(setProgress);
      setDataset({ rows: decodeDataset(raw), quality: raw.quality });
      loadedSignalRef.current = refreshSignal;
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
  }, [refreshSignal]);

  const toggle = useCallback(() => {
    const opening = !isOpen;
    setIsOpen(opening);
    // Fetch on first open, and again if an upload landed since the last load.
    if (opening && !isLoading && (dataset === null || loadedSignalRef.current !== refreshSignal)) {
      void load();
    }
  }, [isOpen, isLoading, dataset, refreshSignal, load]);

  const percent =
    progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : null;

  return (
    <section className="rounded-lg border border-border bg-surface">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-hover"
      >
        <span className="min-w-0">
          <span className="block font-serif text-sm font-semibold text-foreground">Patient analysis</span>
          <span className="mt-0.5 block text-xs text-muted">
            Data quality, distributions, and relationships across the patients you can see.
          </span>
        </span>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden
          className={`h-4 w-4 shrink-0 text-muted transition-transform ${isOpen ? "rotate-180" : ""}`}
        >
          <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen ? (
        <div className="border-t border-border p-4">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12">
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
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-xs text-danger">{error}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="rounded border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-surface-hover"
              >
                Retry
              </button>
            </div>
          ) : dataset === null ? null : dataset.rows.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted">
              No patient records to analyse yet. Upload a workbook first.
            </p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-1" role="tablist">
                  {(
                    [
                      ["overview", "Data overview"],
                      ["charts", "Visualisations"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={tab === id}
                      onClick={() => setTab(id)}
                      className={`rounded px-2.5 py-1 text-xs transition-colors ${
                        tab === id
                          ? "bg-accent text-accent-foreground"
                          : "text-muted hover:bg-surface-hover hover:text-foreground"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {tab === "charts" ? (
                  <label className="flex items-center gap-2">
                    <span className="text-[11px] text-muted">Target</span>
                    <select
                      value={targetId}
                      onChange={(event) => setTargetId(event.target.value)}
                      className="rounded border border-border bg-background px-2 py-1 text-[11px] text-foreground focus:border-accent focus:outline-none"
                    >
                      {TARGET_VARIABLES.map((variable) => (
                        <option key={variable.id} value={variable.id}>
                          {variable.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>

              {tab === "overview" ? (
                <DataOverview rows={dataset.rows} quality={dataset.quality} />
              ) : (
                <ChartsSection rows={dataset.rows} target={target} />
              )}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
