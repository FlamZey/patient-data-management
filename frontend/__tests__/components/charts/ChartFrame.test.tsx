import { act, render, renderHook, screen } from "@testing-library/react";

import { ChartCard, ChartEmpty, ChartLegend, ChartTooltip, useChartTooltip } from "@/components/charts/ChartFrame";

describe("components/charts/ChartFrame", () => {
  describe("ChartCard", () => {
    // Renders title, subtitle, controls, footnote, and children together.
    it("renders title, subtitle, controls, footnote, and children together", () => {
      render(
        <ChartCard title="Age distribution" subtitle="By bracket" controls={<button>Export</button>} footnote="Note">
          <p>chart body</p>
        </ChartCard>,
      );
      expect(screen.getByText("Age distribution")).toBeInTheDocument();
      expect(screen.getByText("By bracket")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
      expect(screen.getByText("Note")).toBeInTheDocument();
      expect(screen.getByText("chart body")).toBeInTheDocument();
    });

    // Omits the subtitle, controls, and footnote when not provided.
    it("omits the subtitle, controls, and footnote when not provided", () => {
      render(
        <ChartCard title="Age distribution">
          <p>chart body</p>
        </ChartCard>,
      );
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.getByText("Age distribution")).toBeInTheDocument();
    });
  });

  describe("ChartEmpty", () => {
    // Renders the provided message.
    it("renders the provided message", () => {
      render(<ChartEmpty message="No height data on file." />);
      expect(screen.getByText("No height data on file.")).toBeInTheDocument();
    });
  });

  describe("ChartLegend", () => {
    // Renders one entry per item with its label.
    it("renders one entry per item with its label", () => {
      render(
        <ChartLegend
          items={[
            { label: "Male · 40%", color: "#111" },
            { label: "Female · 60%", color: "#222" },
          ]}
        />,
      );
      expect(screen.getByText("Male · 40%")).toBeInTheDocument();
      expect(screen.getByText("Female · 60%")).toBeInTheDocument();
    });

    // Renders no items for an empty legend.
    it("renders no items for an empty legend", () => {
      const { container } = render(<ChartLegend items={[]} />);
      expect(container.querySelectorAll("li")).toHaveLength(0);
    });
  });

  describe("ChartTooltip", () => {
    // Renders nothing when there is no active tooltip.
    it("renders nothing when there is no active tooltip", () => {
      const { container } = render(<ChartTooltip tooltip={null} />);
      expect(container).toBeEmptyDOMElement();
    });

    // Renders every line, with the first line styled as the heading.
    it("renders every line of an active tooltip", () => {
      render(<ChartTooltip tooltip={{ x: 10, y: 20, lines: ["Male", "40 patients", "40% of total"] }} />);
      expect(screen.getByText("Male")).toBeInTheDocument();
      expect(screen.getByText("40 patients")).toBeInTheDocument();
      expect(screen.getByText("40% of total")).toBeInTheDocument();
    });

    // Flips to the left of the cursor once past the midpoint threshold.
    it("flips to the left of the cursor once past the midpoint threshold", () => {
      const { container, rerender } = render(<ChartTooltip tooltip={{ x: 50, y: 20, lines: ["A"] }} />);
      expect((container.firstChild as HTMLElement).style.transform).toContain("12px");

      rerender(<ChartTooltip tooltip={{ x: 300, y: 20, lines: ["A"] }} />);
      expect((container.firstChild as HTMLElement).style.transform).toContain("-105%");
    });
  });

  describe("useChartTooltip", () => {
    // Starts with no tooltip shown.
    it("starts with no tooltip shown", () => {
      const { result } = renderHook(() => useChartTooltip());
      expect(result.current.tooltip).toBeNull();
    });

    // Does nothing when the container ref is not yet attached.
    it("does nothing when the container ref is not yet attached", () => {
      const { result } = renderHook(() => useChartTooltip());
      act(() => {
        result.current.showTooltip({ clientX: 10, clientY: 10 }, ["A"]);
      });
      expect(result.current.tooltip).toBeNull();
    });

    // Clears the tooltip on hide.
    it("clears the tooltip on hide", () => {
      const { result } = renderHook(() => useChartTooltip());
      act(() => {
        result.current.hideTooltip();
      });
      expect(result.current.tooltip).toBeNull();
    });
  });
});
