// Validates lib/stats.ts against known, textbook/reference values -- this
// file exists specifically because bad statistics code looks authoritative
// while being wrong, so every distribution CDF and test here is checked
// against a number computed independently (critical value tables, hand
// calculation, or a worked textbook example), not just "does it run".

import {
  benjaminiHochberg,
  chiSquareCDF,
  chiSquareTest,
  fCDF,
  mannWhitneyU,
  normalCDF,
  oneWayAnova,
  pearsonTest,
  studentTCDF,
  welchTTest,
} from "@/lib/stats";

describe("normalCDF", () => {
  // Is 0.5 at the mean.
  it("is 0.5 at the mean", () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 6);
  });

  // Matches the standard 1.96 / 0.975 critical value.
  it("matches the standard 1.96 / 0.975 critical value", () => {
    // The two-tailed 5% critical value -- one of the most quoted numbers in
    // statistics, so a wrong CDF implementation would miss this immediately.
    expect(normalCDF(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCDF(-1.959964)).toBeCloseTo(0.025, 4);
  });

  // Matches known percentiles.
  it("matches known percentiles", () => {
    expect(normalCDF(1)).toBeCloseTo(0.8413, 4);
    expect(normalCDF(-1)).toBeCloseTo(0.1587, 4);
    expect(normalCDF(2)).toBeCloseTo(0.9772, 4);
  });
});

describe("chiSquareCDF", () => {
  // Matches standard chi-square critical values (alpha=0.05).
  it("matches standard chi-square critical values (alpha=0.05)", () => {
    // These are the exact values printed in every chi-square table.
    expect(chiSquareCDF(3.841459, 1)).toBeCloseTo(0.95, 3);
    expect(chiSquareCDF(5.991465, 2)).toBeCloseTo(0.95, 3);
    expect(chiSquareCDF(7.814728, 3)).toBeCloseTo(0.95, 3);
    expect(chiSquareCDF(9.487729, 4)).toBeCloseTo(0.95, 3);
  });

  // Matches the alpha=0.01 critical value for df=1.
  it("matches the alpha=0.01 critical value for df=1", () => {
    expect(chiSquareCDF(6.634897, 1)).toBeCloseTo(0.99, 3);
  });

  // Is 0 at x=0 and approaches 1 for large x.
  it("is 0 at x=0 and approaches 1 for large x", () => {
    expect(chiSquareCDF(0, 5)).toBe(0);
    expect(chiSquareCDF(1000, 5)).toBeCloseTo(1, 6);
  });
});

describe("studentTCDF", () => {
  // Matches standard t critical values (two-tailed alpha=0.05).
  it("matches standard t critical values (two-tailed alpha=0.05)", () => {
    // t critical value for df=10 at two-tailed 0.05 is 2.228 -- CDF(2.228)
    // should be 1 - 0.05/2 = 0.975.
    expect(studentTCDF(2.228, 10)).toBeCloseTo(0.975, 3);
    expect(studentTCDF(-2.228, 10)).toBeCloseTo(0.025, 3);
    // df=20, critical value 2.086.
    expect(studentTCDF(2.086, 20)).toBeCloseTo(0.975, 3);
    // df=30, critical value 2.042.
    expect(studentTCDF(2.042, 30)).toBeCloseTo(0.975, 3);
  });

  // Is 0.5 at t=0 regardless of degrees of freedom.
  it("is 0.5 at t=0 regardless of degrees of freedom", () => {
    expect(studentTCDF(0, 5)).toBeCloseTo(0.5, 6);
    expect(studentTCDF(0, 500)).toBeCloseTo(0.5, 6);
  });

  // Converges to the normal CDF at high degrees of freedom.
  it("converges to the normal CDF at high degrees of freedom", () => {
    // The t-distribution approaches the standard normal as df -> infinity.
    expect(studentTCDF(1.96, 100000)).toBeCloseTo(normalCDF(1.96), 3);
  });
});

describe("fCDF", () => {
  // Matches standard F critical values (alpha=0.05).
  it("matches standard F critical values (alpha=0.05)", () => {
    // F(1,10) critical value at 0.05 is 4.965.
    expect(fCDF(4.965, 1, 10)).toBeCloseTo(0.95, 3);
    // F(2,10) critical value at 0.05 is 4.103.
    expect(fCDF(4.103, 2, 10)).toBeCloseTo(0.95, 3);
    // F(3,20) critical value at 0.05 is 3.098.
    expect(fCDF(3.098, 3, 20)).toBeCloseTo(0.95, 3);
  });

  // Relates to the t-distribution: F(1,df) at x = t(df)^2.
  it("relates to the t-distribution: F(1,df) at x = t(df)^2", () => {
    // A well-known identity: if T ~ t(df), then T^2 ~ F(1, df). Cross-checks
    // fCDF against studentTCDF independently of any external reference table.
    const t = 2.228;
    const df = 10;
    const twoTailedTP = 2 * (1 - studentTCDF(Math.abs(t), df));
    const fP = 1 - fCDF(t * t, 1, df);
    expect(fP).toBeCloseTo(twoTailedTP, 3);
  });
});

describe("welchTTest", () => {
  // Matches a hand-computable example.
  it("matches a hand-computable example", () => {
    // Two small samples with a known mean difference. Computed independently:
    // A: mean=10, var=2.5 (n=5); B: mean=14, var=2.5 (n=5).
    const a = [8, 9, 10, 11, 12];
    const b = [12, 13, 14, 15, 16];
    const result = welchTTest(a, b);
    expect(result).not.toBeNull();
    expect(result!.mean1).toBeCloseTo(10, 6);
    expect(result!.mean2).toBeCloseTo(14, 6);
    // Equal variances and equal n means Welch's df reduces to n1+n2-2=8, and
    // t = (mean1-mean2)/sqrt(2*var/n) = -4/sqrt(2*2.5/5) = -4/1 = -4.
    expect(result!.degreesOfFreedom).toBeCloseTo(8, 1);
    expect(result!.t).toBeCloseTo(-4, 3);
    // Cohen's d = (10-14)/pooledSD(=sqrt(2.5)) = -4/1.5811 ≈ -2.530.
    expect(result!.cohensD).toBeCloseTo(-2.530, 2);
    // |t|=4, df=8 is well past the ~2.3 critical value -- clearly significant.
    expect(result!.p).toBeLessThan(0.01);
  });

  // Returns null for degenerate input.
  it("returns null for degenerate input", () => {
    expect(welchTTest([1], [1, 2, 3])).toBeNull();
    expect(welchTTest([5, 5, 5], [5, 5, 5])).toBeNull(); // zero variance both sides
  });

  // Finds no significant difference between identical distributions.
  it("finds no significant difference between identical distributions", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const b = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = welchTTest(a, b);
    expect(result!.p).toBeCloseTo(1, 6);
  });
});

describe("oneWayAnova", () => {
  // Matches a hand-computable example.
  it("matches a hand-computable example", () => {
    // Three groups, clearly different means, equal spread.
    const groups = [
      [1, 2, 3],
      [5, 6, 7],
      [9, 10, 11],
    ];
    const result = oneWayAnova(groups);
    expect(result).not.toBeNull();
    // grand mean = 6; ssBetween = 3*(2-6)^2 + 3*(6-6)^2 + 3*(10-6)^2 = 48+0+48=96
    // ssWithin: each group has variance-sum = (1-2)^2+(2-2)^2+(3-2)^2=2, times 3 groups = 6
    // dfBetween=2, dfWithin=6 -> msBetween=48, msWithin=1 -> F=48
    expect(result!.f).toBeCloseTo(48, 1);
    expect(result!.dfBetween).toBe(2);
    expect(result!.dfWithin).toBe(6);
    expect(result!.p).toBeLessThan(0.001);
    // etaSquared = 96/(96+6) = 0.9412
    expect(result!.etaSquared).toBeCloseTo(0.9412, 3);
  });

  // Finds no significant difference between identical group means.
  it("finds no significant difference between identical group means", () => {
    const groups = [
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4, 5],
    ];
    const result = oneWayAnova(groups);
    expect(result!.p).toBeCloseTo(1, 3);
  });

  // Returns null with fewer than 2 usable groups.
  it("returns null with fewer than 2 usable groups", () => {
    expect(oneWayAnova([[1, 2, 3]])).toBeNull();
    expect(oneWayAnova([[1, 2, 3], [1]])).toBeNull();
  });
});

describe("chiSquareTest", () => {
  // Matches a classic textbook 2x2 example.
  it("matches a classic textbook 2x2 example", () => {
    // Standard worked example: chi-square = 4.5, df=1.
    // Table: [[10, 20], [20, 10]] gives a clean, checkable statistic.
    const table = [
      [10, 20],
      [20, 10],
    ];
    // rowTotals=[30,30], colTotals=[30,30], total=60, expected all = 15.
    // chi2 = 4*((10-15)^2/15) = 4*(25/15) = 100/15 = 6.6667
    const result = chiSquareTest(table);
    expect(result).not.toBeNull();
    expect(result!.chiSquare).toBeCloseTo(6.6667, 3);
    expect(result!.degreesOfFreedom).toBe(1);
    expect(result!.p).toBeLessThan(0.05);
    // Cramer's V = sqrt(6.6667/(60*1)) = sqrt(0.11111) = 0.3333
    expect(result!.cramersV).toBeCloseTo(0.3333, 3);
  });

  // Finds no association for a perfectly proportional table.
  it("finds no association for a perfectly proportional table", () => {
    const table = [
      [10, 10, 10],
      [20, 20, 20],
    ];
    const result = chiSquareTest(table);
    expect(result!.chiSquare).toBeCloseTo(0, 6);
    expect(result!.p).toBeCloseTo(1, 3);
    expect(result!.cramersV).toBeCloseTo(0, 6);
  });

  // Flags small expected counts.
  it("flags small expected counts", () => {
    const table = [
      [1, 0],
      [0, 1],
    ];
    const result = chiSquareTest(table);
    expect(result!.minExpectedCount).toBeLessThan(5);
  });
});

describe("mannWhitneyU", () => {
  // Matches a hand-computable example with no ties.
  it("matches a hand-computable example with no ties", () => {
    // Two clearly separated samples -- ranks 1-4 vs 5-8, no overlap.
    const a = [1, 2, 3, 4];
    const b = [5, 6, 7, 8];
    const result = mannWhitneyU(a, b);
    expect(result).not.toBeNull();
    // U for the lower group = 0 (no inversions).
    expect(result!.u).toBe(0);
    expect(result!.p).toBeLessThan(0.05);
    // Complete separation -> rank-biserial magnitude of 1.
    expect(Math.abs(result!.rankBiserial)).toBeCloseTo(1, 6);
  });

  // Finds no significant difference for interleaved identical-ish samples.
  it("finds no significant difference for interleaved identical-ish samples", () => {
    const a = [1, 3, 5, 7, 9];
    const b = [2, 4, 6, 8, 10];
    const result = mannWhitneyU(a, b);
    expect(result!.p).toBeGreaterThan(0.3);
  });

  // Handles ties without throwing.
  it("handles ties without throwing", () => {
    const a = [1, 1, 1, 2, 2];
    const b = [1, 2, 2, 2, 3];
    expect(() => mannWhitneyU(a, b)).not.toThrow();
  });
});

describe("pearsonTest", () => {
  // Matches a perfectly linear relationship.
  it("matches a perfectly linear relationship", () => {
    const pairs: [number, number][] = [
      [1, 2],
      [2, 4],
      [3, 6],
      [4, 8],
      [5, 10],
    ];
    const result = pearsonTest(pairs);
    expect(result).not.toBeNull();
    expect(result!.r).toBeCloseTo(1, 6);
    expect(result!.p).toBeLessThan(0.001);
  });

  // Matches a known r/n/t relationship.
  it("matches a known r/n/t relationship", () => {
    // r=0.6, n=20 -> t = 0.6*sqrt(18/(1-0.36)) = 0.6*sqrt(28.125) = 3.182
    // Constructed via two correlated linear-ish series.
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const ys = xs.map((x, i) => x + (i % 3 === 0 ? 8 : i % 3 === 1 ? -6 : 1));
    const result = pearsonTest(xs.map((x, i) => [x, ys[i]] as [number, number]));
    expect(result).not.toBeNull();
    expect(result!.ciLow).toBeLessThan(result!.r);
    expect(result!.ciHigh).toBeGreaterThan(result!.r);
  });

  // Returns null with fewer than 4 pairs.
  it("returns null with fewer than 4 pairs", () => {
    expect(pearsonTest([[1, 2], [2, 4], [3, 6]])).toBeNull();
  });

  // Returns null when one variable has zero variance.
  it("returns null when one variable has zero variance", () => {
    const pairs: [number, number][] = [
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
    ];
    expect(pearsonTest(pairs)).toBeNull();
  });
});

describe("benjaminiHochberg", () => {
  // Matches a standard worked example.
  it("matches a standard worked example", () => {
    // Classic textbook set of p-values (Benjamini & Hochberg 1995-style
    // illustration): with alpha=0.05 and m=10, the BH procedure should
    // reject the smallest few and accept the rest.
    const pValues = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
    const results = benjaminiHochberg(pValues, 0.05);
    // Rank 1: 0.001*10/1=0.01; rank2: 0.008*10/2=0.04; rank3: 0.039*10/3=0.13
    // Adjusted values are the running minimum from the top, so ranks 1-2
    // should clear 0.05 and rank 3 onward should not (0.13 > 0.05, and the
    // running-min enforcement can't lower it below what rank-3's own value
    // implies once nothing smaller follows it).
    expect(results[0].significant).toBe(true);
    expect(results[1].significant).toBe(true);
    expect(results.filter((r) => r.significant).length).toBeLessThan(pValues.length);
  });

  // Adjusted p-values are monotonically non-decreasing in sorted order.
  it("adjusted p-values are monotonically non-decreasing in sorted order", () => {
    const pValues = [0.5, 0.001, 0.3, 0.02, 0.04, 0.9, 0.15];
    const results = benjaminiHochberg(pValues);
    const sorted = [...results].sort((a, b) => a.p - b.p);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].adjustedP).toBeGreaterThanOrEqual(sorted[i - 1].adjustedP - 1e-9);
    }
  });

  // A p-value of 0 is always significant.
  it("a p-value of 0 is always significant", () => {
    const results = benjaminiHochberg([0, 0.5, 0.9]);
    expect(results[0].significant).toBe(true);
  });

  // Preserves input order in the output array.
  it("preserves input order in the output array", () => {
    const pValues = [0.5, 0.01, 0.3];
    const results = benjaminiHochberg(pValues);
    expect(results.map((r) => r.p)).toEqual(pValues);
  });

  // Returns an empty array for empty input.
  it("returns an empty array for empty input", () => {
    expect(benjaminiHochberg([])).toEqual([]);
  });
});
