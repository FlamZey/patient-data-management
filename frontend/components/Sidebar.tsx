"use client";

import Link from "next/link";

import BrandMark from "@/components/BrandMark";
import Button from "@/components/Button";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, PERMISSIONS, type PermissionCode } from "@/lib/permissions";

// First + last initials for the avatar circle, e.g. "Ada Lovelace" -> "AL".
// Mirrors settings/page.tsx's ProfileCard.
function initials(firstName: string, lastName: string): string {
  return `${firstName[0] ?? ""}${lastName[0] ?? ""}`.toUpperCase();
}

// One entry in the sidebar's nav -- which route it links to, and the
// permission that both gates showing it and (server-side) gates the route
// itself, so the sidebar never offers a destination that would just 403.
interface NavItem {
  key: SidebarSection;
  label: string;
  href: string;
  permission: PermissionCode;
}

export type SidebarSection = "dashboard" | "data-analysis" | "manage-users" | "audit-log";

const PRIMARY_ITEM: NavItem = {
  key: "dashboard",
  label: "Patients & records",
  href: "/dashboard",
  permission: PERMISSIONS.patientView,
};

// Admin-facing destinations, grouped under "Practice" the way the reference
// layout does -- each gated on the same permission its own page checks.
const PRACTICE_ITEMS: NavItem[] = [
  { key: "data-analysis", label: "Data analysis", href: "/data-analysis", permission: PERMISSIONS.patientView },
  { key: "manage-users", label: "Manage users", href: "/manage-users", permission: PERMISSIONS.userView },
  { key: "audit-log", label: "Audit log", href: "/audit-log", permission: PERMISSIONS.auditView },
];

function NavLink({ item, isActive }: { item: NavItem; isActive: boolean }) {
  return (
    <Link
      href={item.href}
      className={`rounded-md px-2.5 py-2 text-sm transition-colors ${
        isActive ? "bg-accent/10 text-accent" : "text-foreground hover:bg-surface-hover"
      }`}
    >
      {item.label}
    </Link>
  );
}

// Left rail shown on every authenticated page -- brand, profile, and the
// permission-gated destinations that used to be NavBar's top-bar links (plus
// Data analysis and Audit log, previously sections embedded inside the
// patients and manage-users pages, now first-class destinations of their
// own). `active` names which item, if any, is the current page -- each page
// passes its own key rather than this component inferring it from the URL.
export default function Sidebar({ active }: { active?: SidebarSection }) {
  const { currentUser, logout } = useAuth();

  if (!currentUser) return null;

  const showPrimary = hasPermission(currentUser, PRIMARY_ITEM.permission);
  const practiceItems = PRACTICE_ITEMS.filter((item) => hasPermission(currentUser, item.permission));

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-4 border-r border-border bg-surface px-3.5 py-4">
      <Link href="/home" className="flex items-center gap-2.5 rounded-md px-1.5 py-1">
        <BrandMark size={22} />
        <span className="font-serif text-sm text-foreground">Records</span>
      </Link>

      <div className="flex items-center gap-2.5 border-y border-border py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/60 bg-accent/15 text-xs text-accent">
          {initials(currentUser.first_name, currentUser.last_name)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">
            {currentUser.first_name} {currentUser.last_name}
          </p>
          <p className="truncate font-mono text-[11px] uppercase tracking-wide text-muted">
            {currentUser.role.display_name}
          </p>
        </div>
        <Link
          href="/settings"
          aria-label="Settings"
          title="Settings"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M16.17 12.5a1.38 1.38 0 0 0 .28 1.52l.05.05a1.67 1.67 0 1 1-2.36 2.36l-.05-.05a1.38 1.38 0 0 0-1.52-.28 1.38 1.38 0 0 0-.84 1.27v.13a1.67 1.67 0 1 1-3.33 0v-.07a1.38 1.38 0 0 0-.9-1.26 1.38 1.38 0 0 0-1.52.28l-.05.05a1.67 1.67 0 1 1-2.36-2.36l.05-.05a1.38 1.38 0 0 0 .28-1.52 1.38 1.38 0 0 0-1.27-.84h-.13a1.67 1.67 0 1 1 0-3.33h.07a1.38 1.38 0 0 0 1.26-.9 1.38 1.38 0 0 0-.28-1.52l-.05-.05a1.67 1.67 0 1 1 2.36-2.36l.05.05a1.38 1.38 0 0 0 1.52.28h.06a1.38 1.38 0 0 0 .84-1.27v-.13a1.67 1.67 0 1 1 3.33 0v.07a1.38 1.38 0 0 0 .84 1.26 1.38 1.38 0 0 0 1.52-.28l.05-.05a1.67 1.67 0 1 1 2.36 2.36l-.05.05a1.38 1.38 0 0 0-.28 1.52v.06a1.38 1.38 0 0 0 1.27.84h.13a1.67 1.67 0 1 1 0 3.33h-.07a1.38 1.38 0 0 0-1.26.84Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      </div>

      {showPrimary && (
        <nav className="flex flex-col gap-0.5" aria-label="Primary">
          <NavLink item={PRIMARY_ITEM} isActive={active === PRIMARY_ITEM.key} />
        </nav>
      )}

      {practiceItems.length > 0 && (
        <nav className="flex flex-col gap-0.5" aria-label="Practice">
          <p className="px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-muted">Practice</p>
          {practiceItems.map((item) => (
            <NavLink key={item.key} item={item} isActive={active === item.key} />
          ))}
        </nav>
      )}

      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
        <Button variant="secondary" size="sm" onClick={() => logout()}>
          Logout
        </Button>
      </div>
    </aside>
  );
}
