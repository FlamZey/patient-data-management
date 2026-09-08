"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createColumnHelper, type ColumnDef, type SortingState } from "@tanstack/react-table";

import Button from "@/components/Button";
import { type ColumnFilterConfig } from "@/components/tables/ColumnFilters";
import StatusBadge from "@/components/StatusBadge";
import {
  CellActions,
  CellFieldError,
  checklistFilter,
  DataTableCard,
  InlineEditActionsCell,
  MonoCell,
  tableInputClass,
  TextCell,
  textFilter,
  useDataTable,
  useDebouncedFilters,
  useInlineRowEdit,
  useTablePagination,
} from "@/components/tables/table-primitives";
import UserFormDialog from "@/components/tables/UserFormDialog";
import { apiGet, apiGetUsers, apiPatch, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { canAdministerUser, hasPermission, PERMISSIONS, userEditCapabilities } from "@/lib/permissions";
import { isBlank } from "@/lib/text";
import type { LocationRead, RoleSummary, TeamRead, UserRead, UserUpdate } from "@/lib/types";

// Mirrors UserFormDialog's own EMAIL_PATTERN -- not imported from there
// since that module is a component (mocked wholesale in this table's own
// tests), not a natural home for a shared constant.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATUSES = ["active", "suspended", "locked", "pending"]; // closed set the Status checklist filters over
// Fixed per-column widths (table-layout: fixed) must sum to fit the page's
// max-w-7xl container without a horizontal scrollbar; see app/manage-users/
// page.tsx. Actions is sized for its *editing* state (Cancel + Save), not the lone Edit button.
const COLUMN_WIDTHS: Record<string, string> = {
  name: "w-48",
  email: "w-56",
  username: "w-32",
  role: "w-36",
  location: "w-36",
  team: "w-36",
  status: "w-28",
  actions: "w-40",
};

// The row currently being edited, as free-form strings bound directly to
// inputs/selects. role_id/location_id/team_id resolve back to full objects
// in toRow below; team_id "" means Unassigned.
interface UserEditDraft {
  // Lets this satisfy useInlineRowEdit's InlineEditDraft constraint -- see
  // PatientTable's EditDraft for why. The named properties below still get
  // their own typo/completeness checking.
  [key: string]: string;
  first_name: string;
  last_name: string;
  email: string;
  username: string;
  status: string;
  role_id: string;
  location_id: string;
  team_id: string;
}

// Mirrors UserFormDialog's own validate() minus the password field, which
// only applies to that dialog's "create" mode.
function validateDraft(draft: UserEditDraft): {
  first_name?: string;
  last_name?: string;
  email?: string;
  username?: string;
  status?: string;
  role_id?: string;
  location_id?: string;
} {
  const errors: ReturnType<typeof validateDraft> = {};

  if (isBlank(draft.first_name)) errors.first_name = "First name is required.";
  if (isBlank(draft.last_name)) errors.last_name = "Last name is required.";
  if (isBlank(draft.email)) errors.email = "Email is required.";
  else if (!EMAIL_PATTERN.test(draft.email.trim())) errors.email = "Enter a valid email address.";
  if (isBlank(draft.username)) errors.username = "Username is required.";
  if (!STATUSES.includes(draft.status)) errors.status = "Must be one of the listed options.";
  if (!draft.role_id) errors.role_id = "Role is required.";
  if (!draft.location_id) errors.location_id = "Location is required.";

  return errors;
}

const columnHelper = createColumnHelper<UserRead>();

// Self-contained the way PatientTable is: owns its own fetch (server-driven
// sort/filter/pagination via GET /users), loading/error state, so the page
// that renders it stays a thin shell.
export default function UserManagementTable() {
  const { currentUser } = useAuth();
  // Creating an account also assigns it a role, which the API authorizes as a
  // role assignment -- so the "Add user" button needs both, or the form would
  // only ever submit into a 403.
  const canCreate =
    hasPermission(currentUser, PERMISSIONS.userCreate) && hasPermission(currentUser, PERMISSIONS.roleAssign);
  // Profile edits, role assignment, and status changes are three separate
  // server-side authorizations, so they gate three separate controls here --
  // a caller holding only one gets an edit row where only that field is editable.
  const { canEditProfile, canAssignRole, canChangeStatus, canEditAnything } =
    userEditCapabilities(currentUser);

  const [users, setUsers] = useState<UserRead[] | null>(null); // null until the first load resolves
  const [total, setTotal] = useState(0); // total matching rows across all pages
  const [usersError, setUsersError] = useState(false);
  const [isFetching, setIsFetching] = useState(false); // true while a sort/filter/page reload is in flight
  const [roles, setRoles] = useState<RoleSummary[]>([]); // Role checklist options + inline-edit/create dropdown
  const [locations, setLocations] = useState<LocationRead[]>([]); // Location checklist options + dropdown
  const [teams, setTeams] = useState<TeamRead[]>([]); // Team checklist options + dropdown

  // Per-keystroke values for each text column's filter input; the debounced
  // copy below is what actually gets queried.
  const [nameInput, setNameInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const { name: nameFilter, email: emailFilter } = useDebouncedFilters({
    name: nameInput,
    email: emailInput,
  });
  // Closed-set columns filtered via a checklist -- all checked means "no
  // filtering", populated once each lookup loads. Unchecking everything
  // matches no rows.
  const [roleFilter, setRoleFilter] = useState<string[]>([]);
  const [locationFilter, setLocationFilter] = useState<string[]>([]);
  // "Unassigned" is always present (unlike role/location, which start
  // empty until their lookups load) -- seeded here so an unloaded teams
  // list reads as "fully selected", not a user-driven "matches nothing".
  const [teamFilter, setTeamFilter] = useState<string[]>(["Unassigned"]);
  const [statusFilter, setStatusFilter] = useState<string[]>(STATUSES);
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]); // tanstack's single-column sort state
  // 1-indexed page + page size; any change to the filters or sort above
  // sends it back to page 1.
  const { page, setPage, pageSize, setPageSize } = useTablePagination(25, [
    nameFilter,
    emailFilter,
    roleFilter,
    locationFilter,
    teamFilter,
    statusFilter,
    sorting,
  ]);

  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // Ancestor lookup for the role-hierarchy walk (canAdministerUser). Only
  // holds ACTIVE roles -- a chain through a deactivated one is unresolvable,
  // and the helper falls back to letting the backend decide.
  const rolesById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);

  // Derived from tanstack's sorting state -- single-column sort only.
  const sortBy = (sorting[0]?.id ?? "name") as "name" | "email" | "role" | "location" | "team" | "status";
  const sortDir = sorting[0]?.desc ? "desc" : "asc";

  // Tracks the last request actually sent to the server, so a loadUsers
  // recreation that doesn't change what would be sent (see below) skips
  // the network round trip instead of repeating an identical fetch.
  const lastRequestKeyRef = useRef<string | null>(null);
  // Guards against an older, slower response overwriting a newer one's --
  // loadUsers claims the next id before going async and only applies its
  // result if still latest. Separate from lastRequestKeyRef's dedup concern.
  const latestRequestIdRef = useRef(0);

  // Fetches the current page from the server using all active filters/
  // sort/pagination state.
  const loadUsers = useCallback(async () => {
    // An empty checklist matches nothing -- short-circuit rather than
    // sending an empty param, which the API reads as "no filter". Role/
    // location only block once their lookup has actually loaded.
    const roleBlocksAll = roles.length > 0 && roleFilter.length === 0;
    const locationBlocksAll = locations.length > 0 && locationFilter.length === 0;
    if (roleBlocksAll || locationBlocksAll || teamFilter.length === 0 || statusFilter.length === 0) {
      ++latestRequestIdRef.current;
      // Invalidate the dedup guard -- otherwise re-selecting everything
      // reproduces pre-touch params, and the guard below would skip that
      // real request, leaving the table stuck on this empty result.
      lastRequestKeyRef.current = null;
      setUsers([]);
      setTotal(0);
      setUsersError(false);
      return;
    }

    const params: Parameters<typeof apiGetUsers>[0] = {
      name: nameFilter || undefined,
      email: emailFilter || undefined,
      // Only sent once a lookup-backed checklist is narrowed -- fully
      // checked means "no filtering". Role/location stay unsent until
      // their lookups load.
      role: roles.length > 0 && roleFilter.length < roles.length ? roleFilter : undefined,
      location: locations.length > 0 && locationFilter.length < locations.length ? locationFilter : undefined,
      team: teamFilter.length < teams.length + 1 ? teamFilter : undefined,
      status: statusFilter.length < STATUSES.length ? statusFilter : undefined,
      sort_by: sortBy,
      sort_dir: sortDir,
      page,
      page_size: pageSize,
    };

    // loadUsers recreates whenever a checklist's array reference changes,
    // including a lookup's initial seed, which sends nothing new. Skip the
    // request entirely when it's byte-identical to the last one.
    const requestKey = JSON.stringify(params);
    if (requestKey === lastRequestKeyRef.current) return;
    lastRequestKeyRef.current = requestKey;

    // Claimed here, not at the top: a call that bails out via the dedup
    // guard above changes nothing and must not count as "the latest" --
    // otherwise it'd invalidate a real in-flight duplicate that never gets replaced.
    const requestId = ++latestRequestIdRef.current;

    setIsFetching(true);
    try {
      const data = await apiGetUsers(params);
      // A newer request already started (and will apply its own result) by
      // the time this one resolved -- discard rather than clobber it.
      if (requestId !== latestRequestIdRef.current) return;
      setUsers(data.items);
      setTotal(data.total);
      setUsersError(false);
    } catch {
      if (requestId !== latestRequestIdRef.current) return;
      setUsersError(true);
    } finally {
      if (requestId === latestRequestIdRef.current) setIsFetching(false);
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

  // Dropdown/checklist data loads once on mount -- failures are non-fatal
  // (the table still works) so they're swallowed. Each list seeds its
  // checklist fully-checked ("no filtering") the moment it arrives.
  useEffect(() => {
    // Guarded by data.length > 0 so an empty lookup doesn't hand the filter
    // state a fresh-but-equivalent [] reference -- that would still count
    // as a change and re-trigger loadUsers for no reason.
    apiGet<RoleSummary[]>("/roles").then((data) => {
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

  // Inline-edit lifecycle (edit/save/rollback, one row at a time) -- shared
  // with PatientTable via useInlineRowEdit; only the draft shape,
  // field-level validation, and column defs below are this table's own.
  const inlineEdit = useInlineRowEdit<UserRead, UserEditDraft>({
    setRows: setUsers,
    // Resolves each select's id string back to the full looked-up object
    // for the optimistic row -- unlike PatientTable's plain spread, this
    // table's role/location/team are foreign keys, not inline strings.
    toRow: (user, draft) => {
      // Merged, not substituted: the lookup gives a RoleSummary (no grants)
      // while the row's role is a full RoleRead -- spreading over it keeps
      // the type intact, harmless since the server's response replaces it.
      const pickedRole = roles.find((candidate) => String(candidate.id) === draft.role_id);
      const role = pickedRole ? { ...user.role, ...pickedRole } : user.role;
      const location = locations.find((candidate) => String(candidate.id) === draft.location_id) ?? user.location;
      const team = draft.team_id
        ? (teams.find((candidate) => String(candidate.id) === draft.team_id) ?? user.team)
        : null;
      return {
        ...user,
        first_name: draft.first_name.trim(),
        last_name: draft.last_name.trim(),
        email: draft.email.trim(),
        username: draft.username.trim(),
        status: draft.status,
        role,
        location,
        team,
      };
    },
    // First/last name share the single "name" column, so a change to
    // either flashes and sends that one field pair together.
    changedFields: (draft, user) => {
      const fields: string[] = [];
      if (canEditProfile) {
        if (draft.first_name !== user.first_name || draft.last_name !== user.last_name) fields.push("name");
        if (draft.email !== user.email) fields.push("email");
        if (draft.username !== user.username) fields.push("username");
        if (draft.location_id !== String(user.location.id)) fields.push("location");
        if (draft.team_id !== (user.team ? String(user.team.id) : "")) fields.push("team");
      }
      // Gated the same way the inputs are: a privileged field the caller
      // can't change never reaches the payload, so a tampered draft can't
      // turn a profile edit into a role change.
      if (canChangeStatus && draft.status !== user.status) fields.push("status");
      if (canAssignRole && draft.role_id !== String(user.role.id)) fields.push("role");
      return fields;
    },
    request: (id, draft, fields) => {
      const changes: UserUpdate = {};
      if (fields.includes("name")) {
        changes.first_name = draft.first_name.trim();
        changes.last_name = draft.last_name.trim();
      }
      if (fields.includes("email")) changes.email = draft.email.trim();
      if (fields.includes("username")) changes.username = draft.username.trim();
      if (fields.includes("status")) changes.status = draft.status;
      if (fields.includes("role")) changes.role_id = Number(draft.role_id);
      if (fields.includes("location")) changes.location_id = Number(draft.location_id);
      if (fields.includes("team")) changes.team_id = draft.team_id ? Number(draft.team_id) : null;
      return apiPatch<UserRead>(`/users/${id}`, changes);
    },
    errorMessage: (err) => {
      if (err instanceof ApiError && err.status === 404) {
        return "This user no longer exists. Refresh to update the list.";
      }
      if (err instanceof ApiError && err.status === 409) {
        // 409 means email or username is already taken -- mirrors
        // UserFormDialog's own routing of this same response.
        const detail = (err.body as { detail?: string } | null)?.detail?.toLowerCase() ?? "";
        if (detail.includes("email")) return "This email is already in use.";
        if (detail.includes("username")) return "This username is already taken.";
        return "That email or username is already in use.";
      }
      if (err instanceof ApiError && err.status === 403) {
        // The rank check hides Edit on rows the caller can't administer, but
        // it can't be exhaustive -- say so explicitly rather than falling
        // through to a generic "try again" that invites a retry that can't succeed.
        return "You don't have permission to edit this user.";
      }
      return "Could not save changes. Please try again.";
    },
  });

  // Enters edit mode for one row, seeding the draft from its current values.
  function handleEditClick(user: UserRead) {
    inlineEdit.onEditClick(user, {
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      username: user.username,
      status: user.status,
      role_id: String(user.role.id),
      location_id: String(user.location.id),
      team_id: user.team ? String(user.team.id) : "",
    });
  }

  // A created user's position under the current sort/filter isn't knowable
  // client-side, so refetch instead of patching it in locally (bypassing
  // the dedup guard, same as retryLoadUsers).
  function handleCreated() {
    setShowCreateDialog(false);
    lastRequestKeyRef.current = null;
    loadUsers();
  }

  // Column definitions -- Name/Role/Location/Team are derived, the rest map
  // straight to a UserRead field. Each swaps to an input/select while its
  // row is being edited, bound through meta -- mirrors PatientTable.
  const columns = useMemo(() => {
    // `any` here is TanStack's own documented pattern for a column list
    // spanning columns with different accessor value types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base: ColumnDef<UserRead, any>[] = [
      columnHelper.accessor((row) => `${row.first_name} ${row.last_name}`, {
        id: "name",
        header: "Name",
        cell: (info) => {
          const user = info.row.original;
          const meta = info.table.options.meta!;
          if (canEditProfile && meta.editingId === user.id && meta.editDraft) {
            const draft = meta.editDraft as UserEditDraft;
            const errors = validateDraft(draft);
            return (
              <div className="flex flex-col gap-1">
                <input
                  value={draft.first_name}
                  onChange={(event) => meta.onFieldChange("first_name", event.target.value)}
                  placeholder="First name"
                  className={tableInputClass(!!errors.first_name)}
                />
                <input
                  value={draft.last_name}
                  onChange={(event) => meta.onFieldChange("last_name", event.target.value)}
                  placeholder="Last name"
                  className={tableInputClass(!!errors.last_name)}
                />
              </div>
            );
          }
          return <TextCell>{info.getValue()}</TextCell>;
        },
      }),
      columnHelper.accessor("email", {
        header: "Email",
        cell: (info) => {
          const user = info.row.original;
          const meta = info.table.options.meta!;
          if (canEditProfile && meta.editingId === user.id && meta.editDraft) {
            const draft = meta.editDraft as UserEditDraft;
            const errors = validateDraft(draft);
            return (
              <div>
                <input
                  value={draft.email}
                  onChange={(event) => meta.onFieldChange("email", event.target.value)}
                  className={tableInputClass(!!errors.email)}
                />
                {errors.email && <CellFieldError>{errors.email}</CellFieldError>}
              </div>
            );
          }
          return <MonoCell>{info.getValue()}</MonoCell>;
        },
      }),
      columnHelper.accessor("username", {
        header: "Username",
        enableSorting: false, // the backend doesn't support sorting by username
        cell: (info) => {
          const user = info.row.original;
          const meta = info.table.options.meta!;
          if (canEditProfile && meta.editingId === user.id && meta.editDraft) {
            const draft = meta.editDraft as UserEditDraft;
            const errors = validateDraft(draft);
            return (
              <div>
                <input
                  value={draft.username}
                  onChange={(event) => meta.onFieldChange("username", event.target.value)}
                  className={tableInputClass(!!errors.username)}
                />
                {errors.username && <CellFieldError>{errors.username}</CellFieldError>}
              </div>
            );
          }
          return <TextCell>{info.getValue()}</TextCell>;
        },
      }),
      columnHelper.accessor((row) => row.role.display_name, {
        id: "role",
        header: "Role",
        cell: (info) => {
          const user = info.row.original;
          const meta = info.table.options.meta!;
          // Requires role.assign, not user.edit -- a manager editing this
          // row sees the role as plain text, matching what the API allows.
          if (canAssignRole && meta.editingId === user.id && meta.editDraft) {
            const draft = meta.editDraft as UserEditDraft;
            const errors = validateDraft(draft);
            return (
              <div>
                <select
                  value={draft.role_id}
                  onChange={(event) => meta.onFieldChange("role_id", event.target.value)}
                  className={tableInputClass(!!errors.role_id)}
                >
                  <option value="">Select...</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.display_name}
                    </option>
                  ))}
                </select>
                {errors.role_id && <CellFieldError>{errors.role_id}</CellFieldError>}
              </div>
            );
          }
          return <TextCell>{info.getValue()}</TextCell>;
        },
      }),
      columnHelper.accessor((row) => row.location.name, {
        id: "location",
        header: "Location",
        cell: (info) => {
          const user = info.row.original;
          const meta = info.table.options.meta!;
          if (canEditProfile && meta.editingId === user.id && meta.editDraft) {
            const draft = meta.editDraft as UserEditDraft;
            const errors = validateDraft(draft);
            return (
              <div>
                <select
                  value={draft.location_id}
                  onChange={(event) => meta.onFieldChange("location_id", event.target.value)}
                  className={tableInputClass(!!errors.location_id)}
                >
                  <option value="">Select...</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
                {errors.location_id && <CellFieldError>{errors.location_id}</CellFieldError>}
              </div>
            );
          }
          return <TextCell>{info.getValue()}</TextCell>;
        },
      }),
      columnHelper.accessor((row) => (row.team ? row.team.name : "Unassigned"), {
        id: "team",
        header: "Team",
        cell: (info) => {
          const user = info.row.original;
          const meta = info.table.options.meta!;
          if (canEditProfile && meta.editingId === user.id && meta.editDraft) {
            const draft = meta.editDraft as UserEditDraft;
            return (
              <select
                value={draft.team_id}
                onChange={(event) => meta.onFieldChange("team_id", event.target.value)}
                className={tableInputClass()}
              >
                <option value="">Unassigned</option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            );
          }
          return <TextCell>{info.getValue()}</TextCell>;
        },
      }),
      columnHelper.accessor("status", {
        header: "Status",
        cell: (info) => {
          const user = info.row.original;
          const meta = info.table.options.meta!;
          // Requires user.suspend -- suspending an account is privileged
          // separately from editing its profile.
          if (canChangeStatus && meta.editingId === user.id && meta.editDraft) {
            const draft = meta.editDraft as UserEditDraft;
            const errors = validateDraft(draft);
            return (
              <div>
                <select
                  value={draft.status}
                  onChange={(event) => meta.onFieldChange("status", event.target.value)}
                  className={tableInputClass(!!errors.status)}
                >
                  {STATUSES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                {errors.status && <CellFieldError>{errors.status}</CellFieldError>}
              </div>
            );
          }
          return <StatusBadge status={info.getValue()} />;
        },
      }),
    ];

    // Actions column exists as soon as the caller can change *something* --
    // profile, role, or status. Which fields the edit row exposes is
    // decided per column above, mirroring the backend's per-field rules.
    if (canEditAnything) {
      base.push(
        columnHelper.display({
          id: "actions",
          header: "Actions",
          cell: (info) => {
            const row = info.row.original;
            // Authority runs strictly downward -- no Edit on peers/seniors,
            // matching how this table hides what it can't do. Self is
            // excluded too: this bundles role/status, which self-edits always 403 on.
            if (row.id === currentUser?.id || !canAdministerUser(currentUser, row, rolesById)) return null;

            const meta = info.table.options.meta!;
            const errors =
              meta.editingId === row.id && meta.editDraft ? validateDraft(meta.editDraft as UserEditDraft) : {};
            return (
              <CellActions>
                <InlineEditActionsCell
                  row={row}
                  editingId={meta.editingId}
                  savingId={meta.savingId}
                  hasErrors={Object.keys(errors).length > 0}
                  onEditClick={meta.onEditClick}
                  onCancel={meta.onCancel}
                  onSave={meta.onSave}
                />
              </CellActions>
            );
          },
        }),
      );
    }

    return base;
    // roles/locations/teams/currentUser/rolesById are included (unlike
    // PatientTable's edit state) because they settle once, not per keystroke
    // -- recreating columns then can't drop input focus mid-edit.
  }, [canEditAnything, canEditProfile, canAssignRole, canChangeStatus, currentUser, rolesById, roles, locations, teams]);

  const roleOptions = roles.map((role) => role.display_name);
  const locationOptions = locations.map((location) => location.name);
  const teamOptions = [...teams.map((team) => team.name), "Unassigned"];

  // Maps each column id to its filter config, read by the header row to
  // decide which trigger/popover to render. Username has none -- the
  // backend doesn't support filtering by it either.
  const columnFilters: Record<string, ColumnFilterConfig> = {
    name: textFilter("Name", nameInput, setNameInput),
    email: textFilter("Email", emailInput, setEmailInput),
    role: checklistFilter("Role", roleOptions, roleFilter, setRoleFilter),
    location: checklistFilter("Location", locationOptions, locationFilter, setLocationFilter),
    team: checklistFilter("Team", teamOptions, teamFilter, setTeamFilter),
    status: checklistFilter("Status", STATUSES, statusFilter, setStatusFilter),
  };

  const table = useDataTable({
    data: users ?? [],
    columns,
    sorting,
    onSortingChange: setSorting,
    meta: {
      editingId: inlineEdit.editingId,
      editDraft: inlineEdit.editDraft,
      savingId: inlineEdit.savingId,
      onFieldChange: inlineEdit.onFieldChange,
      onEditClick: handleEditClick,
      onCancel: inlineEdit.onCancel,
      onSave: inlineEdit.onSave,
    },
  });

  if (!currentUser) return null; // guards render before auth resolves; ProtectedRoute normally prevents this

  return (
    <>
      <DataTableCard
        title="User accounts"
        headerActions={
          canCreate && (
            <Button onClick={() => setShowCreateDialog(true)}>
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Add user
            </Button>
          )
        }
        table={table}
        rows={users}
        isFetching={isFetching}
        loadError={usersError}
        onRetry={retryLoadUsers}
        errorMessage="Couldn't load users."
        emptyMessage="No users found."
        columnWidths={COLUMN_WIDTHS}
        columnFilters={columnFilters}
        editingRowId={inlineEdit.editingId}
        savingRowId={inlineEdit.savingId}
        flashedRow={inlineEdit.flashedRow}
        rowError={(user) => inlineEdit.rowErrors[user.id]}
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />

      {showCreateDialog && (
        <UserFormDialog
          mode="create"
          roles={roles}
          locations={locations}
          teams={teams}
          onClose={() => setShowCreateDialog(false)}
          onSaved={handleCreated}
        />
      )}
    </>
  );
}
