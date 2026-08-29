import { fireEvent, render, screen, within } from "@testing-library/react";

import ScatterChart from "@/components/charts/ScatterChart";

// The hit-layer rect reads event.currentTarget.getBoundingClientRect() to
// translate a cursor position into data coordinates; jsdom never lays
// elements out, so hover tests mock it to the plot's own pixel dimensions
// (466 x 236 for the default 280-tall chart) so the resulting value is exact.
function mockRectBounds(rect: SVGRectElement, width: number, height: number) {
  jest.spyOn(rect, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width,
    height,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => {},
  } as DOMRect);
}

describe("components/charts/ScatterChart", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Renders the empty state when there are no pairs.
  it("renders the empty state when there are no pairs", () => {
    render(<ScatterChart pairs={[]} xLabel="Weight" yLabel="Height" emptyMessage="No paired data on file." />);
    expect(screen.getByText("No paired data on file.")).toBeInTheDocument();
  });

  // Renders the empty state for a single pair, since a scatter needs at least two.
  it("renders the empty state for a single pair, since a scatter needs at least two", () => {
    render(
      <ScatterChart
        pairs={[[10, 20]]}
        xLabel="Weight"
        yLabel="Height"
        emptyMessage="No paired data on file."
      />,
    );
    expect(screen.getByText("No paired data on file.")).toBeInTheDocument();
  });

  // Renders one dot per pair and the plain patient count when under the sampling cap.
  it("renders one dot per pair and the plain patient count when under the sampling cap", () => {
    const pairs: [number, number][] = [
      [10, 20],
      [15, 25],
      [20, 30],
      [25, 35],
      [30, 40],
    ];
    const { container } = render(
      <ScatterChart pairs={pairs} xLabel="Weight" yLabel="Height" emptyMessage="No data." />,
    );
    expect(container.querySelectorAll("circle")).toHaveLength(5);
    expect(screen.getByText("5 patients")).toBeInTheDocument();
  });

  // Downsamples deterministically to a fixed stride once the pair count passes maxPoints.
  it("downsamples deterministically to a fixed stride once the pair count passes maxPoints", () => {
    const pairs: [number, number][] = Array.from({ length: 12 }, (_, i) => [i, i * 2]);
    const { container } = render(
      <ScatterChart pairs={pairs} xLabel="Weight" yLabel="Height" emptyMessage="No data." maxPoints={5} />,
    );
    // stride = ceil(12 / 5) = 3, keeping indices 0, 3, 6, 9 -> 4 points.
    expect(container.querySelectorAll("circle")).toHaveLength(4);
    expect(screen.getByText("4 of 12 patients shown")).toBeInTheDocument();
  });

  // Draws a trendline and reports its correlation when the points vary on both axes.
  it("draws a trendline and reports its correlation when the points vary on both axes", () => {
    const pairs: [number, number][] = [
      [0, 0],
      [10, 10],
      [20, 20],
    ];
    const { container } = render(
      <ScatterChart pairs={pairs} xLabel="Weight" yLabel="Height" emptyMessage="No data." />,
    );
    expect(container.querySelector('line[stroke="#199e70"]')).toBeInTheDocument();
    expect(screen.getByText("Trendline · r = 1.000 (all 3 points)")).toBeInTheDocument();
  });

  // Omits the trendline and correlation when every x value is identical.
  it("omits the trendline and correlation when every x value is identical", () => {
    const pairs: [number, number][] = [
      [5, 10],
      [5, 20],
      [5, 30],
    ];
    const { container } = render(
      <ScatterChart pairs={pairs} xLabel="Weight" yLabel="Height" emptyMessage="No data." />,
    );
    expect(container.querySelectorAll("circle")).toHaveLength(3);
    expect(container.querySelector('line[stroke="#199e70"]')).not.toBeInTheDocument();
    expect(screen.getByText("Trendline")).toBeInTheDocument();
  });

  // Shows a tooltip with the value under the cursor on hover and hides it on mouse leave.
  it("shows a tooltip with the value under the cursor on hover and hides it on mouse leave", () => {
    const pairs: [number, number][] = [
      [0, 0],
      [10, 10],
      [20, 20],
    ];
    const { container } = render(
      <ScatterChart pairs={pairs} xLabel="Weight" yLabel="Height" emptyMessage="No data." />,
    );
    const hitLayer = container.querySelector("rect") as SVGRectElement;
    mockRectBounds(hitLayer, 466, 236);

    // clientX/clientY at the rect's origin resolve to (xMin, yMax): with a
    // 0-20 span padded 4%/6%, that's x = -0.8, y = 21.2.
    fireEvent.mouseMove(hitLayer, { clientX: 0, clientY: 0 });

    const tooltip = screen.getByRole("status");
    expect(within(tooltip).getByText("Weight: -0.8")).toBeInTheDocument();
    expect(within(tooltip).getByText("Height: 21.2")).toBeInTheDocument();

    fireEvent.mouseLeave(hitLayer);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
