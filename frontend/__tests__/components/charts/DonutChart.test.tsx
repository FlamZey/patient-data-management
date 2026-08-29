import { fireEvent, render, screen } from "@testing-library/react";

import DonutChart from "@/components/charts/DonutChart";

describe("components/charts/DonutChart", () => {
  // Renders the empty state when data is an empty array.
  it("renders the empty state when data is an empty array", () => {
    render(<DonutChart data={[]} emptyMessage="No gender data on file." />);
    expect(screen.getByText("No gender data on file.")).toBeInTheDocument();
  });

  // Renders the empty state when every slice value is zero.
  it("renders the empty state when every slice value is zero", () => {
    render(
      <DonutChart data={[{ label: "Male", value: 0 }, { label: "Female", value: 0 }]} emptyMessage="No data." />,
    );
    expect(screen.getByText("No data.")).toBeInTheDocument();
  });

  // Renders one slice and one legend entry per data point, plus the total in the center.
  it("renders one slice and one legend entry per data point, plus the total in the center", () => {
    const { container } = render(
      <DonutChart data={[{ label: "Male", value: 30 }, { label: "Female", value: 70 }]} emptyMessage="No data." />,
    );
    expect(container.querySelectorAll("path")).toHaveLength(2);
    expect(screen.getByText("100")).toBeInTheDocument();
    expect(screen.getByText(/Male · 30\.0%/)).toBeInTheDocument();
    expect(screen.getByText(/Female · 70\.0%/)).toBeInTheDocument();
  });

  // Uses the default unit label of patients when none is provided.
  it("uses the default unit label of patients when none is provided", () => {
    render(<DonutChart data={[{ label: "Male", value: 5 }]} emptyMessage="No data." />);
    expect(screen.getByText("patients")).toBeInTheDocument();
  });

  // Uses a custom unit label when provided.
  it("uses a custom unit label when provided", () => {
    render(<DonutChart data={[{ label: "Male", value: 5 }]} emptyMessage="No data." unitLabel="records" />);
    expect(screen.getByText("records")).toBeInTheDocument();
  });

  // Shows a tooltip with the slice detail on hover and hides it on mouse leave.
  it("shows a tooltip with the slice detail on hover and hides it on mouse leave", () => {
    const { container } = render(
      <DonutChart data={[{ label: "Male", value: 40 }, { label: "Female", value: 60 }]} emptyMessage="No data." />,
    );
    const [firstSlice] = container.querySelectorAll("path");

    fireEvent.mouseMove(firstSlice, { clientX: 10, clientY: 10 });
    expect(screen.getByText("Male")).toBeInTheDocument();
    expect(screen.getByText("40 patients")).toBeInTheDocument();

    fireEvent.mouseLeave(firstSlice);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
