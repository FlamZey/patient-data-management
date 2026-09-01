import {
  NEUTRAL,
  RANK_RAMP,
  divergingColor,
  formatNumber,
  formatPercent,
  niceAxis,
  rankColor,
  sequentialColor,
} from "@/components/charts/chart-theme";

describe("components/charts/chart-theme", () => {
  describe("rankColor", () => {
    // Steps down the rank ramp for the first few ranks.
    it("steps down the rank ramp for the first few ranks", () => {
      expect(rankColor(0)).toBe(RANK_RAMP[0]);
      expect(rankColor(1)).toBe(RANK_RAMP[1]);
      expect(rankColor(2)).toBe(RANK_RAMP[2]);
    });

    // Falls back to neutral past the ramp's length rather than generating a new hue.
    it("falls back to neutral past the ramp's length", () => {
      expect(rankColor(RANK_RAMP.length)).toBe(NEUTRAL);
      expect(rankColor(RANK_RAMP.length + 5)).toBe(NEUTRAL);
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
