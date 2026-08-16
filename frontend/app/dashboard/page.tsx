"use client";

import NavBar from "@/components/NavBar";
import ProtectedRoute from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth-context";
import type { UserRead } from "@/lib/types";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-teal/15 text-teal border-teal/30",
  suspended: "bg-danger/15 text-danger border-danger/30",
  locked: "bg-danger/15 text-danger border-danger/30",
  pending: "bg-accent/15 text-accent border-accent/30",
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? "bg-muted/15 text-muted border-muted/30";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-xs uppercase tracking-wide ${style}`}
    >
      {status}
    </span>
  );
}

function initials(user: UserRead): string {
  return `${user.first_name[0] ?? ""}${user.last_name[0] ?? ""}`.toUpperCase();
}

function ProfileCard() {
  const { currentUser } = useAuth();

  // ProtectedRoute guarantees currentUser is set by the time this renders;
  // this is just to satisfy the type checker.
  if (!currentUser) return null;

  const fields: { label: string; value: string; mono?: boolean }[] = [
    { label: "Email", value: currentUser.email, mono: true },
    { label: "Username", value: currentUser.username, mono: true },
    { label: "Role", value: currentUser.role.display_name },
    { label: "Location", value: currentUser.location.name },
    { label: "Team", value: currentUser.team ? currentUser.team.name : "Unassigned" },
    { label: "Last login", value: formatDateTime(currentUser.last_login_at), mono: true },
    { label: "Member since", value: formatDateTime(currentUser.created_at), mono: true },
  ];

  return (
    <div className="reveal reveal-1 mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-5 sm:px-8">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent font-serif text-lg font-semibold text-accent-foreground">
            {initials(currentUser)}
          </div>
          <div>
            <h1 className="font-serif text-xl font-semibold text-foreground">
              {currentUser.first_name} {currentUser.last_name}
            </h1>
            <p className="font-mono text-xs tracking-wide text-muted">
              Record #{currentUser.id.slice(0, 8)}
            </p>
          </div>
        </div>
        <StatusBadge status={currentUser.status} />
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-5 px-6 py-6 sm:grid-cols-2 sm:px-8">
        {fields.map((field) => (
          <div key={field.label}>
            <dt className="font-mono text-[11px] uppercase tracking-wide text-muted">
              {field.label}
            </dt>
            <dd
              className={`mt-1 text-sm text-foreground ${field.mono ? "font-mono" : ""}`}
            >
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <NavBar />
      <main className="min-h-screen px-4 py-10 sm:py-14">
        <ProfileCard />
      </main>
    </ProtectedRoute>
  );
}
