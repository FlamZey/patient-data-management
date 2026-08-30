import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";

import { CalendarIcon, Chevron, Dropdown, calendarClassNames, useCalendarPopover } from "@/components/calendar-primitives";

describe("components/calendar-primitives", () => {
  describe("CalendarIcon", () => {
    // Renders an svg hidden from assistive tech.
    it("renders an svg hidden from assistive tech", () => {
      const { container } = render(<CalendarIcon />);
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });
  });

  describe("Chevron", () => {
    // Applies no rotation for the default down orientation.
    it("applies no rotation for the default down orientation", () => {
      const { container } = render(<Chevron />);
      expect(container.querySelector("svg")?.className.baseVal).not.toContain("rotate");
    });

    // Applies the matching rotation class for each orientation.
    it.each([
      ["up", "rotate-180"],
      ["left", "rotate-90"],
      ["right", "-rotate-90"],
    ] as const)("applies the matching rotation class for %s orientation", (orientation, expectedClass) => {
      const { container } = render(<Chevron orientation={orientation} />);
      expect(container.querySelector("svg")?.className.baseVal).toContain(expectedClass);
    });

    // Applies reduced opacity when disabled.
    it("applies reduced opacity when disabled", () => {
      const { container } = render(<Chevron disabled />);
      expect(container.querySelector("svg")?.className.baseVal).toContain("opacity-40");
    });
  });

  describe("Dropdown", () => {
    const options = [
      { value: 0, label: "January", disabled: false },
      { value: 1, label: "February", disabled: false },
    ];

    // Shows the selected option's label on the trigger.
    it("shows the selected option's label on the trigger", () => {
      render(<Dropdown options={options} value={1} onChange={jest.fn()} aria-label="Month" />);
      expect(screen.getByRole("button", { name: "Month" })).toHaveTextContent("February");
    });

    // Opens the option list on trigger click.
    it("opens the option list on trigger click", () => {
      render(<Dropdown options={options} value={0} onChange={jest.fn()} aria-label="Month" />);
      fireEvent.click(screen.getByRole("button", { name: "Month" }));
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "February" })).toBeInTheDocument();
    });

    // Selecting an option calls onChange with react-day-picker's expected event shape and closes the list.
    it("selecting an option calls onChange with the expected event shape and closes the list", () => {
      const onChange = jest.fn();
      render(<Dropdown options={options} value={0} onChange={onChange} aria-label="Month" />);
      fireEvent.click(screen.getByRole("button", { name: "Month" }));
      fireEvent.click(screen.getByRole("option", { name: "February" }));

      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ target: { value: "1" } }));
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    // Closes the list on outside click.
    it("closes the list on outside click", () => {
      render(<Dropdown options={options} value={0} onChange={jest.fn()} aria-label="Month" />);
      fireEvent.click(screen.getByRole("button", { name: "Month" }));
      expect(screen.getByRole("listbox")).toBeInTheDocument();

      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    // Closes the list on escape.
    it("closes the list on escape", () => {
      render(<Dropdown options={options} value={0} onChange={jest.fn()} aria-label="Month" />);
      fireEvent.click(screen.getByRole("button", { name: "Month" }));
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    // Disables the trigger when the disabled prop is set.
    it("disables the trigger when the disabled prop is set", () => {
      render(<Dropdown options={options} value={0} onChange={jest.fn()} disabled aria-label="Month" />);
      expect(screen.getByRole("button", { name: "Month" })).toBeDisabled();
    });

    // Renders gracefully with no options.
    it("renders gracefully with no options", () => {
      render(<Dropdown options={undefined} value={0} onChange={jest.fn()} aria-label="Month" />);
      expect(screen.getByRole("button")).toBeInTheDocument();
    });
  });

  describe("calendarClassNames", () => {
    // Defines every class key react-day-picker's dropdown caption layout expects.
    it("defines every class key react-day-picker's dropdown caption layout expects", () => {
      expect(calendarClassNames).toHaveProperty("month_caption");
      expect(calendarClassNames).toHaveProperty("dropdowns");
      expect(calendarClassNames).toHaveProperty("selected");
      expect(calendarClassNames).toHaveProperty("disabled");
    });
  });

  describe("useCalendarPopover", () => {
    // Starts closed with no anchor rect.
    it("starts closed with no anchor rect", () => {
      const { result } = renderHook(() => useCalendarPopover());
      expect(result.current.open).toBe(false);
      expect(result.current.anchorRect).toBeNull();
    });

    // Opens and captures the trigger's bounding rect.
    it("opens and captures the trigger's bounding rect", () => {
      const { result } = renderHook(() => useCalendarPopover());
      const button = document.createElement("button");
      document.body.appendChild(button);
      result.current.triggerRef.current = button;

      act(() => {
        result.current.openPopover();
      });

      expect(result.current.open).toBe(true);
      expect(result.current.anchorRect).not.toBeNull();
      document.body.removeChild(button);
    });

    // Closes on explicit closePopover call.
    it("closes on explicit closePopover call", () => {
      const { result } = renderHook(() => useCalendarPopover());
      act(() => result.current.openPopover());
      act(() => result.current.closePopover());
      expect(result.current.open).toBe(false);
    });

    // Closes on escape after the deferred listener attaches.
    it("closes on escape after the deferred listener attaches", () => {
      jest.useFakeTimers();
      const { result } = renderHook(() => useCalendarPopover());
      act(() => result.current.openPopover());
      act(() => {
        jest.advanceTimersByTime(0);
      });

      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });

      expect(result.current.open).toBe(false);
      jest.useRealTimers();
    });

    // Closes on outside pointerdown after the deferred listener attaches.
    it("closes on outside pointerdown after the deferred listener attaches", () => {
      jest.useFakeTimers();
      const { result } = renderHook(() => useCalendarPopover());
      act(() => result.current.openPopover());
      act(() => {
        jest.advanceTimersByTime(0);
      });

      act(() => {
        document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });

      expect(result.current.open).toBe(false);
      jest.useRealTimers();
    });

    // Closes on window resize after the deferred listener attaches.
    it("closes on window resize after the deferred listener attaches", () => {
      jest.useFakeTimers();
      const { result } = renderHook(() => useCalendarPopover());
      act(() => result.current.openPopover());
      act(() => {
        jest.advanceTimersByTime(0);
      });

      act(() => {
        window.dispatchEvent(new Event("resize"));
      });

      expect(result.current.open).toBe(false);
      jest.useRealTimers();
    });
  });
});
