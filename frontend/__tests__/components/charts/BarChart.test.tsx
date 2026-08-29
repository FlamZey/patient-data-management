import { fireEvent, render, screen, within } from "@testing-library/react";

import BarChart, { type BarDatum } from "@/components/charts/BarChart";

describe("components/charts/BarChart", () => {
  // Renders the empty state when data is an empty array.
  it("renders the empty state when data is an empty array", () => {
    render(<BarChart data={[]} valueLabel="Patients" emptyMessage="No department data on file." />);
    expect(screen.getByText("No department data on file.")).toBeInTheDocument();
  });

  // Renders one bar and one label per category in the default horizontal orientation.
  it("renders one bar and one label per category in the default horizontal orientation", () => {
    const data: BarDatum[] = [
      { label: "Cardiology", value: 40 },
      { label: "Oncology", value: 25 },
    ];
    const { container } = render(<BarChart data={data} valueLabel="Patients" emptyMessage="No data." />);
    expect(container.querySelectorAll("rect[rx]")).toHaveLength(2);
    expect(screen.getByText("Cardiology")).toBeInTheDocument();
    expect(screen.getByText("Oncology")).toBeInTheDocument();
  });

  // Truncates category labels longer than 20 characters with an ellipsis.
  it("truncates category labels longer than 20 characters with an ellipsis", () => {
    const longLabel = "X".repeat(25);
    render(<BarChart data={[{ label: longLabel, value: 10 }]} valueLabel="Patients" emptyMessage="No data." />);
    expect(screen.getByText(`${"X".repeat(19)}…`)).toBeInTheDocument();
  });

  // Falls back to a scale of 1 instead of dividing by zero when every value is zero.
  it("falls back to a scale of 1 instead of dividing by zero when every value is zero", () => {
    const data: BarDatum[] = [
      { label: "Cardiology", value: 0 },
      { label: "Oncology", value: 0 },
    ];
    const { container } = render(<BarChart data={data} valueLabel="Patients" emptyMessage="No data." />);
    expect(container.querySelectorAll("rect[rx]")).toHaveLength(2);
    expect(screen.getAllByText("0")).toHaveLength(2);
  });

  // Formats values with the default one-decimal formatter when none is supplied.
  it("formats values with the default one-decimal formatter when none is supplied", () => {
    render(<BarChart data={[{ label: "Cardiology", value: 12.34 }]} valueLabel="Patients" emptyMessage="No data." />);
    expect(screen.getByText("12.3")).toBeInTheDocument();
  });

  // Uses a custom formatValue function when provided.
  it("uses a custom formatValue function when provided", () => {
    render(
      <BarChart
        data={[{ label: "Cardiology", value: 12 }]}
        valueLabel="Patients"
        emptyMessage="No data."
        formatValue={(value) => `${value} pts`}
      />,
    );
    expect(screen.getByText("12 pts")).toBeInTheDocument();
  });

  // Shows a tooltip with the category, value, and detail on hover and hides it on mouse leave.
  it("shows a tooltip with the category, value, and detail on hover and hides it on mouse leave", () => {
    const { container } = render(
      <BarChart
        data={[{ label: "Cardiology", value: 40, detail: "12.4% of patients" }]}
        valueLabel="Patients"
        emptyMessage="No data."
      />,
    );
    const [group] = container.querySelectorAll("g");
    fireEvent.mouseMove(group, { clientX: 10, clientY: 10 });

    const tooltip = screen.getByRole("status");
    expect(within(tooltip).getByText("Cardiology")).toBeInTheDocument();
    expect(within(tooltip).getByText("40 patients")).toBeInTheDocument();
    expect(within(tooltip).getByText("12.4% of patients")).toBeInTheDocument();

    fireEvent.mouseLeave(group);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // Renders vertical bars with a labeled axis when orientation is set to vertical.
  it("renders vertical bars with a labeled axis when orientation is set to vertical", () => {
    const data: BarDatum[] = [
      { label: "0-18", value: 10 },
      { label: "19-40", value: 30 },
      { label: "41-65", value: 20 },
    ];
    const { container } = render(
      <BarChart data={data} valueLabel="Patients" emptyMessage="No data." orientation="vertical" />,
    );
    expect(container.querySelectorAll("rect[rx]")).toHaveLength(3);
    expect(container.querySelector("svg")).toHaveAttribute("aria-label", "Patients by category");
  });

  // Thins the vertical axis labels to every Nth category once there are more than twelve bars.
  it("thins the vertical axis labels to every Nth category once there are more than twelve bars", () => {
    const data: BarDatum[] = Array.from({ length: 15 }, (_, i) => ({ label: `Bin ${i}`, value: i + 1 }));
    render(<BarChart data={data} valueLabel="Patients" emptyMessage="No data." orientation="vertical" />);
    // labelStride = ceil(15 / 12) = 2, so only every other category label is drawn.
    expect(screen.getByText("Bin 0")).toBeInTheDocument();
    expect(screen.queryByText("Bin 1")).not.toBeInTheDocument();
    expect(screen.getByText("Bin 2")).toBeInTheDocument();
  });
});
