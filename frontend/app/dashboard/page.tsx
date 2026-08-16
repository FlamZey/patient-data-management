"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import Button from "@/components/Button";
import ConfirmDialog from "@/components/ConfirmDialog";
import NavBar from "@/components/NavBar";
import ProtectedRoute from "@/components/ProtectedRoute";
import UserFormDialog from "@/components/UserFormDialog";
import { apiDelete, apiGet, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import type { LocationRead, RoleRead, TeamRead, UserRead } from "@/lib/types";

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

function PulseDot() {
  return (
    <div className="flex justify-center py-16">
      <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
    </div>
  );
}

function UsersManagement() {
  const { currentUser } = useAuth();
  const router = useRouter();

  // currentUser is non-null by the time ProtectedRoute renders this
  // component, but its type is still User | null -- compute permissions
  // defensively rather than bailing out early, since an early return here
  // (before the hooks below) would violate the Rules of Hooks.
  const permissionCodes = currentUser?.role.permissions.map((p) => p.code) ?? [];
  const canView = permissionCodes.includes("user.view");
  const canCreate = permissionCodes.includes("user.create");
  const canEdit = permissionCodes.includes("user.edit");
  const canDelete = permissionCodes.includes("user.delete");

  const [users, setUsers] = useState<UserRead[] | null>(null);
  const [usersError, setUsersError] = useState(false);
  const [roles, setRoles] = useState<RoleRead[]>([]);
  const [locations, setLocations] = useState<LocationRead[]>([]);
  const [teams, setTeams] = useState<TeamRead[]>([]);
  const [dialogMode, setDialogMode] = useState<{ mode: "create" } | { mode: "edit"; user: UserRead } | null>(null);
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<UserRead | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      const data = await apiGet<UserRead[]>("/users");
      setUsers(data);
      setUsersError(false);
    } catch {
      setUsersError(true);
    }
  }, []);

  function retryLoadUsers() {
    setUsers(null);
    setUsersError(false);
    loadUsers();
  }

  useEffect(() => {
    // This page IS the restricted one now, so an unauthorized viewer can't
    // be sent back to itself -- /home is the safe landing spot everyone can
    // see.
    if (!canView) router.replace("/home");
  }, [canView, router]);

  useEffect(() => {
    if (!canView) return;
    (async () => {
      await loadUsers();
    })();
    // Dropdown data for the create/edit form -- failures here are
    // non-fatal to the page (the table still works), so they're swallowed
    // rather than surfaced as a page-level error.
    apiGet<RoleRead[]>("/roles").then(setRoles).catch(() => {});
    apiGet<LocationRead[]>("/locations").then(setLocations).catch(() => {});
    apiGet<TeamRead[]>("/teams").then(setTeams).catch(() => {});
  }, [canView, loadUsers]);

  function handleSaved(user: UserRead) {
    setUsers((prev) => {
      if (!prev) return prev;
      const exists = prev.some((row) => row.id === user.id);
      return exists ? prev.map((row) => (row.id === user.id ? user : row)) : [user, ...prev];
    });
    setDialogMode(null);
  }

  async function handleConfirmDelete() {
    if (!confirmDeleteUser) return;
    const targetId = confirmDeleteUser.id;
    setDeletingUserId(targetId);
    setDeleteError(null);
    try {
      await apiDelete(`/users/${targetId}`);
      setUsers((prev) => prev?.map((row) => (row.id === targetId ? { ...row, status: "suspended" } : row)) ?? prev);
      setConfirmDeleteUser(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setConfirmDeleteUser(null);
        loadUsers();
      } else {
        setDeleteError("Could not suspend this user. Please try again.");
      }
    } finally {
      setDeletingUserId(null);
    }
  }

  if (!currentUser || !canView) return null;

  return (
    <>
      <NavBar />
      <main className="min-h-screen px-4 py-10 sm:py-14">
        <div className="animate-rise-in [animation-delay:0.05s] mx-auto w-full max-w-6xl">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-muted uppercase">
                Administration
              </p>
              <h1 className="font-serif text-2xl font-semibold text-foreground">User Management</h1>
            </div>
            {canCreate && (
              <Button onClick={() => setDialogMode({ mode: "create" })}>
                <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M10 4v12M4 10h12"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                Add user
              </Button>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40">
            {users === null && !usersError && <PulseDot />}

            {usersError && (
              <div className="flex flex-col items-center gap-4 py-16 text-center">
                <p className="text-sm text-muted">Couldn&apos;t load users.</p>
                <Button variant="secondary" onClick={retryLoadUsers}>
                  Retry
                </Button>
              </div>
            )}

            {users !== null && users.length === 0 && !usersError && (
              <p className="py-16 text-center text-sm text-muted">No users found.</p>
            )}

            {users !== null && users.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-215 text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                      <th className="px-4 py-3 font-mono font-medium sm:px-6">Name</th>
                      <th className="px-4 py-3 font-mono font-medium sm:px-6">Email</th>
                      <th className="px-4 py-3 font-mono font-medium sm:px-6">Role</th>
                      <th className="px-4 py-3 font-mono font-medium sm:px-6">Location</th>
                      <th className="px-4 py-3 font-mono font-medium sm:px-6">Team</th>
                      <th className="whitespace-nowrap px-4 py-3 font-mono font-medium sm:px-6">Status</th>
                      {(canEdit || canDelete) && (
                        <th className="whitespace-nowrap px-4 py-3 font-mono font-medium sm:px-6">Actions</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((row, index) => (
                      <tr
                        key={row.id}
                        className="animate-rise-in border-b border-border last:border-b-0 hover:bg-surface-hover"
                        style={{ animationDelay: `${Math.min(index * 0.04, 0.3)}s` }}
                      >
                        <td className="px-4 py-4 align-top text-foreground sm:px-6">
                          {row.first_name} {row.last_name}
                        </td>
                        <td className="break-all px-4 py-4 align-top font-mono text-foreground sm:px-6">
                          {row.email}
                        </td>
                        <td className="px-4 py-4 align-top text-foreground sm:px-6">{row.role.display_name}</td>
                        <td className="px-4 py-4 align-top text-foreground sm:px-6">{row.location.name}</td>
                        <td className="px-4 py-4 align-top text-foreground sm:px-6">
                          {row.team ? row.team.name : "Unassigned"}
                        </td>
                        <td className="whitespace-nowrap px-4 py-4 align-top sm:px-6">
                          <StatusBadge status={row.status} />
                        </td>
                        {(canEdit || canDelete) && (
                          <td className="whitespace-nowrap px-4 py-4 align-top sm:px-6">
                            <div className="flex items-center gap-2">
                              {canEdit && (
                                <Button
                                  variant="accent-outline"
                                  size="xs"
                                  onClick={() => setDialogMode({ mode: "edit", user: row })}
                                >
                                  Edit
                                </Button>
                              )}
                              {canDelete && row.status !== "suspended" && (
                                <Button
                                  variant="danger-outline"
                                  size="xs"
                                  onClick={() => setConfirmDeleteUser(row)}
                                  disabled={deletingUserId === row.id}
                                >
                                  {deletingUserId === row.id ? "Suspending..." : "Suspend"}
                                </Button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </main>

      {dialogMode && (
        <UserFormDialog
          mode={dialogMode.mode}
          user={dialogMode.mode === "edit" ? dialogMode.user : undefined}
          roles={roles}
          locations={locations}
          teams={teams}
          onClose={() => setDialogMode(null)}
          onSaved={handleSaved}
        />
      )}

      {confirmDeleteUser && (
        <ConfirmDialog
          title="Suspend this user?"
          description={`${confirmDeleteUser.first_name} ${confirmDeleteUser.last_name} will lose access immediately. Their record is kept, not deleted.`}
          confirmLabel="Suspend"
          isConfirming={deletingUserId === confirmDeleteUser.id}
          error={deleteError}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            setConfirmDeleteUser(null);
            setDeleteError(null);
          }}
        />
      )}
    </>
  );
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <UsersManagement />
    </ProtectedRoute>
  );
}
