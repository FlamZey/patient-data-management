import {
  CATEGORICAL,
  categoricalColor,
  divergingColor,
  formatNumber,
  formatPercent,
  niceAxis,
  niceTicks,
  sequentialColor,
} from "@/components/charts/chart-theme";

describe("components/charts/chart-theme", () => {
  describe("categoricalColor", () => {
    // Assigns colors by index in the fixed palette order.
    it("assigns colors by index in the fixed palette order", () => {
      expect(categoricalColor(0)).toBe(CATEGORICAL[0]);
      expect(categoricalColor(1)).toBe(CATEGORICAL[1]);
    });

    // Wraps around rather than generating a new hue past the palette length.
    it("wraps around rather than generating a new hue past the palette length", () => {
      expect(categoricalColor(CATEGORICAL.length)).toBe(CATEGORICAL[0]);
    });
  });

  describe("sequentialColor", () => {
    // Maps 0 to the lightest step and 1 to the darkest step.
    it("maps 0 and 1 to the two ends of the ramp", () => {
      expect(sequentialColor(0)).toBeTruthy();
      expect(sequentialColor(1)).toBeTruthy();
      expect(sequentialColor(0)).not.toBe(sequentialColor(1));
    });

    // Clamps values outside the 0 to 1 range instead of throwing.
    it("clamps values outside the 0 to 1 range instead of throwing", () => {
      expect(sequentialColor(-5)).toBe(sequentialColor(0));
      expect(sequentialColor(5)).toBe(sequentialColor(1));
    });

    // Falls back to the first step for a non finite input.
    it("falls back to the first step for a non finite input", () => {
      expect(sequentialColor(NaN)).toBe(sequentialColor(0));
    });
  });

  describe("divergingColor", () => {
    // Returns the neutral color for a value near zero.
    it("returns the neutral color for a value near zero", () => {
      expect(divergingColor(0.05)).toBe(divergingColor(-0.05));
    });

    // Returns a distinct color for a strong negative correlation.
    it("returns a distinct color for a strong negative and positive correlation", () => {
      const negative = divergingColor(-0.9);
      const positive = divergingColor(0.9);
      const neutral = divergingColor(0);
      expect(negative).not.toBe(neutral);
      expect(positive).not.toBe(neutral);
      expect(negative).not.toBe(positive);
    });

    // Falls back to neutral for a non finite input.
    it("falls back to neutral for a non finite input", () => {
      expect(divergingColor(NaN)).toBe(divergingColor(0));
    });
  });

  describe("niceAxis", () => {
    // Returns a fallback zero axis for a non positive max.
    it("returns a fallback zero axis for a non positive max", () => {
      expect(niceAxis(0)).toEqual({ ticks: [0], axisMax: 1 });
      expect(niceAxis(-5)).toEqual({ ticks: [0], axisMax: 1 });
    });

    // Rounds the axis maximum up to a round step above the data maximum.
    it("rounds the axis maximum up to a round step above the data maximum", () => {
      const { axisMax, ticks } = niceAxis(87);
      expect(axisMax).toBeGreaterThanOrEqual(87);
      expect(ticks[ticks.length - 1]).toBe(axisMax);
      expect(ticks[0]).toBe(0);
    });
  });

  describe("niceTicks", () => {
    // Returns an empty array for non finite bounds.
    it("returns an empty array for non finite bounds", () => {
      expect(niceTicks(NaN, 10)).toEqual([]);
    });

    // Returns a single tick when min equals max.
    it("returns a single tick when min equals max", () => {
      expect(niceTicks(5, 5)).toEqual([5]);
    });

    // Produces ticks that stay within the requested range.
    it("produces ticks that stay within the requested range", () => {
      const ticks = niceTicks(0, 100);
      expect(ticks.every((t) => t >= 0 && t <= 100 + 1e-6)).toBe(true);
      expect(ticks.length).toBeGreaterThan(0);
    });
  });

  describe("formatNumber", () => {
    // Formats with locale grouping.
    it("formats large numbers with locale grouping", () => {
      expect(formatNumber(12345, 0)).toMatch(/12,345/);
    });

    // Rounds to the requested max fraction digits.
    it("rounds to the requested max fraction digits", () => {
      expect(formatNumber(1.2345, 2)).toBe("1.23");
    });
  });

  describe("formatPercent", () => {
    // Computes a percentage of the whole.
    it("computes a percentage of the whole", () => {
      expect(formatPercent(1, 4)).toBe("25.0%");
    });

    // Returns 0 percent rather than dividing by zero when whole is zero.
    it("returns 0 percent rather than dividing by zero when whole is zero", () => {
      expect(formatPercent(5, 0)).toBe("0%");
    });
  });
});
