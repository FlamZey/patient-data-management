import { useState } from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColumnDef, SortingState, Table } from "@tanstack/react-table";

import {
  ApiError as ReExportedApiError,
  CellActions,
  CellFieldError,
  DataTableCard,
  InlineEditActionsCell,
  MonoCell,
  checklistFilter,
  dateRangeFilter,
  tableInputClass,
  textFilter,
  useDataTable,
  useDebouncedFilters,
  useInlineRowEdit,
  useTablePagination,
} from "@/components/table-primitives";
import type { ColumnFilterConfig } from "@/components/ColumnFilters";
import { ApiError as LibApiError } from "@/lib/api";

interface Row {
  id: string;
  name: string;
  email: string;
}

type Draft = { name: string; email: string };

// Mirrors useDataTable's own column type -- TanStack's documented pattern
// for a column list spanning columns with different accessor value types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildColumns(): ColumnDef<Row, any>[] {
  return [
    { id: "name", accessorKey: "name", header: "Name", cell: (info) => info.getValue() },
    { id: "email", accessorKey: "email", header: "Email", enableSorting: false, cell: (info) => info.getValue() },
  ];
}

// jsdom has no layout engine, so every getBoundingClientRect() it hands back
// is all zeroes -- a test about computed scroll offsets has to supply the
// few rects the code under test actually reads.
function mockRect(element: Element, rect: Partial<DOMRect>) {
  jest.spyOn(element, "getBoundingClientRect").mockReturnValue({
    top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
    ...rect,
  } as DOMRect);
}

describe("components/table-primitives", () => {
  describe("MonoCell", () => {
    // Wraps its children in a monospaced span.
    it("wraps its children in a monospaced span", () => {
      render(<MonoCell>ABC-123</MonoCell>);
      expect(screen.getByText("ABC-123")).toHaveClass("font-mono");
    });
  });

  describe("CellActions", () => {
    // Renders every action passed as a child, laid out as a row.
    it("renders each child action", () => {
      render(
        <CellActions>
          <button>One</button>
          <button>Two</button>
        </CellActions>,
      );
      expect(screen.getByRole("button", { name: "One" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Two" })).toBeInTheDocument();
    });
  });

  describe("CellFieldError", () => {
    // Renders the validation message passed as children.
    it("renders the provided validation message", () => {
      render(<CellFieldError>Required field.</CellFieldError>);
      expect(screen.getByText("Required field.")).toBeInTheDocument();
    });
  });

  describe("tableInputClass", () => {
    // Uses the neutral border color when there is no error.
    it("uses the neutral border color when hasError is false", () => {
      const className = tableInputClass(false);
      expect(className).toContain("border-border");
      expect(className).not.toContain("border-danger");
    });

    // Switches to the danger border color when hasError is true.
    it("switches to the danger border color when hasError is true", () => {
      const className = tableInputClass(true);
      expect(className).toContain("border-danger");
      expect(className).not.toContain("border-border");
    });
  });

  describe("textFilter", () => {
    // Builds a text filter config carrying the label, value, and onChange straight through.
    it("returns a text filter config with the given label, value, and onChange", () => {
      const onChange = jest.fn();
      const config = textFilter("Name", "ali", onChange);
      expect(config).toEqual({ kind: "text", label: "Name", value: "ali", onChange });
    });
  });

  describe("checklistFilter", () => {
    // Builds a checklist filter config carrying the label, options, and selected values through.
    it("returns a checklist filter config with the given label, options, and selected", () => {
      const setSelected = jest.fn();
      const config = checklistFilter("Status", ["Active", "Inactive"], ["Active"], setSelected);
      expect(config).toMatchObject({ kind: "checklist", label: "Status", options: ["Active", "Inactive"], selected: ["Active"] });
    });

    // onToggleOption adds an option that isn't currently selected.
    it("onToggleOption adds an option that isn't currently selected", () => {
      const setSelected = jest.fn();
      const config = checklistFilter("Status", ["Active", "Inactive"], ["Active"], setSelected);
      if (config.kind !== "checklist") throw new Error("expected checklist config");
      config.onToggleOption("Inactive");
      const updater = setSelected.mock.calls[0][0] as (prev: string[]) => string[];
      expect(updater(["Active"])).toEqual(["Active", "Inactive"]);
    });

    // onToggleOption removes an option that is currently selected.
    it("onToggleOption removes an option that is currently selected", () => {
      const setSelected = jest.fn();
      const config = checklistFilter("Status", ["Active", "Inactive"], ["Active", "Inactive"], setSelected);
      if (config.kind !== "checklist") throw new Error("expected checklist config");
      config.onToggleOption("Active");
      const updater = setSelected.mock.calls[0][0] as (prev: string[]) => string[];
      expect(updater(["Active", "Inactive"])).toEqual(["Inactive"]);
    });

    // onToggleAll selects every option when not all of them are currently selected.
    it("onToggleAll selects every option when not all are selected", () => {
      const setSelected = jest.fn();
      const config = checklistFilter("Status", ["Active", "Inactive"], ["Active"], setSelected);
      if (config.kind !== "checklist") throw new Error("expected checklist config");
      config.onToggleAll();
      expect(setSelected).toHaveBeenCalledWith(["Active", "Inactive"]);
    });

    // onToggleAll clears the selection when every option is already selected.
    it("onToggleAll clears the selection when every option is already selected", () => {
      const setSelected = jest.fn();
      const config = checklistFilter("Status", ["Active", "Inactive"], ["Active", "Inactive"], setSelected);
      if (config.kind !== "checklist") throw new Error("expected checklist config");
      config.onToggleAll();
      expect(setSelected).toHaveBeenCalledWith([]);
    });
  });

  describe("dateRangeFilter", () => {
    // Builds a date-range filter config carrying from, to, and onApply through.
    it("returns a date-range filter config with the given from, to, and onApply", () => {
      const onApply = jest.fn();
      const config = dateRangeFilter("1990-01-01", null, onApply);
      expect(config).toEqual({ kind: "date-range", from: "1990-01-01", to: null, onApply });
    });
  });

  describe("useDebouncedFilters", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    // The debounced value doesn't change until the full delay elapses.
    it("does not change the value before the delay elapses", () => {
      jest.useFakeTimers();
      const { result, rerender } = renderHook(({ inputs }) => useDebouncedFilters(inputs, 300), {
        initialProps: { inputs: { q: "a" } },
      });
      rerender({ inputs: { q: "ab" } });
      act(() => {
        jest.advanceTimersByTime(299);
      });
      expect(result.current).toEqual({ q: "a" });
    });

    // The debounced value updates once the delay has fully elapsed.
    it("updates the value once the delay elapses", () => {
      jest.useFakeTimers();
      const { result, rerender } = renderHook(({ inputs }) => useDebouncedFilters(inputs, 300), {
        initialProps: { inputs: { q: "a" } },
      });
      rerender({ inputs: { q: "ab" } });
      act(() => {
        jest.advanceTimersByTime(300);
      });
      expect(result.current).toEqual({ q: "ab" });
    });

    // Several rapid changes inside one window coalesce into a single commit of the final value.
    it("coalesces several rapid changes within one window into a single commit", () => {
      jest.useFakeTimers();
      const { result, rerender } = renderHook(({ inputs }) => useDebouncedFilters(inputs, 300), {
        initialProps: { inputs: { q: "a" } },
      });
      rerender({ inputs: { q: "ab" } });
      act(() => {
        jest.advanceTimersByTime(150);
      });
      rerender({ inputs: { q: "abc" } });
      act(() => {
        jest.advanceTimersByTime(150);
      });
      // Still the original value -- the second change reset the timer window.
      expect(result.current).toEqual({ q: "a" });
      act(() => {
        jest.advanceTimersByTime(150);
      });
      expect(result.current).toEqual({ q: "abc" });
    });

    // Reverting to the original value within the window keeps the same object reference -- no change fires at all.
    it("keeps the same object when the value is reverted within the window", () => {
      jest.useFakeTimers();
      const { result, rerender } = renderHook(({ inputs }) => useDebouncedFilters(inputs, 300), {
        initialProps: { inputs: { q: "orig" } },
      });
      const original = result.current;
      rerender({ inputs: { q: "changed" } });
      rerender({ inputs: { q: "orig" } });
      act(() => {
        jest.advanceTimersByTime(300);
      });
      expect(result.current).toBe(original);
    });
  });

  describe("useTablePagination", () => {
    // Starts on page 1 with the given default page size.
    it("starts on page 1 with the given default page size", () => {
      const { result } = renderHook(() => useTablePagination(25, "key-a"));
      expect(result.current.page).toBe(1);
      expect(result.current.pageSize).toBe(25);
    });

    // setPage advances the read page.
    it("setPage advances the page", () => {
      const { result } = renderHook(() => useTablePagination(25, "key-a"));
      act(() => {
        result.current.setPage(3);
      });
      expect(result.current.page).toBe(3);
    });

    // Changing resetKey resets the read page back to 1 in the same render, without an explicit setPage call.
    it("resets the page to 1 when resetKey changes, without calling setPage", () => {
      const { result, rerender } = renderHook(({ resetKey }) => useTablePagination(25, resetKey), {
        initialProps: { resetKey: "a" as unknown },
      });
      act(() => {
        result.current.setPage(3);
      });
      expect(result.current.page).toBe(3);

      rerender({ resetKey: "b" });
      expect(result.current.page).toBe(1);
    });

    // Changing pageSize -- part of the internal reset key -- also resets the read page back to 1.
    it("resets the page to 1 when pageSize changes", () => {
      const { result } = renderHook(() => useTablePagination(25, "key-a"));
      act(() => {
        result.current.setPage(3);
      });
      expect(result.current.page).toBe(3);

      act(() => {
        result.current.setPageSize(50);
      });
      expect(result.current.page).toBe(1);
      expect(result.current.pageSize).toBe(50);
    });
  });

  describe("useInlineRowEdit", () => {
    const row1: Row = { id: "1", name: "Alice", email: "alice@example.com" };

    function useInlineEditHarness(options: {
      request: (id: string, draft: Draft, changedFields: string[]) => Promise<Row>;
      errorMessage: (err: unknown) => string;
      changedFields?: (draft: Draft, row: Row) => string[];
      initialRows?: Row[];
    }) {
      const [rows, setRows] = useState<Row[] | null>(
        options.initialRows ?? [row1, { id: "2", name: "Bob", email: "bob@example.com" }],
      );
      const edit = useInlineRowEdit<Row, Draft>({
        setRows,
        toRow: (row, draft) => ({ ...row, ...draft }),
        changedFields:
          options.changedFields ??
          ((draft, row) => (["name", "email"] as const).filter((field) => draft[field] !== row[field])),
        request: options.request,
        errorMessage: options.errorMessage,
      });
      return { rows, ...edit };
    }

    // onEditClick seeds the draft/editing state for that row and clears any prior save error it had.
    it("onEditClick seeds editingId/editDraft and clears that row's prior save error", async () => {
      const request = jest.fn().mockRejectedValue(new Error("boom"));
      const errorMessage = jest.fn(() => "Could not save");
      const { result } = renderHook(() => useInlineEditHarness({ request, errorMessage }));

      act(() => result.current.onEditClick(row1, { name: "X", email: row1.email }));
      await act(async () => {
        await result.current.onSave(row1);
      });
      expect(result.current.rowErrors["1"]).toBe("Could not save");

      act(() => result.current.onEditClick(row1, { name: "Alice", email: row1.email }));
      expect(result.current.editingId).toBe("1");
      expect(result.current.editDraft).toEqual({ name: "Alice", email: row1.email });
      expect(result.current.rowErrors["1"]).toBeUndefined();
    });

    // onFieldChange updates only the named field of the in-progress draft, leaving the others untouched.
    it("onFieldChange updates only the specified field of the draft", () => {
      const { result } = renderHook(() => useInlineEditHarness({ request: jest.fn(), errorMessage: jest.fn() }));
      act(() => result.current.onEditClick(row1, { name: "Alice", email: "alice@example.com" }));
      act(() => result.current.onFieldChange("email", "new@example.com"));
      expect(result.current.editDraft).toEqual({ name: "Alice", email: "new@example.com" });
    });

    // onCancel discards the in-progress draft and exits edit mode without saving.
    it("onCancel discards the draft and exits edit mode", () => {
      const { result } = renderHook(() => useInlineEditHarness({ request: jest.fn(), errorMessage: jest.fn() }));
      act(() => result.current.onEditClick(row1, { name: "Changed", email: row1.email }));
      act(() => result.current.onCancel());
      expect(result.current.editingId).toBeNull();
      expect(result.current.editDraft).toBeNull();
    });

    // onSave applies the optimistic row the instant it's called, then replaces it with the server's row and clears the error on success.
    it("onSave applies an optimistic update immediately, then replaces it with the server row on success", async () => {
      let resolveRequest!: (row: Row) => void;
      const request = jest.fn(
        () =>
          new Promise<Row>((resolve) => {
            resolveRequest = resolve;
          }),
      );
      const { result } = renderHook(() => useInlineEditHarness({ request, errorMessage: jest.fn(() => "err") }));

      act(() => result.current.onEditClick(row1, { name: "Alice Draft", email: "draft@example.com" }));

      let savePromise!: Promise<void>;
      act(() => {
        savePromise = result.current.onSave(row1);
      });

      expect(result.current.rows?.find((r) => r.id === "1")).toEqual({
        id: "1",
        name: "Alice Draft",
        email: "draft@example.com",
      });
      expect(result.current.editingId).toBeNull();
      expect(result.current.savingId).toBe("1");

      const serverRow: Row = { id: "1", name: "Alice Server", email: "server@example.com" };
      await act(async () => {
        resolveRequest(serverRow);
        await savePromise;
      });

      expect(result.current.rows?.find((r) => r.id === "1")).toEqual(serverRow);
      expect(result.current.savingId).toBeNull();
      expect(result.current.rowErrors["1"]).toBeUndefined();
    });

    // onSave rolls back to the pre-edit snapshot and records an error message when the request fails.
    it("onSave rolls back to the pre-edit snapshot and sets an error message on failure", async () => {
      const err = new Error("network down");
      const request = jest.fn().mockRejectedValue(err);
      const errorMessage = jest.fn(() => "Could not save changes");
      const { result } = renderHook(() => useInlineEditHarness({ request, errorMessage }));

      act(() => result.current.onEditClick(row1, { name: "Changed", email: "changed@example.com" }));
      await act(async () => {
        await result.current.onSave(row1);
      });

      expect(result.current.rows?.find((r) => r.id === "1")).toEqual(row1);
      expect(result.current.rowErrors["1"]).toBe("Could not save changes");
      expect(errorMessage).toHaveBeenCalledWith(err);
      expect(result.current.savingId).toBeNull();
    });

    // A successful save with a non-empty changedFields flashes the row, then clears the flash after the 900ms animation window.
    it("flashes the changed fields on success and clears the flash after 900ms", async () => {
      jest.useFakeTimers();
      const serverRow: Row = { id: "1", name: "Alice Server", email: "alice@example.com" };
      const request = jest.fn().mockResolvedValue(serverRow);
      const { result } = renderHook(() =>
        useInlineEditHarness({ request, errorMessage: jest.fn(), changedFields: () => ["name"] }),
      );

      act(() => result.current.onEditClick(row1, { name: "Alice Server", email: "alice@example.com" }));
      await act(async () => {
        await result.current.onSave(row1);
      });

      expect(result.current.flashedRow).toEqual({ id: "1", fields: ["name"] });

      act(() => {
        jest.advanceTimersByTime(900);
      });
      expect(result.current.flashedRow).toBeNull();

      jest.useRealTimers();
    });

    // A successful save whose changedFields is empty never sets a flash at all.
    it("does not flash when changedFields returns an empty array", async () => {
      const serverRow: Row = { id: "1", name: "Alice", email: "alice@example.com" };
      const request = jest.fn().mockResolvedValue(serverRow);
      const { result } = renderHook(() =>
        useInlineEditHarness({ request, errorMessage: jest.fn(), changedFields: () => [] }),
      );

      act(() => result.current.onEditClick(row1, { name: "Alice", email: "alice@example.com" }));
      await act(async () => {
        await result.current.onSave(row1);
      });

      expect(result.current.flashedRow).toBeNull();
    });
  });

  describe("InlineEditActionsCell", () => {
    const row: Row = { id: "1", name: "Alice", email: "alice@example.com" };

    // Renders a plain, enabled Edit button when nothing is being edited or saved.
    it("renders an enabled Edit button when nothing is editing or saving", () => {
      render(
        <InlineEditActionsCell
          row={row}
          editingId={null}
          savingId={null}
          hasErrors={false}
          onEditClick={jest.fn()}
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    });

    // While this row is the one being edited, renders Cancel and an enabled Save.
    it("renders Cancel and an enabled Save while this row is being edited", () => {
      render(
        <InlineEditActionsCell
          row={row}
          editingId="1"
          savingId={null}
          hasErrors={false}
          onEditClick={jest.fn()}
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });

    // Save is disabled while editing this row when hasErrors is true.
    it("disables Save while editing this row when hasErrors is true", () => {
      render(
        <InlineEditActionsCell
          row={row}
          editingId="1"
          savingId={null}
          hasErrors
          onEditClick={jest.fn()}
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    });

    // While this row is saving, renders a single disabled "Saving..." button instead of Edit or Cancel/Save.
    it("renders a disabled Saving... button while this row is saving", () => {
      render(
        <InlineEditActionsCell
          row={row}
          editingId={null}
          savingId="1"
          hasErrors={false}
          onEditClick={jest.fn()}
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    });

    // The Edit button is disabled when a different row is mid-edit.
    it("disables the Edit button when a different row is mid-edit", () => {
      render(
        <InlineEditActionsCell
          row={row}
          editingId="2"
          savingId={null}
          hasErrors={false}
          onEditClick={jest.fn()}
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    });

    // The Edit button is disabled when a different row is mid-save.
    it("disables the Edit button when a different row is mid-save", () => {
      render(
        <InlineEditActionsCell
          row={row}
          editingId={null}
          savingId="2"
          hasErrors={false}
          onEditClick={jest.fn()}
          onCancel={jest.fn()}
          onSave={jest.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    });
  });

  describe("ApiError", () => {
    // Re-exports the same ApiError class as lib/api, so a table's errorMessage callback can branch on .status without a separate import.
    it("re-exports lib/api's ApiError class", () => {
      expect(ReExportedApiError).toBe(LibApiError);
      const err = new ReExportedApiError(404, { detail: "not found" });
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(404);
    });
  });

  describe("useDataTable", () => {
    // Wires the shared TanStack config: manual, non-removable single-column sorting, rows keyed by id, and the given sorting/meta passed straight through.
    it("configures manual, non-removable single-column sorting and keys rows by id", () => {
      const data: Row[] = [
        { id: "2", name: "Bob", email: "bob@example.com" },
        { id: "1", name: "Alice", email: "alice@example.com" },
      ];
      const onSortingChange = jest.fn();
      const meta = {
        editingId: null,
        editDraft: null,
        savingId: null,
        onFieldChange: jest.fn(),
        onEditClick: jest.fn(),
        onCancel: jest.fn(),
        onSave: jest.fn(),
      };

      const { result } = renderHook(() =>
        useDataTable<Row>({
          data,
          columns: buildColumns(),
          sorting: [{ id: "name", desc: false }],
          onSortingChange,
          meta,
        }),
      );

      const table = result.current;
      expect(table.options.manualSorting).toBe(true);
      expect(table.options.sortDescFirst).toBe(false);
      expect(table.options.enableMultiSort).toBe(false);
      expect(table.options.enableSortingRemoval).toBe(false);
      expect(table.getState().sorting).toEqual([{ id: "name", desc: false }]);
      expect(table.getRowModel().rows.map((row) => row.id)).toEqual(["2", "1"]);
      expect(table.options.meta).toBe(meta);
    });
  });

  describe("DataTableCard", () => {
    const rows: Row[] = [
      { id: "1", name: "Alice", email: "alice@example.com" },
      { id: "2", name: "Bob", email: "bob@example.com" },
    ];

    interface HarnessOverrides {
      isFetching?: boolean;
      loadError?: boolean;
      onRetry?: () => void;
      errorMessage?: string;
      emptyMessage?: string;
      columnWidths?: Record<string, string>;
      columnFilters?: Record<string, ColumnFilterConfig>;
      editingRowId?: string | null;
      savingRowId?: string | null;
      flashedRow?: { id: string; fields?: string[] } | null;
      rowError?: (row: Row) => string | undefined;
      expandedRowId?: string | null;
      onToggleExpand?: (row: Row) => void;
      renderExpandedContent?: (row: Row) => React.ReactNode;
      page?: number;
      pageSize?: number;
      total?: number;
      onPageChange?: (page: number) => void;
      onPageSizeChange?: (pageSize: number) => void;
    }

    function DataTableHarness({
      rows: harnessRows,
      tableRef,
      ...overrides
    }: { rows: Row[] | null; tableRef?: { current: Table<Row> | null } } & HarnessOverrides) {
      const [sorting, setSorting] = useState<SortingState>([]);
      const table = useDataTable<Row>({
        data: harnessRows ?? [],
        columns: buildColumns(),
        sorting,
        onSortingChange: setSorting,
      });
      if (tableRef) tableRef.current = table;

      return (
        <DataTableCard<Row>
          title="Test Table"
          table={table}
          rows={harnessRows}
          isFetching={overrides.isFetching ?? false}
          loadError={overrides.loadError ?? false}
          onRetry={overrides.onRetry ?? jest.fn()}
          errorMessage={overrides.errorMessage ?? "Something went wrong."}
          emptyMessage={overrides.emptyMessage ?? "No records found."}
          columnWidths={overrides.columnWidths ?? {}}
          columnFilters={overrides.columnFilters ?? {}}
          editingRowId={overrides.editingRowId}
          savingRowId={overrides.savingRowId}
          flashedRow={overrides.flashedRow}
          rowError={overrides.rowError}
          expandedRowId={overrides.expandedRowId}
          onToggleExpand={overrides.onToggleExpand}
          renderExpandedContent={overrides.renderExpandedContent}
          page={overrides.page ?? 1}
          pageSize={overrides.pageSize ?? 10}
          total={overrides.total ?? harnessRows?.length ?? 0}
          onPageChange={overrides.onPageChange ?? jest.fn()}
          onPageSizeChange={overrides.onPageSizeChange ?? jest.fn()}
        />
      );
    }

    // Shows the initial-load spinner (and no table) while rows is still null.
    it("shows the initial-load spinner while rows is null", () => {
      const { container } = render(<DataTableHarness rows={null} />);
      expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    });

    // Shows the error message and a Retry button that calls onRetry when loadError is true.
    it("shows the error message and calls onRetry from the Retry button", async () => {
      const user = userEvent.setup();
      const onRetry = jest.fn();
      render(<DataTableHarness rows={null} loadError errorMessage="Could not load records." onRetry={onRetry} />);
      expect(screen.getByText("Could not load records.")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    // Shows the empty message in place of rows when rows resolves to an empty array.
    it("shows the empty message when rows is an empty array", () => {
      render(<DataTableHarness rows={[]} emptyMessage="Nothing here yet." />);
      expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
    });

    // Renders one row per item via the real TanStack table instance.
    it("renders table rows from the real Table instance", () => {
      render(<DataTableHarness rows={rows} />);
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByText("alice@example.com")).toBeInTheDocument();
      expect(screen.getByText("Bob")).toBeInTheDocument();
    });

    // Clicking a sortable column header toggles the underlying table's own sort state (asc, then desc).
    it("clicking a sortable column header toggles the table's sort state", async () => {
      const user = userEvent.setup();
      const tableRef: { current: Table<Row> | null } = { current: null };
      render(<DataTableHarness rows={rows} tableRef={tableRef} />);

      await user.click(screen.getByRole("button", { name: "Name" }));
      expect(tableRef.current?.getState().sorting).toEqual([{ id: "name", desc: false }]);

      await user.click(screen.getByRole("button", { name: "Name" }));
      expect(tableRef.current?.getState().sorting).toEqual([{ id: "name", desc: true }]);
    });

    // The "X-Y of Z" label reflects page/pageSize/total, including the total === 0 special case.
    it("computes the pagination label from page, pageSize, and total", () => {
      const { rerender } = render(<DataTableHarness rows={rows} page={2} pageSize={10} total={25} />);
      expect(screen.getByText("11–20 of 25")).toBeInTheDocument();

      rerender(<DataTableHarness rows={rows} page={1} pageSize={10} total={0} />);
      expect(screen.getByText("0 of 0")).toBeInTheDocument();
    });

    // Prev is disabled on page 1, while Next stays enabled when more rows remain.
    it("disables Prev on page 1 while more rows remain for Next", () => {
      render(<DataTableHarness rows={rows} page={1} pageSize={10} total={15} />);
      expect(screen.getByRole("button", { name: "Prev" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    });

    // Next is disabled once page * pageSize already covers the total.
    it("disables Next once page * pageSize reaches the total", () => {
      render(<DataTableHarness rows={rows} page={2} pageSize={10} total={15} />);
      expect(screen.getByRole("button", { name: "Prev" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    });

    // The page-size <select> reports the chosen size through onPageSizeChange.
    it("calls onPageSizeChange when the page-size select changes", () => {
      const onPageSizeChange = jest.fn();
      render(<DataTableHarness rows={rows} onPageSizeChange={onPageSizeChange} />);
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "50" } });
      expect(onPageSizeChange).toHaveBeenCalledWith(50);
    });

    // A column filter trigger renders only for columns present in columnFilters.
    it("renders a filter trigger only for columns present in columnFilters", () => {
      render(<DataTableHarness rows={rows} columnFilters={{ name: textFilter("Name", "", jest.fn()) }} />);
      expect(screen.getByRole("button", { name: "Filter by Name" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Filter by Email" })).not.toBeInTheDocument();
    });

    // The expand toggle column doesn't render at all when renderExpandedContent isn't passed.
    it("renders no expand toggle column when renderExpandedContent is not passed", () => {
      render(<DataTableHarness rows={rows} />);
      expect(screen.queryByRole("button", { name: "Show details" })).not.toBeInTheDocument();
    });

    // Clicking the expand toggle calls onToggleExpand with that row, and the expanded content renders once expandedRowId matches.
    it("clicking the expand toggle calls onToggleExpand, and matching expandedRowId renders the expanded content", async () => {
      const user = userEvent.setup();
      const onToggleExpand = jest.fn();
      const { rerender } = render(
        <DataTableHarness
          rows={rows}
          renderExpandedContent={(row) => <p>Detail for {row.name}</p>}
          onToggleExpand={onToggleExpand}
          expandedRowId={null}
        />,
      );
      expect(screen.queryByText("Detail for Alice")).not.toBeInTheDocument();

      const toggles = screen.getAllByRole("button", { name: "Show details" });
      await user.click(toggles[0]);
      expect(onToggleExpand).toHaveBeenCalledWith(rows[0]);

      rerender(
        <DataTableHarness
          rows={rows}
          renderExpandedContent={(row) => <p>Detail for {row.name}</p>}
          onToggleExpand={onToggleExpand}
          expandedRowId="1"
        />,
      );
      expect(screen.getByText("Detail for Alice")).toBeInTheDocument();
    });

    // The expanded row is scrolled to the top of the table's own scroll
    // area (measured against its sticky thead) -- the page itself no longer
    // scrolls (DataTableCard fills the viewport; see dashboard/page.tsx and
    // friends). jsdom has no layout, so the rects the effect reads are
    // stubbed here.
    it("scrolls the expanded row under the sticky header", () => {
      const expandProps = {
        renderExpandedContent: (row: Row) => <p>Detail for {row.name}</p>,
        onToggleExpand: jest.fn(),
      };
      const { rerender } = render(<DataTableHarness rows={rows} {...expandProps} expandedRowId={null} />);

      const scrollArea = screen.getByRole("table").parentElement!;
      mockRect(scrollArea, { top: 100 });
      mockRect(screen.getByRole("table").querySelector("thead")!, { height: 40 });
      mockRect(screen.getByText("Alice").closest("tr")!, { top: 300 });
      // Stands in for a wide table scrolled right to reach its Actions
      // column -- opening the panel scrolls back to the row's left edge.
      Object.defineProperty(scrollArea, "scrollLeft", { value: 120, configurable: true });

      const areaScrollBy = jest.spyOn(scrollArea, "scrollBy");

      rerender(<DataTableHarness rows={rows} {...expandProps} expandedRowId="1" />);

      // The row's top (300) relative to the area's own top (100), less the
      // sticky thead (40) and its 8px breathing room.
      expect(areaScrollBy).toHaveBeenCalledWith({ top: 152, left: -120, behavior: "smooth" });
    });

    // A row with a message from rowError() renders that message in its own error banner.
    it("renders a per-row error banner when rowError returns a message", () => {
      render(
        <DataTableHarness
          rows={rows}
          rowError={(row) => (row.id === "1" ? "Save failed for this row." : undefined)}
        />,
      );
      expect(screen.getByRole("alert")).toHaveTextContent("Save failed for this row.");
    });
  });
});
