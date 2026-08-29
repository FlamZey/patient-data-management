import { act, fireEvent, render, screen } from "@testing-library/react";

import DobRangeFilter from "@/components/DobRangeFilter";

describe("components/DobRangeFilter", () => {
  // Renders the trigger in the neutral color when no range is applied.
  it("renders the trigger in the neutral color when no range is applied", () => {
    render(<DobRangeFilter from={null} to={null} onApply={jest.fn()} />);
    const trigger = screen.getByRole("button", { name: "Filter by Date of Birth" });
    expect(trigger.className).not.toContain("text-accent");
  });

  // Renders the trigger in accent color when a range is already applied.
  it("renders the trigger in accent color when a range is already applied", () => {
    render(<DobRangeFilter from="1990-01-01" to={null} onApply={jest.fn()} />);
    const trigger = screen.getByRole("button", { name: "Filter by Date of Birth" });
    expect(trigger.className).toContain("text-accent");
  });

  // Opens the range calendar with clear cancel and apply controls on trigger click.
  it("opens the range calendar with clear, cancel, and apply controls on trigger click", () => {
    render(<DobRangeFilter from={null} to={null} onApply={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter by Date of Birth" }));

    expect(screen.getByRole("grid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
  });

  // Cancel closes the popover without calling onApply.
  it("cancel closes the popover without calling onApply", () => {
    const onApply = jest.fn();
    render(<DobRangeFilter from={null} to={null} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter by Date of Birth" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  // Clear calls onApply with a null range and closes the popover, even with no prior selection.
  it("clear calls onApply with a null range and closes the popover", () => {
    const onApply = jest.fn();
    render(<DobRangeFilter from="1990-01-01" to="1990-06-01" onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter by Date of Birth" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onApply).toHaveBeenCalledWith({ from: null, to: null });
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  // Apply with no day picked calls onApply with a null range.
  it("apply with no day picked calls onApply with a null range", () => {
    const onApply = jest.fn();
    render(<DobRangeFilter from={null} to={null} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter by Date of Birth" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledWith({ from: null, to: null });
  });

  // Selecting a start and end day and applying reports both iso dates.
  it("selecting a start and end day and applying reports both iso dates", () => {
    const onApply = jest.fn();
    render(<DobRangeFilter from={null} to={null} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter by Date of Birth" }));

    fireEvent.click(screen.getByRole("gridcell", { name: "10" }).querySelector("button")!);
    fireEvent.click(screen.getByRole("gridcell", { name: "20" }).querySelector("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onApply).toHaveBeenCalledTimes(1);
    const [range] = onApply.mock.calls[0];
    expect(range.from).toMatch(/-10$/);
    expect(range.to).toMatch(/-20$/);
  });

  // Re-seeds the draft from the currently applied range every time the popover reopens.
  it("re-seeds the draft from the currently applied range every time the popover reopens", () => {
    const onApply = jest.fn();
    render(<DobRangeFilter from="1990-03-10" to="1990-03-20" onApply={onApply} />);
    const trigger = screen.getByRole("button", { name: "Filter by Date of Birth" });

    // Open, apply with no further clicks -- if the draft weren't re-seeded
    // from `from`/`to` on open, this would report a null range instead of
    // the already-applied one.
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({ from: "1990-03-10", to: "1990-03-20" });

    // Close, reopen: re-seeding must happen on every open, not just the first.
    onApply.mockClear();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledWith({ from: "1990-03-10", to: "1990-03-20" });
  });

  // Closes on outside click after the deferred listener attaches, discarding an unapplied draft.
  it("closes on outside click after the deferred listener attaches, discarding an unapplied draft", () => {
    jest.useFakeTimers();
    const onApply = jest.fn();
    render(<DobRangeFilter from={null} to={null} onApply={onApply} />);
    fireEvent.click(screen.getByRole("button", { name: "Filter by Date of Birth" }));
    act(() => {
      jest.advanceTimersByTime(0);
    });

    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
