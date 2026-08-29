import { fireEvent, render, screen, within } from "@testing-library/react";

import CorrelationHeatmap, { type CorrelationCell } from "@/components/charts/CorrelationHeatmap";

const labels = ["Age", "BMI", "Weight"];
// Age×Weight, Weight×Age, BMI×Weight, and Weight×BMI are intentionally left
// out of `cells` to exercise the "not enough overlapping values" branch.
// The Age×Age diagonal entry carries a nonzero r on purpose, to prove the
// diagonal always renders "same field" rather than that value.
const cells: CorrelationCell[] = [
  { xLabel: "Age", yLabel: "Age", r: 0.9, n: 500 },
  { xLabel: "Age", yLabel: "BMI", r: 1, n: 1234 },
  { xLabel: "BMI", yLabel: "Age", r: -1, n: 1234 },
];

describe("components/charts/CorrelationHeatmap", () => {
  // Renders the empty state when there are no numeric fields to correlate.
  it("renders the empty state when there are no numeric fields to correlate", () => {
    render(<CorrelationHeatmap labels={[]} cells={[]} emptyMessage="No numeric fields on file." />);
    expect(screen.getByText("No numeric fields on file.")).toBeInTheDocument();
  });

  // Renders one cell per label pair, forming a full square matrix, plus a header per label.
  it("renders one cell per label pair, forming a full square matrix, plus a header per label", () => {
    const { container } = render(<CorrelationHeatmap labels={labels} cells={cells} emptyMessage="No data." />);
    expect(container.querySelectorAll('rect[rx="3"]')).toHaveLength(labels.length * labels.length);
    expect(screen.getAllByText("Age")).not.toHaveLength(0);
    expect(screen.getAllByText("BMI")).not.toHaveLength(0);
    expect(screen.getAllByText("Weight")).not.toHaveLength(0);
  });

  // Colors and labels a perfect positive correlation distinctly from a perfect negative one.
  it("colors and labels a perfect positive correlation distinctly from a perfect negative one", () => {
    const { container } = render(<CorrelationHeatmap labels={labels} cells={cells} emptyMessage="No data." />);
    // Age×BMI: r = 1 -> deep positive step of the diverging ramp.
    expect(container.querySelector('rect[fill="#dba43c"]')).toBeInTheDocument();
    expect(screen.getByText("1.00")).toBeInTheDocument();
    // BMI×Age: r = -1 -> deep negative step of the diverging ramp.
    expect(container.querySelector('rect[fill="#3aa88f"]')).toBeInTheDocument();
    expect(screen.getByText("-1.00")).toBeInTheDocument();
  });

  // Always renders the diagonal as "same field" regardless of any r value supplied for it.
  it('always renders the diagonal as "same field" regardless of any r value supplied for it', () => {
    render(<CorrelationHeatmap labels={labels} cells={cells} emptyMessage="No data." />);
    // Three diagonal cells (Age, BMI, Weight), each showing an em dash rather
    // than a formatted number -- even Age×Age, whose fixture sets r = 0.9.
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.queryByText("0.90")).not.toBeInTheDocument();
  });

  // Renders a transparent cell with a placeholder for pairs without enough overlapping values.
  it("renders a transparent cell with a placeholder for pairs without enough overlapping values", () => {
    const { container } = render(<CorrelationHeatmap labels={labels} cells={cells} emptyMessage="No data." />);
    // Age×Weight, Weight×Age, BMI×Weight, Weight×BMI have no matching cell.
    expect(container.querySelectorAll('rect[fill="transparent"]')).toHaveLength(4);
    expect(screen.getAllByText("·")).toHaveLength(4);
  });

  // Shows a tooltip with the field pair and correlation on hover and hides it on mouse leave.
  it("shows a tooltip with the field pair and correlation on hover and hides it on mouse leave", () => {
    const { container } = render(<CorrelationHeatmap labels={labels} cells={cells} emptyMessage="No data." />);
    const positiveCell = container.querySelector('rect[fill="#dba43c"]') as SVGRectElement;
    fireEvent.mouseMove(positiveCell, { clientX: 5, clientY: 5 });

    const tooltip = screen.getByRole("status");
    expect(within(tooltip).getByText("BMI × Age")).toBeInTheDocument();
    expect(within(tooltip).getByText("r = 1.000")).toBeInTheDocument();
    expect(within(tooltip).getByText("n = 1,234")).toBeInTheDocument();

    fireEvent.mouseLeave(positiveCell);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // Shows "not enough overlapping values" without a sample size for a cell with no data.
  it('shows "not enough overlapping values" without a sample size for a cell with no data', () => {
    const { container } = render(<CorrelationHeatmap labels={labels} cells={cells} emptyMessage="No data." />);
    const transparentCell = container.querySelector('rect[fill="transparent"]') as SVGRectElement;
    fireEvent.mouseMove(transparentCell, { clientX: 5, clientY: 5 });

    const tooltip = screen.getByRole("status");
    expect(within(tooltip).getByText("Not enough overlapping values")).toBeInTheDocument();
    expect(within(tooltip).queryByText(/^n = /)).not.toBeInTheDocument();
  });

  // Always renders the fixed Pearson r legend regardless of the data supplied.
  it("always renders the fixed Pearson r legend regardless of the data supplied", () => {
    render(<CorrelationHeatmap labels={labels} cells={[]} emptyMessage="No data." />);
    expect(screen.getByText("Pearson r:")).toBeInTheDocument();
    expect(screen.getByText("≈ 0")).toBeInTheDocument();
    expect(screen.getByText("−1.0 to −0.5")).toBeInTheDocument();
    expect(screen.getByText("0.5 to 1.0")).toBeInTheDocument();
  });
});
