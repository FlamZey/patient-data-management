import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ChecklistFilterIcon,
  ColumnFilterPanel,
  ColumnFilterTrigger,
  SearchIcon,
  isColumnFilterActive,
  useColumnFilterPopover,
  type ColumnFilterConfig,
} from "@/components/ColumnFilters";

function fakeRect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
    toJSON: () => ({}),
    ...overrides,
  } as DOMRect;
}

describe("components/ColumnFilters", () => {
  describe("isColumnFilterActive", () => {
    // A checklist filter is active once fewer options are selected than exist.
    it("is active for a checklist filter once fewer options are selected than exist", () => {
      const config: ColumnFilterConfig = {
        kind: "checklist",
        label: "Status",
        options: ["Active", "Inactive"],
        selected: ["Active"],
        onToggleOption: jest.fn(),
        onToggleAll: jest.fn(),
      };
      expect(isColumnFilterActive(config)).toBe(true);
    });

    // A checklist filter is inactive when every option is selected -- that means "no filtering".
    it("is inactive for a checklist filter when every option is selected", () => {
      const config: ColumnFilterConfig = {
        kind: "checklist",
        label: "Status",
        options: ["Active", "Inactive"],
        selected: ["Active", "Inactive"],
        onToggleOption: jest.fn(),
        onToggleAll: jest.fn(),
      };
      expect(isColumnFilterActive(config)).toBe(false);
    });

    // A date-range filter is active as soon as either endpoint is set.
    it.each([
      ["1990-01-01", null],
      [null, "1990-01-01"],
      ["1990-01-01", "1990-06-01"],
    ] as const)("is active for a date-range filter when from=%s, to=%s", (from, to) => {
      expect(isColumnFilterActive({ kind: "date-range", from, to, onApply: jest.fn() })).toBe(true);
    });

    // A date-range filter is inactive when neither endpoint is set.
    it("is inactive for a date-range filter when both from and to are null", () => {
      expect(isColumnFilterActive({ kind: "date-range", from: null, to: null, onApply: jest.fn() })).toBe(false);
    });

    // A text filter is active for a non-empty value.
    it("is active for a text filter with a non-empty value", () => {
      expect(isColumnFilterActive({ kind: "text", label: "Name", value: "ali", onChange: jest.fn() })).toBe(true);
    });

    // A text filter is inactive for an empty value.
    it("is inactive for a text filter with an empty value", () => {
      expect(isColumnFilterActive({ kind: "text", label: "Name", value: "", onChange: jest.fn() })).toBe(false);
    });
  });

  describe("SearchIcon", () => {
    // Renders an svg hidden from assistive tech, distinguishable by its circle glyph.
    it("renders a hidden svg containing a circle", () => {
      const { container } = render(<SearchIcon />);
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(container.querySelector("circle")).toBeInTheDocument();
    });
  });

  describe("ChecklistFilterIcon", () => {
    // Renders an svg hidden from assistive tech, with no circle glyph (that's what distinguishes it from SearchIcon).
    it("renders a hidden svg with no circle glyph", () => {
      const { container } = render(<ChecklistFilterIcon />);
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(container.querySelector("circle")).not.toBeInTheDocument();
    });
  });

  describe("useColumnFilterPopover", () => {
    // Starts with no column open and no anchor rect captured.
    it("starts closed with no anchor rect", () => {
      const { result } = renderHook(() => useColumnFilterPopover());
      expect(result.current.openFilterColumn).toBeNull();
      expect(result.current.filterAnchorRect).toBeNull();
    });

    // toggleFilterOpen opens the given column and captures its registered trigger button's bounding rect.
    it("opens a column and captures its registered button's rect", () => {
      const { result } = renderHook(() => useColumnFilterPopover());
      const button = document.createElement("button");
      document.body.appendChild(button);
      act(() => {
        result.current.registerFilterButton("name")(button);
      });

      act(() => {
        result.current.toggleFilterOpen("name");
      });

      expect(result.current.openFilterColumn).toBe("name");
      expect(result.current.filterAnchorRect).not.toBeNull();
      document.body.removeChild(button);
    });

    // Calling toggleFilterOpen again on the already-open column closes it.
    it("closes the column when toggled again", () => {
      const { result } = renderHook(() => useColumnFilterPopover());
      const button = document.createElement("button");
      document.body.appendChild(button);
      act(() => {
        result.current.registerFilterButton("name")(button);
      });
      act(() => result.current.toggleFilterOpen("name"));
      act(() => result.current.toggleFilterOpen("name"));

      expect(result.current.openFilterColumn).toBeNull();
      expect(result.current.filterAnchorRect).toBeNull();
      document.body.removeChild(button);
    });

    // Toggling a different column switches to it, closing whichever one was previously open.
    it("switches to a different column, closing the previous one", () => {
      const { result } = renderHook(() => useColumnFilterPopover());
      const nameButton = document.createElement("button");
      const emailButton = document.createElement("button");
      document.body.append(nameButton, emailButton);
      act(() => {
        result.current.registerFilterButton("name")(nameButton);
        result.current.registerFilterButton("email")(emailButton);
      });

      act(() => result.current.toggleFilterOpen("name"));
      expect(result.current.openFilterColumn).toBe("name");

      act(() => result.current.toggleFilterOpen("email"));
      expect(result.current.openFilterColumn).toBe("email");

      document.body.removeChild(nameButton);
      document.body.removeChild(emailButton);
    });

    // Closes on an outside mousedown -- the listener attaches synchronously in a plain effect (no deferred setTimeout here), so a direct dispatch is enough.
    it("closes on an outside mousedown", () => {
      const { result } = renderHook(() => useColumnFilterPopover());
      const button = document.createElement("button");
      document.body.appendChild(button);
      act(() => {
        result.current.registerFilterButton("name")(button);
        result.current.toggleFilterOpen("name");
      });

      act(() => {
        document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });

      expect(result.current.openFilterColumn).toBeNull();
      document.body.removeChild(button);
    });

    // Closes on Escape.
    it("closes on Escape", () => {
      const { result } = renderHook(() => useColumnFilterPopover());
      const button = document.createElement("button");
      document.body.appendChild(button);
      act(() => {
        result.current.registerFilterButton("name")(button);
        result.current.toggleFilterOpen("name");
      });

      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });

      expect(result.current.openFilterColumn).toBeNull();
      document.body.removeChild(button);
    });

    // Closes on scroll, since the anchor position is only computed on open and would otherwise drift out of place.
    it("closes on scroll", () => {
      const { result } = renderHook(() => useColumnFilterPopover());
      const button = document.createElement("button");
      document.body.appendChild(button);
      act(() => {
        result.current.registerFilterButton("name")(button);
        result.current.toggleFilterOpen("name");
      });

      act(() => {
        window.dispatchEvent(new Event("scroll"));
      });

      expect(result.current.openFilterColumn).toBeNull();
      document.body.removeChild(button);
    });

    // Regression test: scrolling inside the panel itself (a long checklist's own overflow list) must not close it.
    it("does not close when the scroll event originates inside the panel", () => {
      const { result } = renderHook(() => useColumnFilterPopover());
      const button = document.createElement("button");
      const panel = document.createElement("div");
      const list = document.createElement("div");
      panel.appendChild(list);
      document.body.append(button, panel);
      act(() => {
        result.current.registerFilterButton("name")(button);
        result.current.toggleFilterOpen("name");
        result.current.filterPanelRef.current = panel;
      });

      act(() => {
        list.dispatchEvent(new Event("scroll"));
      });

      expect(result.current.openFilterColumn).toBe("name");
      document.body.removeChild(button);
      document.body.removeChild(panel);
    });

    // Closes on window resize.
    it("closes on window resize", () => {
      const { result } = renderHook(() => useColumnFilterPopover());
      const button = document.createElement("button");
      document.body.appendChild(button);
      act(() => {
        result.current.registerFilterButton("name")(button);
        result.current.toggleFilterOpen("name");
      });

      act(() => {
        window.dispatchEvent(new Event("resize"));
      });

      expect(result.current.openFilterColumn).toBeNull();
      document.body.removeChild(button);
    });
  });

  describe("ColumnFilterTrigger", () => {
    // Renders the checklist icon (no circle glyph) for a checklist config.
    it("renders the checklist icon for a checklist filter", () => {
      const config: ColumnFilterConfig = {
        kind: "checklist",
        label: "Status",
        options: ["Active", "Inactive"],
        selected: ["Active", "Inactive"],
        onToggleOption: jest.fn(),
        onToggleAll: jest.fn(),
      };
      const { container } = render(
        <ColumnFilterTrigger config={config} isOpen={false} onToggle={jest.fn()} registerRef={jest.fn()} />,
      );
      expect(container.querySelector("circle")).not.toBeInTheDocument();
    });

    // Renders the search icon (with its circle glyph) for a text config.
    it("renders the search icon for a text filter", () => {
      const config: ColumnFilterConfig = { kind: "text", label: "Name", value: "", onChange: jest.fn() };
      const { container } = render(
        <ColumnFilterTrigger config={config} isOpen={false} onToggle={jest.fn()} registerRef={jest.fn()} />,
      );
      expect(container.querySelector("circle")).toBeInTheDocument();
    });

    // Gets the accent color class once its filter is active.
    it("gets the accent color class when the filter is active", () => {
      const config: ColumnFilterConfig = { kind: "text", label: "Name", value: "ali", onChange: jest.fn() };
      render(<ColumnFilterTrigger config={config} isOpen={false} onToggle={jest.fn()} registerRef={jest.fn()} />);
      expect(screen.getByRole("button", { name: "Filter by Name" }).className).toContain("text-accent");
    });

    // Omits the accent color class while its filter is inactive.
    it("omits the accent color class while the filter is inactive", () => {
      const config: ColumnFilterConfig = { kind: "text", label: "Name", value: "", onChange: jest.fn() };
      render(<ColumnFilterTrigger config={config} isOpen={false} onToggle={jest.fn()} registerRef={jest.fn()} />);
      expect(screen.getByRole("button", { name: "Filter by Name" }).className).not.toContain("text-accent");
    });

    // The button's aria-label includes the filter's label.
    it("includes the filter's label in its aria-label", () => {
      const config: ColumnFilterConfig = { kind: "text", label: "Email", value: "", onChange: jest.fn() };
      render(<ColumnFilterTrigger config={config} isOpen={false} onToggle={jest.fn()} registerRef={jest.fn()} />);
      expect(screen.getByRole("button", { name: "Filter by Email" })).toBeInTheDocument();
    });

    // Clicking the trigger calls onToggle.
    it("calls onToggle on click", async () => {
      const user = userEvent.setup();
      const onToggle = jest.fn();
      const config: ColumnFilterConfig = { kind: "text", label: "Name", value: "", onChange: jest.fn() };
      render(<ColumnFilterTrigger config={config} isOpen={false} onToggle={onToggle} registerRef={jest.fn()} />);
      await user.click(screen.getByRole("button", { name: "Filter by Name" }));
      expect(onToggle).toHaveBeenCalledTimes(1);
    });
  });

  describe("ColumnFilterPanel", () => {
    // Renders nothing when there is no active filter.
    it("renders nothing when activeFilter is undefined", () => {
      render(<ColumnFilterPanel activeFilter={undefined} anchorRect={fakeRect()} panelRef={{ current: null }} />);
      expect(screen.queryByPlaceholderText("Filter...")).not.toBeInTheDocument();
      expect(screen.queryByText("(Select All)")).not.toBeInTheDocument();
    });

    // Renders nothing when the anchor rect hasn't been captured yet.
    it("renders nothing when anchorRect is null", () => {
      const config: ColumnFilterConfig = { kind: "text", label: "Name", value: "", onChange: jest.fn() };
      render(<ColumnFilterPanel activeFilter={config} anchorRect={null} panelRef={{ current: null }} />);
      expect(screen.queryByPlaceholderText("Filter...")).not.toBeInTheDocument();
    });

    // Renders nothing for a date-range filter, since that variant renders its own trigger and panel elsewhere.
    it("renders nothing for a date-range filter", () => {
      const config: ColumnFilterConfig = { kind: "date-range", from: null, to: null, onApply: jest.fn() };
      render(<ColumnFilterPanel activeFilter={config} anchorRect={fakeRect()} panelRef={{ current: null }} />);
      expect(screen.queryByPlaceholderText("Filter...")).not.toBeInTheDocument();
    });

    // A text filter renders an input wired to its current value and onChange.
    it("renders a text input wired to value and onChange", () => {
      const onChange = jest.fn();
      const config: ColumnFilterConfig = { kind: "text", label: "Name", value: "ali", onChange };
      render(<ColumnFilterPanel activeFilter={config} anchorRect={fakeRect()} panelRef={{ current: null }} />);

      const input = screen.getByPlaceholderText("Filter...") as HTMLInputElement;
      expect(input.value).toBe("ali");
      fireEvent.change(input, { target: { value: "alice" } });
      expect(onChange).toHaveBeenCalledWith("alice");
    });

    // A checklist filter renders a "(Select All)" row plus one row per option, each with the correct checked state.
    it("renders a Select All row plus one row per option with the correct checked state", () => {
      const config: ColumnFilterConfig = {
        kind: "checklist",
        label: "Status",
        options: ["Active", "Inactive", "Pending"],
        selected: ["Active"],
        onToggleOption: jest.fn(),
        onToggleAll: jest.fn(),
      };
      render(<ColumnFilterPanel activeFilter={config} anchorRect={fakeRect()} panelRef={{ current: null }} />);

      expect(screen.getByText("(Select All)")).toBeInTheDocument();
      ["Active", "Inactive", "Pending"].forEach((option) => expect(screen.getByText(option)).toBeInTheDocument());

      const activeCheckbox = screen.getByText("Active").closest("label")!.querySelector("input") as HTMLInputElement;
      const inactiveCheckbox = screen
        .getByText("Inactive")
        .closest("label")!
        .querySelector("input") as HTMLInputElement;
      expect(activeCheckbox.checked).toBe(true);
      expect(inactiveCheckbox.checked).toBe(false);
    });

    // Clicking an option's checkbox calls onToggleOption with that option; clicking Select All calls onToggleAll.
    it("wires each option's checkbox to onToggleOption and Select All to onToggleAll", () => {
      const onToggleOption = jest.fn();
      const onToggleAll = jest.fn();
      const config: ColumnFilterConfig = {
        kind: "checklist",
        label: "Status",
        options: ["Active", "Inactive"],
        selected: ["Active"],
        onToggleOption,
        onToggleAll,
      };
      render(<ColumnFilterPanel activeFilter={config} anchorRect={fakeRect()} panelRef={{ current: null }} />);

      fireEvent.click(screen.getByText("Inactive").closest("label")!.querySelector("input")!);
      expect(onToggleOption).toHaveBeenCalledWith("Inactive");

      fireEvent.click(screen.getByText("(Select All)").closest("label")!.querySelector("input")!);
      expect(onToggleAll).toHaveBeenCalledTimes(1);
    });

    // The Select All checkbox's DOM .indeterminate property (not just an attribute) is set when some but not all options are selected.
    it("sets the Select All checkbox's indeterminate DOM property when some but not all options are selected", () => {
      const config: ColumnFilterConfig = {
        kind: "checklist",
        label: "Status",
        options: ["Active", "Inactive", "Pending"],
        selected: ["Active"],
        onToggleOption: jest.fn(),
        onToggleAll: jest.fn(),
      };
      render(<ColumnFilterPanel activeFilter={config} anchorRect={fakeRect()} panelRef={{ current: null }} />);
      const selectAllCheckbox = screen
        .getByText("(Select All)")
        .closest("label")!
        .querySelector("input") as HTMLInputElement;
      expect(selectAllCheckbox.indeterminate).toBe(true);
      expect(selectAllCheckbox.checked).toBe(false);
    });

    // The indeterminate property stays false when no options, or every option, is selected.
    it("does not set indeterminate when no options, or all options, are selected", () => {
      const noneSelected: ColumnFilterConfig = {
        kind: "checklist",
        label: "Status",
        options: ["Active", "Inactive"],
        selected: [],
        onToggleOption: jest.fn(),
        onToggleAll: jest.fn(),
      };
      const { rerender } = render(
        <ColumnFilterPanel activeFilter={noneSelected} anchorRect={fakeRect()} panelRef={{ current: null }} />,
      );
      let selectAllCheckbox = screen
        .getByText("(Select All)")
        .closest("label")!
        .querySelector("input") as HTMLInputElement;
      expect(selectAllCheckbox.indeterminate).toBe(false);

      const allSelected: ColumnFilterConfig = { ...noneSelected, selected: ["Active", "Inactive"] };
      rerender(<ColumnFilterPanel activeFilter={allSelected} anchorRect={fakeRect()} panelRef={{ current: null }} />);
      selectAllCheckbox = screen
        .getByText("(Select All)")
        .closest("label")!
        .querySelector("input") as HTMLInputElement;
      expect(selectAllCheckbox.checked).toBe(true);
      expect(selectAllCheckbox.indeterminate).toBe(false);
    });
  });
});
