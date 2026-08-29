import { fireEvent, render, screen, within } from "@testing-library/react";

import LineChart, { type LinePoint } from "@/components/charts/LineChart";

// The mouse-move handler reads event.currentTarget.getBoundingClientRect() to
// translate a cursor position into a data index; jsdom never lays elements
// out, so every hover test mocks it against the chart's fixed 520-wide
// viewBox coordinate space.
function mockSvgBounds(svg: SVGSVGElement, height: number) {
  jest.spyOn(svg, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 520,
    height,
    right: 520,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => {},
  } as DOMRect);
}

describe("components/charts/LineChart", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Renders the empty state when data is an empty array.
  it("renders the empty state when data is an empty array", () => {
    render(<LineChart data={[]} valueLabel="Patients" emptyMessage="No visit data on file." />);
    expect(screen.getByText("No visit data on file.")).toBeInTheDocument();
  });

  // Renders the empty state for a single point, since a trend needs at least two.
  it("renders the empty state for a single point, since a trend needs at least two", () => {
    render(
      <LineChart data={[{ label: "Jan", value: 10 }]} valueLabel="Patients" emptyMessage="No visit data on file." />,
    );
    expect(screen.getByText("No visit data on file.")).toBeInTheDocument();
  });

  // Draws one connected line segment per point for a valid series.
  it("draws one connected line segment per point for a valid series", () => {
    const data: LinePoint[] = [
      { label: "Jan", value: 10 },
      { label: "Feb", value: 20 },
      { label: "Mar", value: 15 },
    ];
    const { container } = render(<LineChart data={data} valueLabel="Patients" emptyMessage="No data." />);
    const [mainLine] = container.querySelectorAll("path");
    const commandCount = (mainLine.getAttribute("d")?.match(/[ML]/g) ?? []).length;
    expect(commandCount).toBe(data.length);
    expect(container.querySelector("svg")).toHaveAttribute("aria-label", "Patients over time");
  });

  // Thins the x-axis labels to every Nth point once there are more than eight points.
  it("thins the x-axis labels to every Nth point once there are more than eight points", () => {
    const data: LinePoint[] = Array.from({ length: 10 }, (_, i) => ({ label: `P${i}`, value: i + 1 }));
    render(<LineChart data={data} valueLabel="Patients" emptyMessage="No data." />);
    // labelStride = ceil(10 / 8) = 2, so only every other point label is drawn.
    expect(screen.getByText("P0")).toBeInTheDocument();
    expect(screen.queryByText("P1")).not.toBeInTheDocument();
    expect(screen.getByText("P2")).toBeInTheDocument();
  });

  // Omits the rolling-average line and its legend entry when smoothing is disabled.
  it("omits the rolling-average line and its legend entry when smoothing is disabled", () => {
    const data: LinePoint[] = [
      { label: "Jan", value: 10 },
      { label: "Feb", value: 20 },
      { label: "Mar", value: 15 },
    ];
    const { container } = render(
      <LineChart data={data} valueLabel="Patients" emptyMessage="No data." smoothingWindow={0} />,
    );
    expect(container.querySelectorAll("path")).toHaveLength(1);
    expect(screen.queryByText(/rolling average/)).not.toBeInTheDocument();
  });

  // Draws the rolling-average line and its legend once enough points fill a full window.
  it("draws the rolling-average line and its legend once enough points fill a full window", () => {
    const data: LinePoint[] = [
      { label: "Jan", value: 10 },
      { label: "Feb", value: 20 },
      { label: "Mar", value: 30 },
      { label: "Apr", value: 40 },
      { label: "May", value: 50 },
    ];
    const { container } = render(
      <LineChart data={data} valueLabel="Patients" emptyMessage="No data." smoothingWindow={3} />,
    );
    expect(container.querySelectorAll("path")).toHaveLength(2);
    expect(screen.getByText("Monthly patients")).toBeInTheDocument();
    expect(screen.getByText("3-month rolling average")).toBeInTheDocument();
  });

  // Shows a tooltip and a hover marker for the point nearest the cursor, and clears both on mouse leave.
  it("shows a tooltip and a hover marker for the point nearest the cursor, and clears both on mouse leave", () => {
    const data: LinePoint[] = [
      { label: "Jan", value: 10 },
      { label: "Feb", value: 20 },
      { label: "Mar", value: 30 },
      { label: "Apr", value: 40 },
      { label: "May", value: 50 },
    ];
    const { container } = render(
      <LineChart data={data} valueLabel="Patients" emptyMessage="No data." smoothingWindow={3} />,
    );
    const svg = container.querySelector("svg") as SVGSVGElement;
    mockSvgBounds(svg, 240);

    // clientX = 512 lands exactly on the last point (PADDING_LEFT + plotWidth).
    fireEvent.mouseMove(svg, { clientX: 512, clientY: 100 });

    const tooltip = screen.getByRole("status");
    expect(within(tooltip).getByText("May")).toBeInTheDocument();
    expect(within(tooltip).getByText("50 patients")).toBeInTheDocument();
    expect(within(tooltip).getByText("3-month average: 40")).toBeInTheDocument();
    expect(container.querySelectorAll("circle")).toHaveLength(1);

    fireEvent.mouseLeave(svg);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(container.querySelectorAll("circle")).toHaveLength(0);
  });
});
