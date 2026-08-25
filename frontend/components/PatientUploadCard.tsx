"use client";

import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import Button from "@/components/Button";
import { apiUploadFileWithProgress, ApiError, type UploadProgress } from "@/lib/api";
import type { PatientUploadResult } from "@/lib/types";
import { useLockPageScroll } from "@/lib/page-scroll-lock";

// Drag-and-drop (or click-to-browse) uploader for the patient Excel
// import, with client-side validation, upload progress, and a per-row
// accepted/rejected summary once the backend responds.
interface PatientUploadCardProps {
  onUploaded?: (result: PatientUploadResult) => void; // called after a successful upload, so the caller can refresh its table
}

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB, mirrors the backend's limit
const ALLOWED_EXTENSIONS = [".xlsx", ".xls"];

// A file re-uploaded wholesale (e.g. every row now a duplicate Patient ID)
// can reject thousands of rows -- rendering all of them freezes the tab, and
// an unbounded list just grows the page forever. Cap what's rendered and
// scroll the rest instead.
const MAX_ISSUES_SHOWN = 100;

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

// Same eye glyph as LoginForm's show-password toggle, reused here so "eye
// icon" means "preview" consistently wherever it appears in the app.
function EyeIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M1.5 10S4.5 4.5 10 4.5 18.5 10 18.5 10 15.5 15.5 10 15.5 1.5 10 1.5 10Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

// Same down-arrow-into-a-tray glyph as the drop zone below, reused here so
// "download icon" and "drop a file here" read as the same visual language.
function DownloadIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 3v10m0 0-3.5-3.5M10 13l3.5-3.5M4 15.5v.5A1.5 1.5 0 0 0 5.5 17.5h9a1.5 1.5 0 0 0 1.5-1.5v-.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Shared hit-area/hover treatment for the two icon buttons in the card's
// header -- matches NavBar's settings gear (h-9 w-9 rounded-full).
const HEADER_ICON_BUTTON_CLASS =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-hover hover:text-foreground";

// Mirrors the single example row backend/scripts/generate_sample_workbooks.py
// bakes into patient-upload-template.xlsx -- kept in sync by hand since it's
// static, one row, and changes only alongside REQUIRED_COLUMNS.
const TEMPLATE_COLUMNS = ["Patient ID", "First Name", "Last Name", "Date of Birth", "Gender"];
const TEMPLATE_EXAMPLE_ROW = ["P-0001", "Jane", "Doe", "1990-01-15", "Female"];

// Mirrors backend/app/services/patient_import.py's OPTIONAL_COLUMNS -- kept
// in sync by hand, same convention as TEMPLATE_COLUMNS above. A workbook may
// include any subset of these (including none) alongside the 5 required
// columns; the downloadable template includes all of them as blank columns.
const OPTIONAL_TEMPLATE_COLUMNS = [
  "Street Address",
  "City",
  "State",
  "Zip",
  "Phone",
  "Email",
  "Emergency Contact Name",
  "Emergency Contact Relationship",
  "Emergency Contact Phone",
  "Preferred Language",
  "Race/Ethnicity",
  "Marital Status",
  "Occupation",
  "Insurance Provider",
  "Policy Number",
  "PCP Name",
  "Registration Date",
  "Preferred Pharmacy",
  "Blood Type",
  "Height (in)",
  "Weight (lbs)",
  "Allergies",
  "Current Medications",
  "Chronic Conditions (ICD-10)",
  "Immunization History",
  "Smoking Status",
  "Alcohol Use",
];

// Read-only look at the template's columns/example row, so users can see
// the expected format without downloading and opening it in Excel first.
// Portaled to document.body: any ancestor page wrapper uses the
// animate-rise-in utility (see globals.css), whose keyframes end on
// `transform: translateY(0)` and persist it via fill-mode "both" -- a
// non-"none" transform creates a containing block for fixed descendants,
// so without the portal this "fixed inset-0" backdrop would be contained
// within that (tall, scrolling-with-the-page) ancestor instead of the
// viewport.
// A-Z labels for the spreadsheet-letters row -- TEMPLATE_COLUMNS never gets
// close to running out of single letters, so no AA/AB wraparound needed.
function columnLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

// Narrow gutter cell shared by the letters row, the header row, and the
// data row, mimicking a real spreadsheet's row-number column. `borderBottom`
// matches whatever divider its row's other cells use, so the gridline runs
// unbroken all the way across.
function GutterCell({
  children,
  as: Tag = "td",
  borderBottom = "",
}: {
  children: ReactNode;
  as?: "td" | "th";
  borderBottom?: string;
}) {
  return (
    <Tag
      className={`w-10 border-r border-border bg-surface-hover px-2 py-2 text-center font-mono text-xs text-muted ${borderBottom}`}
    >
      {children}
    </Tag>
  );
}

function TemplatePreviewDialog({ onClose }: { onClose: () => void }) {
  useLockPageScroll();
  const [optionalColumnsExpanded, setOptionalColumnsExpanded] = useState(false);

  return createPortal(
    <div
      className="overlay-scrollbar animate-backdrop-in fixed inset-0 z-20 flex items-center justify-center overflow-y-auto bg-black/60 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-preview-title"
        onClick={(event) => event.stopPropagation()}
        className="animate-panel-in w-full max-w-2xl rounded-xl border border-border bg-surface p-6 shadow-2xl shadow-black/40 sm:p-8"
      >
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-teal/15 text-teal">
            <svg className="h-6 w-6" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="3" y="2.5" width="14" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M3 7.5h14M7.5 7.5V17.5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </div>
          <div>
            <p className="mb-1 font-mono text-xs tracking-[0.3em] text-teal uppercase">Template preview</p>
            <h2 id="template-preview-title" className="font-serif text-xl font-semibold text-foreground">
              patient-upload-template.xlsx
            </h2>
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-muted">
          Every upload must include these {TEMPLATE_COLUMNS.length} required columns, in any order.
          The row below is an example -- Patient ID must be unique per file.{" "}
          {OPTIONAL_TEMPLATE_COLUMNS.length} additional optional columns are also accepted, in any
          combination.
        </p>

        <div className="overlay-scrollbar mt-5 overflow-x-auto rounded-lg border border-border shadow-inner shadow-black/20">
          <table className="w-full min-w-120 table-fixed border-collapse text-left text-sm">
            <thead>
              <tr>
                <GutterCell as="th" borderBottom="border-b border-border"> </GutterCell>
                {TEMPLATE_COLUMNS.map((column, index) => (
                  <th
                    key={column}
                    className="border-r border-b border-border bg-background px-3 py-1 text-center font-mono text-[10px] tracking-widest text-muted uppercase last:border-r-0"
                  >
                    {columnLetter(index)}
                  </th>
                ))}
              </tr>
              <tr>
                <GutterCell as="th" borderBottom="border-b-2 border-border">
                  1
                </GutterCell>
                {TEMPLATE_COLUMNS.map((column) => (
                  <th
                    key={column}
                    className="border-r border-b-2 border-border bg-surface-hover px-3 py-2.5 font-medium whitespace-nowrap text-foreground last:border-r-0"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <GutterCell>2</GutterCell>
                {TEMPLATE_EXAMPLE_ROW.map((value, index) => (
                  <td
                    key={index}
                    className="border-r border-border px-3 py-2.5 font-mono text-xs whitespace-nowrap text-foreground last:border-r-0"
                  >
                    {value}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>

        <div className="mt-4">
          <button
            type="button"
            onClick={() => setOptionalColumnsExpanded((prev) => !prev)}
            className="text-xs font-medium text-accent hover:text-accent-hover"
          >
            {optionalColumnsExpanded ? "Hide" : "Show"} {OPTIONAL_TEMPLATE_COLUMNS.length} optional
            columns
          </button>
          {optionalColumnsExpanded && (
            <div className="overlay-scrollbar mt-2 max-h-32 overflow-y-auto rounded-md border border-border bg-background px-3 py-2">
              <p className="font-mono text-xs leading-relaxed text-muted">
                {OPTIONAL_TEMPLATE_COLUMNS.join(", ")}
              </p>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {TEMPLATE_COLUMNS.length} required, {OPTIONAL_TEMPLATE_COLUMNS.length} optional columns
          </p>
          <div className="flex gap-3">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
            <a href="/patient-upload-template.xlsx" download>
              <Button size="sm">
                <DownloadIcon className="h-4 w-4" />
                Download template
              </Button>
            </a>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default function PatientUploadCard({ onUploaded }: PatientUploadCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null); // the hidden <input type="file">, opened programmatically
  const [file, setFile] = useState<File | null>(null); // the currently-selected (not yet uploaded) file
  const [isDragging, setIsDragging] = useState(false); // drop zone highlight while a file is dragged over it
  const [clientError, setClientError] = useState<string | null>(null); // validateFile() failure message
  const [uploadError, setUploadError] = useState<string | null>(null); // backend-reported failure message
  const [isUploading, setIsUploading] = useState(false);
  // null until the first server-side progress event arrives -- the gap
  // between clicking Upload and that first event (file transfer + the
  // backend reading/validating the workbook's header) has no progress data
  // of its own, so the bar shows an indeterminate state for it instead of a
  // fake number.
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [result, setResult] = useState<PatientUploadResult | null>(null); // last successful upload's summary
  const [issuesExpanded, setIssuesExpanded] = useState(false); // whether the rejected-rows list is shown
  const [previewOpen, setPreviewOpen] = useState(false); // whether TemplatePreviewDialog is shown

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
    setProgress(null);
    setUploadError(null);

    try {
      const data = await apiUploadFileWithProgress<PatientUploadResult>("/patients/upload", file, setProgress);
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
    <>
      <div className="animate-rise-in overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40">
        <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-5 sm:px-8">
          <div>
            <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-teal uppercase">Patients</p>
            <h2 className="font-serif text-lg font-semibold text-foreground">Upload patient records</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              title="Preview template"
              aria-label="Preview template"
              className={HEADER_ICON_BUTTON_CLASS}
            >
              <EyeIcon />
            </button>
            <a
              href="/patient-upload-template.xlsx"
              download
              title="Download template"
              aria-label="Download template"
              className={HEADER_ICON_BUTTON_CLASS}
            >
              <DownloadIcon />
            </a>
          </div>
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
              {/* Before the first server progress event, the fill stays at
                  a real 0% width and the *track* pulses instead -- so once
                  real data arrives the fill just grows from where it
                  already was, instead of snapping down from a fake "full"
                  width to whatever the first real percentage is. */}
              <div
                className={`h-1.5 w-full overflow-hidden rounded-full bg-border ${
                  progress ? "" : "animate-pulse"
                }`}
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-150"
                  style={{
                    width: progress ? `${Math.round((progress.processed / progress.total) * 100)}%` : "0%",
                  }}
                />
              </div>
              <p className="mt-1.5 font-mono text-xs text-muted">
                {progress
                  ? `${progress.phase === "validating" ? "Validating" : "Saving"} ${progress.processed.toLocaleString()} of ${progress.total.toLocaleString()}`
                  : "Starting..."}
              </p>
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
                    <>
                      <ul className="overlay-scrollbar mt-2 max-h-64 space-y-1 overflow-y-auto font-mono text-xs text-muted">
                        {result.rejected.slice(0, MAX_ISSUES_SHOWN).map((row, index) => (
                          <li key={index}>
                            Row {row.row}: {row.field} — {row.reason}
                          </li>
                        ))}
                      </ul>
                      {result.rejected.length > MAX_ISSUES_SHOWN && (
                        <p className="mt-1.5 font-mono text-xs text-muted">
                          Showing the first {MAX_ISSUES_SHOWN} of {result.rejected.length} issues.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {previewOpen && <TemplatePreviewDialog onClose={() => setPreviewOpen(false)} />}
    </>
  );
}
