// Shared account-status pill, used on both the Manage Users table and the
// Settings profile card so the color mapping only lives in one place.
const STATUS_STYLES: Record<string, string> = {
  active: "bg-teal/15 text-teal border-teal/30",
  suspended: "bg-danger/15 text-danger border-danger/30",
  locked: "bg-danger/15 text-danger border-danger/30",
  pending: "bg-accent/15 text-accent border-accent/30",
};

export default function StatusBadge({ status }: { status: string }) {
  // Falls back to a neutral style for any status not in the map above.
  const style = STATUS_STYLES[status] ?? "bg-muted/15 text-muted border-muted/30";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-xs uppercase tracking-wide ${style}`}
    >
      {status}
    </span>
  );
}
