import { render, screen } from "@testing-library/react";

import ShareBars from "@/components/charts/ShareBars";
import { NEUTRAL, RANK_RAMP } from "@/components/charts/chart-theme";

describe("components/charts/ShareBars", () => {
  // Renders the empty state when data is an empty array.
  it("renders the empty state when data is an empty array", () => {
    render(<ShareBars data={[]} emptyMessage="No gender data on file." />);
    expect(screen.getByText("No gender data on file.")).toBeInTheDocument();
  });

  // Renders the empty state when every value is zero.
  it("renders the empty state when every value is zero", () => {
    render(<ShareBars data={[{ label: "Male", value: 0 }]} emptyMessage="No data." />);
    expect(screen.getByText("No data.")).toBeInTheDocument();
  });

  // Renders one row per datum, each showing its share of the total as a rounded percentage.
  it("renders one row per datum with its share of the total", () => {
    render(
      <ShareBars
        data={[
          { label: "Male", value: 30 },
          { label: "Female", value: 70 },
        ]}
        emptyMessage="No data."
      />,
    );
    expect(screen.getByText("Male")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
    expect(screen.getByText("Female")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
  });

  // A sub-half-percent row keeps a decimal rather than rounding to a flat "0%" beside a visible bar.
  it("keeps a decimal for a sub-half-percent row instead of showing 0%", () => {
    render(
      <ShareBars
        data={[
          { label: "Common", value: 999 },
          { label: "Rare", value: 1 },
        ]}
        emptyMessage="No data."
      />,
    );
    expect(screen.getByText("0.1%")).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  // Colors rows by rank, and a row labeled "Other" as neutral regardless of its rank.
  it('colors rows by rank and a row labeled "Other" as neutral', () => {
    const { container } = render(
      <ShareBars
        data={[
          { label: "Male", value: 30 },
          { label: "Female", value: 60 },
          { label: "Other", value: 10 },
        ]}
        emptyMessage="No data."
      />,
    );
    const bars = Array.from(container.querySelectorAll("div")).filter(
      (el) => el.style.backgroundColor,
    ) as HTMLDivElement[];
    expect(bars).toHaveLength(3);
    expect(bars[0].style.backgroundColor).toBe(hexToRgb(RANK_RAMP[0]));
    expect(bars[1].style.backgroundColor).toBe(hexToRgb(RANK_RAMP[1]));
    expect(bars[2].style.backgroundColor).toBe(hexToRgb(NEUTRAL));
  });

  // Uses a caller-supplied color instead of the rank ramp when one is provided.
  it("uses a caller-supplied color instead of the rank ramp when provided", () => {
    const { container } = render(
      <ShareBars data={[{ label: "Normal", value: 10, color: "#123456" }]} emptyMessage="No data." />,
    );
    const bar = Array.from(container.querySelectorAll("div")).find((el) => el.style.backgroundColor) as
      | HTMLDivElement
      | undefined;
    expect(bar?.style.backgroundColor).toBe(hexToRgb("#123456"));
  });
});

// jsdom normalizes inline hex colors to rgb() when read back via style.backgroundColor.
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${r}, ${g}, ${b})`;
}
