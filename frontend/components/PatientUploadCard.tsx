"use client";

import { useRef, useState } from "react";

import Button from "@/components/Button";
import { apiUploadFile, ApiError } from "@/lib/api";
import type { PatientUploadResult } from "@/lib/types";

// Drag-and-drop (or click-to-browse) uploader for the patient Excel
// import, with client-side validation, upload progress, and a per-row
// accepted/rejected summary once the backend responds.
interface PatientUploadCardProps {
  onUploaded?: (result: PatientUploadResult) => void; // called after a successful upload, so the caller can refresh its table
}

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, mirrors the backend's limit
const ALLOWED_EXTENSIONS = [".xlsx", ".xls"];

// Checked before this ever reaches the network -- the backend enforces the
// same limits (see backend/app/routers/patients.py), this just avoids a
// pointless round trip for a file that can't possibly be accepted.
function validateFile(file: File): string | undefined {
  const name = file.name.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return "Only .xlsx and .xls files are accepted.";
  }
  if (file.size > MAX_FILE_BYTES) {
    return "File exceeds the 10MB upload limit.";
  }
  return undefined;
}

// Human-readable file size, e.g. 1536 -> "1.5 KB".
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PatientUploadCard({ onUploaded }: PatientUploadCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null); // the hidden <input type="file">, opened programmatically
  const [file, setFile] = useState<File | null>(null); // the currently-selected (not yet uploaded) file
  const [isDragging, setIsDragging] = useState(false); // drop zone highlight while a file is dragged over it
  const [clientError, setClientError] = useState<string | null>(null); // validateFile() failure message
  const [uploadError, setUploadError] = useState<string | null>(null); // backend-reported failure message
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0); // 0-100, driven by apiUploadFile's onProgress
  const [result, setResult] = useState<PatientUploadResult | null>(null); // last successful upload's summary
  const [issuesExpanded, setIssuesExpanded] = useState(false); // whether the rejected-rows list is shown

  // Runs client-side validation on a newly picked/dropped file and either
  // stores it (ready to upload) or shows why it was rejected.
  function handleFileSelected(candidate: File) {
    setUploadError(null);
    setResult(null);

    const error = validateFile(candidate);
    if (error) {
      setClientError(error);
      setFile(null);
      return;
    }
    setClientError(null);
    setFile(candidate);
  }

  function handleRemove() {
    setFile(null);
    setClientError(null);
  }

  async function handleUpload() {
    if (!file) return;
    setIsUploading(true);
    setProgress(0);
    setUploadError(null);

    try {
      const data = await apiUploadFile<PatientUploadResult>("/patients/upload", file, setProgress);
      setResult(data);
      setFile(null);
      setIssuesExpanded(false);
      onUploaded?.(data);
    } catch (err) {
      const detail = err instanceof ApiError ? (err.body as { detail?: string } | null)?.detail : undefined;
      setUploadError(detail || "Could not process this file. Please try again.");
      // This is a whole-file failure (wrong columns, wrong extension, etc.)
      // -- not something fixable by retrying the same file, so clear it and
      // drop back to an empty, immediately-usable drop zone.
      setFile(null);
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="animate-rise-in overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-5 sm:px-8">
        <div>
          <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-teal uppercase">Patients</p>
          <h2 className="font-serif text-lg font-semibold text-foreground">Upload patient records</h2>
        </div>
        <a
          href="/patient-upload-template.xlsx"
          download
          className="shrink-0 text-sm font-medium text-accent transition-colors hover:text-accent-hover"
        >
          Download template
        </a>
      </div>

      <div className="px-6 py-6 sm:px-8">
        {/* Drop zone -- only shown before a file is picked */}
        {!file && (
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose a patient upload file"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(event) => {
              // Space/Enter activate it like a real button, since this is a div
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(event) => {
              event.preventDefault(); // required to allow onDrop to fire
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              const dropped = event.dataTransfer.files[0];
              if (dropped) handleFileSelected(dropped);
            }}
            className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
              isDragging ? "border-accent bg-accent/5" : "border-border hover:border-muted"
            }`}
          >
            <svg className="h-8 w-8 text-muted" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M10 3v10m0 0-3.5-3.5M10 13l3.5-3.5M4 15.5v.5A1.5 1.5 0 0 0 5.5 17.5h9a1.5 1.5 0 0 0 1.5-1.5v-.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <p className="text-sm text-foreground">
              Drag and drop a .xlsx or .xls file, or <span className="text-accent">browse</span>
            </p>
            <p className="text-xs text-muted">Up to 10MB.</p>
            {/* Hidden real file input -- the styled div above is what users see and click */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              onChange={(event) => {
                const selected = event.target.files?.[0];
                if (selected) handleFileSelected(selected);
                event.target.value = ""; // lets the same file be re-selected later (e.g. after Remove)
              }}
            />
          </div>
        )}

        {/* Selected-file preview -- only shown once a file has passed validation */}
        {file && (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{file.name}</p>
              <p className="font-mono text-xs text-muted">{formatFileSize(file.size)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!isUploading && (
                <Button variant="secondary" size="sm" onClick={handleRemove}>
                  Remove
                </Button>
              )}
              <Button size="sm" onClick={handleUpload} disabled={isUploading}>
                {isUploading ? "Uploading..." : "Upload"}
              </Button>
            </div>
          </div>
        )}

        {isUploading && (
          <div className="mt-4">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-150"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="mt-1.5 font-mono text-xs text-muted">{progress}%</p>
          </div>
        )}

        {clientError && (
          <p
            role="alert"
            className="mt-4 rounded-md border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-foreground"
          >
            {clientError}
          </p>
        )}

        {uploadError && (
          <p
            role="alert"
            className="mt-4 rounded-md border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-foreground"
          >
            {uploadError}
          </p>
        )}

        {/* Post-upload summary, with an expandable list of any rejected rows */}
        {result && (
          <div className="mt-4 rounded-md border-l-2 border-teal bg-teal/10 px-3 py-2 text-sm text-foreground">
            <p role="status">
              {result.accepted} of {result.accepted + result.rejected.length} records processed.
            </p>
            {result.rejected.length > 0 && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => setIssuesExpanded((prev) => !prev)}
                  className="text-xs font-medium text-accent hover:text-accent-hover"
                >
                  {issuesExpanded ? "Hide" : "Show"} {result.rejected.length} issue
                  {result.rejected.length === 1 ? "" : "s"}
                </button>
                {issuesExpanded && (
                  <ul className="mt-2 space-y-1 font-mono text-xs text-muted">
                    {result.rejected.map((row, index) => (
                      <li key={index}>
                        Row {row.row}: {row.field} — {row.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
