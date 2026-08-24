"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";

import Button from "@/components/Button";
import {
  ColumnFilterPanel,
  ColumnFilterTrigger,
  useColumnFilterPopover,
  type ColumnFilterConfig,
} from "@/components/ColumnFilters";
import ConfirmDialog from "@/components/ConfirmDialog";
import Spinner from "@/components/Spinner";
import StatusBadge from "@/components/StatusBadge";
import UserFormDialog from "@/components/UserFormDialog";
import { apiDelete, apiGet, apiGetUsers, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/permissions";
import type { LocationRead, RoleRead, TeamRead, UserRead } from "@/lib/types";

const STATUSES = ["active", "suspended", "locked", "pending"]; // closed set the Status checklist filters over
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const COLUMN_WIDTHS: Record<string, string> = {
  name: "w-48",
  email: "w-56",
  role: "w-36",
  location: "w-36",
  team: "w-36",
  status: "w-28",
  actions: "w-40",
};

// Small ↑/↓ arrow shown next to a sorted column's header.
function sortIndicator(direction: false | "asc" | "desc") {
  if (!direction) return null;
  return <span className="ml-1">{direction === "asc" ? "↑" : "↓"}</span>;
}

const columnHelper = createColumnHelper<UserRead>();

// Self-contained the way PatientTable is: owns its own fetch (server-driven
// sort/filter/pagination via GET /users), loading/error state, and
// permission checks, so the page that renders it stays a thin shell.
export default function UserManagementTable() {
  const { currentUser } = useAuth();
  const canCreate = hasPermission(currentUser, "user.create"); // shows the "Add user" button
  const canEdit = hasPermission(currentUser, "user.edit"); // shows the Edit action + column
  const canDelete = hasPermission(currentUser, "user.delete"); // shows the Suspend action + column

  const [users, setUsers] = useState<UserRead[] | null>(null); // null until the first load resolves
  const [total, setTotal] = useState(0); // total matching rows across all pages
  const [usersError, setUsersError] = useState(false);
  const [roles, setRoles] = useState<RoleRead[]>([]); // Role checklist options + UserFormDialog dropdown
  const [locations, setLocations] = useState<LocationRead[]>([]); // Location checklist options + dropdown
  const [teams, setTeams] = useState<TeamRead[]>([]); // Team checklist options + dropdown

  // Raw (per-keystroke) and debounced (actually-queried) values for the
  // text filters.
  const [nameInput, setNameInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [emailFilter, setEmailFilter] = useState("");
  // Closed-set columns filtered via a checklist -- all checked means "no
  // filtering", populated once each lookup list loads (see loadLookups).
  // Unchecking everything matches no rows, same as any filter combination
  // that matches nothing.
  const [roleFilter, setRoleFilter] = useState<string[]>([]);
  const [locationFilter, setLocationFilter] = useState<string[]>([]);
  // "Unassigned" is a real, always-present option (unlike role/location,
  // which have zero options until their lookups load) -- seeding it here
  // means an unloaded teams list still reads as "fully selected", not as a
  // user-driven "matches nothing".
  const [teamFilter, setTeamFilter] = useState<string[]>(["Unassigned"]);
  const [statusFilter, setStatusFilter] = useState<string[]>(STATUSES);
  const { openFilterColumn, filterAnchorRect, filterPanelRef, toggleFilterOpen, registerFilterButton } =
    useColumnFilterPopover();
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]); // tanstack's single-column sort state
  const [page, setPage] = useState(1); // 1-indexed current page
  const [pageSize, setPageSize] = useState(25);

  // "create" opens a blank form; "edit" opens it pre-filled for one row.
  const [dialogMode, setDialogMode] = useState<{ mode: "create" } | { mode: "edit"; user: UserRead } | null>(null);
  const [confirmDeleteUser, setConfirmDeleteUser] = useState<UserRead | null>(null); // row pending suspend confirmation
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null); // id currently being suspended
  const [deleteError, setDeleteError] = useState<string | null>(null); // shown in the confirm dialog on failure

  // Debounce the text filter inputs so every keystroke doesn't fire a
  // request -- both commit together, same 300ms window.
  useEffect(() => {
    const handle = setTimeout(() => {
      setNameFilter(nameInput);
      setEmailFilter(emailInput);
    }, 300);
    return () => clearTimeout(handle);
  }, [nameInput, emailInput]);

  // A changed filter/sort/page-size invalidates the current page number.
  useEffect(() => {
    setPage(1);
  }, [nameFilter, emailFilter, roleFilter, locationFilter, teamFilter, statusFilter, sorting, pageSize]);

  // Derived from tanstack's sorting state -- single-column sort only.
  const sortBy = (sorting[0]?.id ?? "name") as "name" | "email" | "role" | "location" | "team" | "status";
  const sortDir = sorting[0]?.desc ? "desc" : "asc";

  // Tracks the last request actually sent to the server, so a loadUsers
  // recreation that doesn't change what would be sent (see below) skips
  // the network round trip instead of repeating an identical fetch.
  const lastRequestKeyRef = useRef<string | null>(null);

  // Fetches the current page from the server using all active filters/
  // sort/pagination state.
  const loadUsers = useCallback(async () => {
    // An empty checklist matches nothing -- short-circuit rather than
    // sending an empty query param, which the API reads as "no filter"
    // (every row) instead of "no rows". Role/location only count as
    // "blocking" once their lookup has actually loaded (roles.length > 0)
    // -- otherwise an unloaded, options-less checklist would misread as a
    // user having unchecked everything.
    const roleBlocksAll = roles.length > 0 && roleFilter.length === 0;
    const locationBlocksAll = locations.length > 0 && locationFilter.length === 0;
    if (roleBlocksAll || locationBlocksAll || teamFilter.length === 0 || statusFilter.length === 0) {
      setUsers([]);
      setTotal(0);
      setUsersError(false);
      return;
    }

    const params: Parameters<typeof apiGetUsers>[0] = {
      name: nameFilter || undefined,
      email: emailFilter || undefined,
      // Only sent once a lookup-backed checklist has been narrowed --
      // fully checked means "no filtering"; empty is handled above. Role/
      // location start with no options until their lookups load, so they
      // stay unsent (no filtering) until then.
      role: roles.length > 0 && roleFilter.length < roles.length ? roleFilter : undefined,
      location: locations.length > 0 && locationFilter.length < locations.length ? locationFilter : undefined,
      team: teamFilter.length < teams.length + 1 ? teamFilter : undefined,
      status: statusFilter.length < STATUSES.length ? statusFilter : undefined,
      sort_by: sortBy,
      sort_dir: sortDir,
      page,
      page_size: pageSize,
    };

    // loadUsers gets recreated (and re-runs) whenever any checklist's array
    // reference changes -- including a lookup finishing its initial "fully
    // selected" seed, which doesn't change what's actually sent. Skip the
    // request entirely when it's byte-identical to the last one, rather
    // than round-tripping to the server for no reason.
    const requestKey = JSON.stringify(params);
    if (requestKey === lastRequestKeyRef.current) return;
    lastRequestKeyRef.current = requestKey;

    try {
      const data = await apiGetUsers(params);
      setUsers(data.items);
      setTotal(data.total);
      setUsersError(false);
    } catch {
      setUsersError(true);
    }
  }, [
    nameFilter,
    emailFilter,
    roleFilter,
    locationFilter,
    teamFilter,
    statusFilter,
    roles.length,
    locations.length,
    teams.length,
    sortBy,
    sortDir,
    page,
    pageSize,
  ]);

  function retryLoadUsers() {
    setUsers(null);
    setUsersError(false);
    // Bypasses the dedup guard in loadUsers -- the last attempt (even if it
    // failed) already claimed this params key, so without this reset a
    // same-params retry would be silently skipped as "no change".
    lastRequestKeyRef.current = null;
    loadUsers();
  }

  useEffect(() => {
    (async () => {
      await loadUsers();
    })();
  }, [loadUsers]);

  // Dropdown/checklist data loads once on mount -- failures here are
  // non-fatal (the table still works), so they're swallowed rather than
  // surfaced as a page-level error. Each list also seeds its checklist
  // filter fully-checked ("no filtering") the moment it arrives.
  useEffect(() => {
    // Guarded by data.length > 0 so an empty lookup doesn't hand the filter
    // state a fresh-but-equivalent [] reference -- that would still count
    // as a change and re-trigger loadUsers for no reason.
    apiGet<RoleRead[]>("/roles").then((data) => {
      setRoles(data);
      if (data.length > 0) setRoleFilter(data.map((role) => role.display_name));
    }).catch(() => {});
    apiGet<LocationRead[]>("/locations").then((data) => {
      setLocations(data);
      if (data.length > 0) setLocationFilter(data.map((location) => location.name));
    }).catch(() => {});
    apiGet<TeamRead[]>("/teams").then((data) => {
      setTeams(data);
      // Merge rather than overwrite -- teamFilter already seeded
      // "Unassigned" at mount (see its useState above).
      if (data.length > 0) {
        setTeamFilter((prev) => [...new Set([...prev, ...data.map((team) => team.name)])]);
      }
    }).catch(() => {});
  }, []);

  // An edit replaces the row in place -- total and page contents don't
  // change. A create can't be patched in locally without knowing where the
  // new row lands in the current sort/filter and without invalidating
  // `total`, so it re-fetches instead (bypassing the dedup guard the same
  // way retryLoadUsers/the 404 branch above do).
  function handleSaved(user: UserRead) {
    setDialogMode(null);
    const isNewUser = !users?.some((row) => row.id === user.id);
    if (isNewUser) {
      lastRequestKeyRef.current = null;
      loadUsers();
    } else {
      setUsers((prev) => prev?.map((row) => (row.id === user.id ? user : row)) ?? prev);
    }
  }

  // Suspends (soft-deletes) the user pending confirmation, flipping their
  // status in place on success.
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
        // Already gone -- close the dialog and refresh instead of showing
        // an error for a row that no longer exists. Bypass the dedup guard
        // (see retryLoadUsers) since the list needs to actually re-fetch
        // even though the request params haven't changed.
        setConfirmDeleteUser(null);
        lastRequestKeyRef.current = null;
        loadUsers();
      } else {
        setDeleteError("Could not suspend this user. Please try again.");
      }
    } finally {
      setDeletingUserId(null);
    }
  }

  // Column definitions -- Name/Role/Location/Team are derived (computed
  // from nested fields), the rest map straight to a UserRead field.
  const columns = useMemo(() => {
    // `any` here is TanStack's own documented pattern for a column list
    // spanning columns with different accessor value types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: ColumnDef<UserRead, any>[] = [
      columnHelper.accessor((row) => `${row.first_name} ${row.last_name}`, {
        id: "name",
        header: "Name",
      }),
      columnHelper.accessor("email", {
        header: "Email",
        cell: (info) => <span className="font-mono">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.role.display_name, {
        id: "role",
        header: "Role",
      }),
      columnHelper.accessor((row) => row.location.name, {
        id: "location",
        header: "Location",
      }),
      columnHelper.accessor((row) => (row.team ? row.team.name : "Unassigned"), {
        id: "team",
        header: "Team",
      }),
      columnHelper.accessor("status", {
        header: "Status",
        cell: (info) => <StatusBadge status={info.getValue()} />,
      }),
    ];

    // Actions column (Edit/Suspend) only exists when at least one is allowed.
    if (canEdit || canDelete) {
      base.push(
        columnHelper.display({
          id: "actions",
          header: "Actions",
          cell: (info) => {
            const row = info.row.original;
            return (
              <div className="flex items-center gap-2">
                {canEdit && (
                  <Button variant="accent-outline" size="xs" onClick={() => setDialogMode({ mode: "edit", user: row })}>
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
            );
          },
        }),
      );
    }

    return base;
  }, [canEdit, canDelete, deletingUserId]);

  // Generic checklist toggle: flips one option in/out of the selected set.
  function toggleChecklistOption(setter: (updater: (prev: string[]) => string[]) => void, option: string) {
    setter((prev) => (prev.includes(option) ? prev.filter((value) => value !== option) : [...prev, option]));
  }

  // Generic select-all / clear-all for a checklist.
  function toggleChecklistAll(setter: (value: string[]) => void, current: string[], options: string[]) {
    setter(current.length === options.length ? [] : [...options]);
  }

  const roleOptions = roles.map((role) => role.display_name);
  const locationOptions = locations.map((location) => location.name);
  const teamOptions = [...teams.map((team) => team.name), "Unassigned"];

  // Maps each column id to its filter's config -- read by the header row
  // to decide which trigger/popover to render.
  const columnFilters: Record<string, Exclude<ColumnFilterConfig, { kind: "date-range" }>> = {
    name: { kind: "text", label: "Name", value: nameInput, onChange: setNameInput },
    email: { kind: "text", label: "Email", value: emailInput, onChange: setEmailInput },
    role: {
      kind: "checklist",
      label: "Role",
      options: roleOptions,
      selected: roleFilter,
      onToggleOption: (option) => toggleChecklistOption(setRoleFilter, option),
      onToggleAll: () => toggleChecklistAll(setRoleFilter, roleFilter, roleOptions),
    },
    location: {
      kind: "checklist",
      label: "Location",
      options: locationOptions,
      selected: locationFilter,
      onToggleOption: (option) => toggleChecklistOption(setLocationFilter, option),
      onToggleAll: () => toggleChecklistAll(setLocationFilter, locationFilter, locationOptions),
    },
    team: {
      kind: "checklist",
      label: "Team",
      options: teamOptions,
      selected: teamFilter,
      onToggleOption: (option) => toggleChecklistOption(setTeamFilter, option),
      onToggleAll: () => toggleChecklistAll(setTeamFilter, teamFilter, teamOptions),
    },
    status: {
      kind: "checklist",
      label: "Status",
      options: STATUSES,
      selected: statusFilter,
      onToggleOption: (option) => toggleChecklistOption(setStatusFilter, option),
      onToggleAll: () => toggleChecklistAll(setStatusFilter, statusFilter, STATUSES),
    },
  };

  const table = useReactTable({
    data: users ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    manualSorting: true, // sorting happens server-side via sortBy/sortDir above
    enableMultiSort: false,
    enableSortingRemoval: true, // clicking a sorted column a third time clears the sort
    getCoreRowModel: getCoreRowModel(),
  });

  // "X–Y of Z" pagination label inputs.
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const columnCount = table.getVisibleLeafColumns().length; // for colSpan on the empty-state row

  const activeColumnFilter = openFilterColumn ? columnFilters[openFilterColumn] : undefined;

  if (!currentUser) return null; // guards render before auth resolves; ProtectedRoute normally prevents this

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 font-mono text-xs tracking-[0.3em] text-muted uppercase">Administration</p>
          <h1 className="font-serif text-2xl font-semibold text-foreground">User Management</h1>
        </div>
        {canCreate && (
          <Button onClick={() => setDialogMode({ mode: "create" })}>
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Add user
          </Button>
        )}
      </div>

      <div className="animate-rise-in overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/40">
        {users === null && !usersError && (
          <div className="flex justify-center py-16">
            <Spinner size="md" className="text-accent" />
          </div>
        )}

        {usersError && (
          <div className="flex flex-col items-center gap-4 py-16 text-center">
            <p className="text-sm text-muted">Couldn&apos;t load users.</p>
            <Button variant="secondary" onClick={retryLoadUsers}>
              Retry
            </Button>
          </div>
        )}

        {users !== null && !usersError && (
          <div className="overflow-x-auto overflow-y-hidden">
            <table className="w-full min-w-215 table-fixed text-left text-sm">
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id} className="border-b border-border text-xs uppercase tracking-wide text-muted">
                    {headerGroup.headers.map((header, index) => {
                      const columnFilter = columnFilters[header.column.id];
                      const isLast = index === headerGroup.headers.length - 1;
                      return (
                        <th
                          key={header.id}
                          className={`relative px-4 py-3 align-top font-mono font-medium sm:px-6 ${COLUMN_WIDTHS[header.column.id] ?? ""}`}
                        >
                          <div className="flex items-center justify-between gap-1.5">
                            {header.column.getCanSort() ? (
                              <button
                                type="button"
                                onClick={header.column.getToggleSortingHandler()}
                                className="flex items-center gap-1 transition-colors hover:text-foreground"
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                {sortIndicator(header.column.getIsSorted())}
                              </button>
                            ) : (
                              flexRender(header.column.columnDef.header, header.getContext())
                            )}
                            {columnFilter && (
                              <ColumnFilterTrigger
                                config={columnFilter}
                                isOpen={openFilterColumn === header.column.id}
                                onToggle={() => toggleFilterOpen(header.column.id)}
                                registerRef={registerFilterButton(header.column.id)}
                              />
                            )}
                          </div>
                          {!isLast && (
                            <span className="pointer-events-none absolute right-0 top-1/2 h-4 w-px -translate-y-1/2 bg-border" />
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {users.length === 0 && (
                  <tr>
                    <td colSpan={columnCount} className="py-16 text-center text-sm text-muted">
                      No users found.
                    </td>
                  </tr>
                )}
                {table.getRowModel().rows.map((row, index) => (
                  <tr
                    key={row.id}
                    className="animate-rise-in border-b border-border last:border-b-0 hover:bg-surface-hover"
                    style={{ animationDelay: `${Math.min(index * 0.04, 0.3)}s` }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-4 align-top text-foreground sm:px-6">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border px-6 py-4 sm:px-8">
          <p className="font-mono text-xs text-muted">
            {total === 0 ? "0 of 0" : `${start}–${end} of ${total}`}
          </p>
          <div className="flex items-center gap-3">
            <select
              value={pageSize}
              onChange={(event) => setPageSize(Number(event.target.value))}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground transition-colors focus:border-accent focus:outline-none"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size} / page
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="xs"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={page <= 1}
              >
                Prev
              </Button>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => setPage((prev) => prev + 1)}
                disabled={page * pageSize >= total}
              >
                Next
              </Button>
            </div>
          </div>
        </div>
      </div>

      <ColumnFilterPanel activeFilter={activeColumnFilter} anchorRect={filterAnchorRect} panelRef={filterPanelRef} />

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
