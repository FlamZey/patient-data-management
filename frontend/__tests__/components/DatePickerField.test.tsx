import { act, fireEvent, render, screen } from "@testing-library/react";

import DatePickerField from "@/components/DatePickerField";

describe("components/DatePickerField", () => {
  // Shows a placeholder when the value is empty.
  it("shows a placeholder when the value is empty", () => {
    render(<DatePickerField value="" onChange={jest.fn()} />);
    expect(screen.getByRole("button", { name: /Select date/ })).toBeInTheDocument();
  });

  // Shows the formatted date when a valid value is provided.
  it("shows the formatted date when a valid value is provided", () => {
    render(<DatePickerField value="1990-01-15" onChange={jest.fn()} />);
    expect(screen.getByRole("button", { name: /Jan 15, 1990/ })).toBeInTheDocument();
  });

  // Applies the danger border class when hasError is set.
  it("applies the danger border class when hasError is set", () => {
    render(<DatePickerField value="" onChange={jest.fn()} hasError />);
    expect(screen.getByRole("button", { name: /Select date/ }).className).toContain("border-danger");
  });

  // Opens the calendar popover on trigger click.
  it("opens the calendar popover on trigger click", () => {
    render(<DatePickerField value="" onChange={jest.fn()} />);
    const trigger = screen.getByRole("button", { name: /Select date/ });
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("grid")).toBeInTheDocument();
  });

  // Closes the calendar popover on a second trigger click.
  it("closes the calendar popover on a second trigger click", () => {
    render(<DatePickerField value="" onChange={jest.fn()} />);
    const trigger = screen.getByRole("button", { name: /Select date/ });
    fireEvent.click(trigger);
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  // Selecting a day calls onChange with an iso date and closes the popover.
  it("selecting a day calls onChange with an iso date and closes the popover", () => {
    const onChange = jest.fn();
    render(<DatePickerField value="2024-06-15" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Jun 15, 2024/ }));

    fireEvent.click(screen.getByRole("gridcell", { name: "10" }).querySelector("button")!);

    expect(onChange).toHaveBeenCalledWith("2024-06-10");
    expect(screen.getByRole("button", { name: /Select date|Jun/ })).toHaveAttribute("aria-expanded", "false");
  });

  // Closes the popover on outside click, after the deferred listener attaches.
  it("closes the popover on outside click after the deferred listener attaches", () => {
    jest.useFakeTimers();
    render(<DatePickerField value="" onChange={jest.fn()} />);
    const trigger = screen.getByRole("button", { name: /Select date/ });
    fireEvent.click(trigger);
    act(() => {
      jest.advanceTimersByTime(0);
    });

    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    jest.useRealTimers();
  });
});
