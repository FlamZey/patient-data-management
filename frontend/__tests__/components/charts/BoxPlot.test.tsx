import { fireEvent, render, screen, within } from "@testing-library/react";

import BoxPlot from "@/components/charts/BoxPlot";
import type { BoxStats } from "@/lib/analytics";

const CARDIOLOGY: BoxStats = { label: "Cardiology", n: 10, min: 22.5, q1: 31.2, median: 42.5, q3: 51.8, max: 63.4 };
const ONCOLOGY: BoxStats = { label: "Oncology", n: 8, min: 25, q1: 35, median: 45, q3: 55, max: 65 };
const THIN: BoxStats = { label: "Rare", n: 3, min: 10, q1: 12, median: 14, q3: 16, max: 18 };

describe("components/charts/BoxPlot", () => {
  // Renders the empty state when data is an empty array.
  it("renders the empty state when data is an empty array", () => {
    render(<BoxPlot data={[]} valueLabel="Age" emptyMessage="No age data on file." />);
    expect(screen.getByText("No age data on file.")).toBeInTheDocument();
  });

  // Renders the empty state when every group is thinner than the minimum group size.
  it("renders the empty state when every group is thinner than the minimum group size", () => {
    render(<BoxPlot data={[THIN]} valueLabel="Age" emptyMessage="Not enough patients per group." />);
    expect(screen.getByText("Not enough patients per group.")).toBeInTheDocument();
  });

  // Includes groups below the default threshold once minGroupSize is lowered.
  it("includes groups below the default threshold once minGroupSize is lowered", () => {
    const { container } = render(
      <BoxPlot data={[THIN]} valueLabel="Age" emptyMessage="No data." minGroupSize={2} />,
    );
    expect(container.querySelectorAll('rect[rx="3"]')).toHaveLength(1);
  });

  // Renders one box per group that meets the minimum group size, dropping thinner ones.
  it("renders one box per group that meets the minimum group size, dropping thinner ones", () => {
    const { container } = render(
      <BoxPlot data={[CARDIOLOGY, ONCOLOGY, THIN]} valueLabel="Age" emptyMessage="No data." />,
    );
    expect(container.querySelectorAll('rect[rx="3"]')).toHaveLength(2);
    expect(screen.getByText("Cardiology")).toBeInTheDocument();
    expect(screen.getByText("Oncology")).toBeInTheDocument();
    expect(screen.queryByText("Rare")).not.toBeInTheDocument();
  });

  // Falls back to a span of 1 instead of dividing by zero when every group's values are identical.
  it("falls back to a span of 1 instead of dividing by zero when every group's values are identical", () => {
    const flat: BoxStats = { label: "Flat", n: 6, min: 40, q1: 40, median: 40, q3: 40, max: 40 };
    const { container } = render(<BoxPlot data={[flat]} valueLabel="Age" emptyMessage="No data." />);
    expect(container.querySelectorAll('rect[rx="3"]')).toHaveLength(1);
  });

  // Does not rotate group labels when there are four or fewer groups.
  it("does not rotate group labels when there are four or fewer groups", () => {
    const { container } = render(
      <BoxPlot data={[CARDIOLOGY, ONCOLOGY]} valueLabel="Age" emptyMessage="No data." />,
    );
    expect(container.querySelectorAll("text[transform]")).toHaveLength(0);
  });

  // Rotates group labels once there are more than four groups to avoid collisions.
  it("rotates group labels once there are more than four groups to avoid collisions", () => {
    const groups: BoxStats[] = Array.from({ length: 5 }, (_, i) => ({
      label: `Group ${i}`,
      n: 6,
      min: i,
      q1: i + 1,
      median: i + 2,
      q3: i + 3,
      max: i + 4,
    }));
    const { container } = render(<BoxPlot data={groups} valueLabel="Age" emptyMessage="No data." />);
    expect(container.querySelectorAll("text[transform]")).toHaveLength(5);
  });

  // Shows a tooltip with the median, IQR, range, and sample size on hover and hides it on mouse leave.
  it("shows a tooltip with the median, IQR, range, and sample size on hover and hides it on mouse leave", () => {
    const { container } = render(<BoxPlot data={[CARDIOLOGY]} valueLabel="Age" emptyMessage="No data." />);
    // The box rect's nearest <g> ancestor carries the hover handlers; ticks
    // render their own <g> elements earlier in document order.
    const box = container.querySelector('rect[rx="3"]') as SVGRectElement;
    const group = box.closest("g") as SVGGElement;
    fireEvent.mouseMove(group, { clientX: 10, clientY: 10 });

    const tooltip = screen.getByRole("status");
    expect(within(tooltip).getByText("Cardiology")).toBeInTheDocument();
    expect(within(tooltip).getByText("Median 42.5")).toBeInTheDocument();
    expect(within(tooltip).getByText("IQR 31.2 – 51.8")).toBeInTheDocument();
    expect(within(tooltip).getByText("Range 22.5 – 63.4")).toBeInTheDocument();
    expect(within(tooltip).getByText("n = 10")).toBeInTheDocument();

    fireEvent.mouseLeave(group);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
