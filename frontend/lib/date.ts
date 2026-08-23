// Date-only (no time-of-day) helpers for "YYYY-MM-DD" values, as used by
// the patient date_of_birth field. All parsing/formatting builds Date
// objects from local Y/M/D components rather than `new Date(iso)` --
// that constructor treats a bare YYYY-MM-DD as UTC midnight, which
// toLocaleDateString then renders in the viewer's local time zone and can
// roll the displayed day back by one west of UTC.

// Parses "YYYY-MM-DD" into a local-midnight Date; undefined if malformed.
export function parseISODateLocal(iso: string): Date | undefined {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// Formats a local Date back into "YYYY-MM-DD" (inverse of parseISODateLocal).
export function toISODateLocal(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// "1920-01-10" -> "Jan 10, 1920"
export function formatDateDisplay(iso: string): string {
  const date = parseISODateLocal(iso);
  if (!date) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
