// Statistical primitives for Phase 3 (Relationships & Statistics): the math
// that decides whether a pattern visible in a chart is a real, testable
// association rather than a visual impression.
//
// This is the highest-risk file in the analytics dashboard -- bad statistics
// code is worse than no statistics code, since it looks authoritative while
// being wrong. Every distribution CDF here is a standard numerical-recipes
// algorithm (Lanczos approximation for log-gamma, continued fractions for the
// incomplete gamma/beta functions), and __tests__/lib/stats.test.ts checks
// each one against textbook critical values (e.g. chi-square df=1 at
// p=0.05 is the well-known 3.841) before any UI is built on top of this.
//
// No external stats library is used -- this app has no numpy/scipy
// equivalent available client-side, and pulling one in for ~10 functions
// would be a heavier dependency than writing (and testing) them directly.

// --- special functions -------------------------------------------------------

// Abramowitz & Stegun 7.1.26 -- max absolute error ~1.5e-7, ample precision
// for p-values reported to 3-4 significant figures.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function normalCDF(x: number, mean = 0, sd = 1): number {
  return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
}

// Lanczos approximation (g=7, 9 coefficients) -- standard reference
// implementation, accurate to ~15 significant digits.
const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function logGamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula -- the Lanczos series below only converges for x >= 0.5.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const shifted = x - 1;
  let sum = LANCZOS_COEFFICIENTS[0];
  const t = shifted + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_COEFFICIENTS.length; i += 1) {
    sum += LANCZOS_COEFFICIENTS[i] / (shifted + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

const MAX_ITERATIONS = 200;
const CONVERGENCE_EPSILON = 1e-14;
const MIN_FLOAT = 1e-300;

// Regularized lower incomplete gamma P(a,x), via a series expansion for
// x < a+1 and a continued fraction otherwise (Numerical Recipes §6.2) --
// the series converges too slowly past that crossover point.
function regularizedGammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  if (x < a + 1) {
    let term = 1 / a;
    let sum = term;
    let ap = a;
    for (let n = 0; n < MAX_ITERATIONS; n += 1) {
      ap += 1;
      term *= x / ap;
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * CONVERGENCE_EPSILON) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  let b = x + 1 - a;
  let c = 1 / MIN_FLOAT;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITERATIONS; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < MIN_FLOAT) d = MIN_FLOAT;
    c = b + an / c;
    if (Math.abs(c) < MIN_FLOAT) c = MIN_FLOAT;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < CONVERGENCE_EPSILON) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

export function chiSquareCDF(x: number, degreesOfFreedom: number): number {
  if (x <= 0) return 0;
  return regularizedGammaP(degreesOfFreedom / 2, x / 2);
}

// Continued fraction for the regularized incomplete beta I_x(a,b)
// (Numerical Recipes §6.4).
function incompleteBetaCF(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < MIN_FLOAT) d = MIN_FLOAT;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < MIN_FLOAT) d = MIN_FLOAT;
    c = 1 + aa / c;
    if (Math.abs(c) < MIN_FLOAT) c = MIN_FLOAT;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < MIN_FLOAT) d = MIN_FLOAT;
    c = 1 + aa / c;
    if (Math.abs(c) < MIN_FLOAT) c = MIN_FLOAT;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < CONVERGENCE_EPSILON) break;
  }
  return h;
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logFront = -(logGamma(a) + logGamma(b) - logGamma(a + b)) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(logFront);
  // The continued fraction converges fastest on one side of this midpoint;
  // past it, use the symmetry I_x(a,b) = 1 - I_{1-x}(b,a) instead.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * incompleteBetaCF(a, b, x)) / a;
  }
  return 1 - (front * incompleteBetaCF(b, a, 1 - x)) / b;
}

// Two-tailed p-value helper shared by every test below -- all of them are
// symmetric-statistic tests (t, and z for the rank-based test).
function twoTailedFromCDF(cdfAtAbs: number): number {
  return Math.max(0, Math.min(1, 2 * (1 - cdfAtAbs)));
}

export function studentTCDF(t: number, degreesOfFreedom: number): number {
  const x = degreesOfFreedom / (degreesOfFreedom + t * t);
  const half = 0.5 * regularizedIncompleteBeta(x, degreesOfFreedom / 2, 0.5);
  return t >= 0 ? 1 - half : half;
}

export function fCDF(x: number, df1: number, df2: number): number {
  if (x <= 0) return 0;
  return regularizedIncompleteBeta((df1 * x) / (df1 * x + df2), df1 / 2, df2 / 2);
}

// --- descriptive helpers ------------------------------------------------------

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Sample variance (n-1 denominator) -- every test here draws inference about
// a population from a sample, so the unbiased estimator is the correct one,
// not the population variance (n denominator).
function sampleVariance(values: number[]): number {
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

// --- hypothesis tests ---------------------------------------------------------

export interface TTestResult {
  test: "welch-t";
  t: number;
  degreesOfFreedom: number;
  p: number;
  n1: number;
  n2: number;
  mean1: number;
  mean2: number;
  // Cohen's d on the pooled SD -- the conventional scale (~0.2 small, ~0.5
  // medium, ~0.8 large) despite Welch's test itself not assuming equal
  // variances; reporting effect size on a standard, comparable scale matters
  // more here than perfect internal consistency with the pooling assumption.
  cohensD: number;
}

// Welch's t-test: two independent samples, does NOT assume equal variances
// (unlike Student's t-test) -- the safer default when nothing already
// established the two groups have similar spread, which is the normal case
// here (e.g. comparing systolic BP between smokers and non-smokers).
export function welchTTest(sampleA: number[], sampleB: number[]): TTestResult | null {
  const n1 = sampleA.length;
  const n2 = sampleB.length;
  if (n1 < 2 || n2 < 2) return null;

  const mean1 = mean(sampleA);
  const mean2 = mean(sampleB);
  const v1 = sampleVariance(sampleA);
  const v2 = sampleVariance(sampleB);
  const se1 = v1 / n1;
  const se2 = v2 / n2;
  const se = Math.sqrt(se1 + se2);
  if (se === 0) return null;

  const t = (mean1 - mean2) / se;
  // Welch-Satterthwaite equation for approximate degrees of freedom.
  const degreesOfFreedom = (se1 + se2) ** 2 / (se1 ** 2 / (n1 - 1) + se2 ** 2 / (n2 - 1));
  const p = twoTailedFromCDF(studentTCDF(Math.abs(t), degreesOfFreedom));
  const pooledSD = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  const cohensD = pooledSD === 0 ? 0 : (mean1 - mean2) / pooledSD;

  return { test: "welch-t", t, degreesOfFreedom, p, n1, n2, mean1, mean2, cohensD };
}

export interface AnovaResult {
  test: "anova";
  f: number;
  dfBetween: number;
  dfWithin: number;
  p: number;
  // Eta-squared: share of total variance explained by group membership.
  etaSquared: number;
  groupCount: number;
  n: number;
}

// One-way ANOVA: is a numeric field's mean different across 3+ groups (e.g.
// systolic BP across age brackets)? For exactly 2 groups this is equivalent
// to Welch's t-test's Student's-t counterpart, but Welch's test is preferred
// there since it doesn't assume equal variances.
export function oneWayAnova(groups: number[][]): AnovaResult | null {
  const usable = groups.filter((group) => group.length >= 2);
  if (usable.length < 2) return null;

  const allValues = usable.flat();
  const n = allValues.length;
  const k = usable.length;
  const grandMean = mean(allValues);

  let ssBetween = 0;
  let ssWithin = 0;
  for (const group of usable) {
    const groupMean = mean(group);
    ssBetween += group.length * (groupMean - grandMean) ** 2;
    for (const value of group) ssWithin += (value - groupMean) ** 2;
  }

  const dfBetween = k - 1;
  const dfWithin = n - k;
  if (dfWithin <= 0 || ssWithin === 0) return null;
  const msBetween = ssBetween / dfBetween;
  const msWithin = ssWithin / dfWithin;
  const f = msBetween / msWithin;
  const p = Math.max(0, Math.min(1, 1 - fCDF(f, dfBetween, dfWithin)));
  const etaSquared = ssBetween / (ssBetween + ssWithin);

  return { test: "anova", f, dfBetween, dfWithin, p, etaSquared, groupCount: k, n };
}

export interface ChiSquareResult {
  test: "chi-square";
  chiSquare: number;
  degreesOfFreedom: number;
  p: number;
  cramersV: number;
  n: number;
  // The chi-square approximation is unreliable when expected cell counts are
  // too small (conventional rule of thumb: below 5) -- surfaced so the UI can
  // warn instead of silently reporting an unreliable p-value.
  minExpectedCount: number;
}

// Chi-square test of independence: are two categorical fields associated
// (e.g. smoking status and care department)? `table` is a contingency table,
// rows x columns, of observed counts.
export function chiSquareTest(table: number[][]): ChiSquareResult | null {
  const rows = table.length;
  const cols = table[0]?.length ?? 0;
  if (rows < 2 || cols < 2) return null;

  const rowTotals = table.map((row) => row.reduce((sum, count) => sum + count, 0));
  const colTotals = Array.from({ length: cols }, (_, c) =>
    table.reduce((sum, row) => sum + row[c], 0),
  );
  const total = rowTotals.reduce((sum, count) => sum + count, 0);
  if (total === 0) return null;

  let chiSquare = 0;
  let minExpectedCount = Infinity;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const expected = (rowTotals[r] * colTotals[c]) / total;
      minExpectedCount = Math.min(minExpectedCount, expected);
      if (expected > 0) chiSquare += (table[r][c] - expected) ** 2 / expected;
    }
  }

  const degreesOfFreedom = (rows - 1) * (cols - 1);
  const p = Math.max(0, Math.min(1, 1 - chiSquareCDF(chiSquare, degreesOfFreedom)));
  const cramersV = Math.sqrt(chiSquare / (total * (Math.min(rows, cols) - 1)));

  return { test: "chi-square", chiSquare, degreesOfFreedom, p, cramersV, n: total, minExpectedCount };
}

export interface MannWhitneyResult {
  test: "mann-whitney";
  u: number;
  z: number;
  p: number;
  n1: number;
  n2: number;
  // Rank-biserial correlation: -1..1, sign shows which group ranks higher.
  rankBiserial: number;
}

// Mann-Whitney U: like Welch's t-test but rank-based rather than mean-based,
// for a numeric field that isn't approximately normal within each group (a
// heavily skewed count like medication count, for instance). Uses the normal
// approximation with a tie correction, which is standard and accurate once
// each group has a reasonable sample size (tens of observations or more --
// comfortably true for anything analyzed here given the dataset sizes).
export function mannWhitneyU(sampleA: number[], sampleB: number[]): MannWhitneyResult | null {
  const n1 = sampleA.length;
  const n2 = sampleB.length;
  if (n1 < 1 || n2 < 1) return null;

  const combined = [
    ...sampleA.map((value) => ({ value, group: 0 })),
    ...sampleB.map((value) => ({ value, group: 1 })),
  ].sort((a, b) => a.value - b.value);

  const ranks = new Array<number>(combined.length);
  const tieGroupSizes: number[] = [];
  let i = 0;
  while (i < combined.length) {
    let j = i;
    while (j + 1 < combined.length && combined[j + 1].value === combined[i].value) j += 1;
    // Tied observations share the average of the ranks they'd occupy.
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = averageRank;
    tieGroupSizes.push(j - i + 1);
    i = j + 1;
  }

  let rankSumA = 0;
  for (let k = 0; k < combined.length; k += 1) {
    if (combined[k].group === 0) rankSumA += ranks[k];
  }
  const u1 = rankSumA - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  const n = n1 + n2;
  const tieSum = tieGroupSizes.reduce((sum, size) => sum + (size ** 3 - size), 0);
  const varianceU = (n1 * n2 * (n + 1 - tieSum / (n * (n - 1)))) / 12;
  const sigmaU = Math.sqrt(Math.max(0, varianceU));
  const meanU = (n1 * n2) / 2;
  const z = sigmaU > 0 ? (u1 - meanU) / sigmaU : 0;
  const p = twoTailedFromCDF(normalCDF(Math.abs(z)));
  const rankBiserial = 1 - (2 * u) / (n1 * n2);

  return { test: "mann-whitney", u, z, p, n1, n2, rankBiserial };
}

export interface CorrelationTestResult {
  test: "pearson";
  r: number;
  n: number;
  degreesOfFreedom: number;
  p: number;
  // 95% confidence interval via the Fisher z-transform.
  ciLow: number;
  ciHigh: number;
}

// Pearson correlation with a significance test and confidence interval --
// pearson() in lib/analytics.ts returns just the coefficient for the scatter
// chart and heatmap; this adds the inferential layer for Phase 3.
export function pearsonTest(pairs: [number, number][]): CorrelationTestResult | null {
  const n = pairs.length;
  if (n < 4) return null;

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX === 0 || varianceY === 0) return null;
  const r = covariance / Math.sqrt(varianceX * varianceY);

  const degreesOfFreedom = n - 2;
  // r = ±1 makes both the t-statistic and the Fisher z-transform diverge --
  // clamp just short of the boundary rather than returning Infinity/NaN.
  const clampedR = Math.max(-0.9999999, Math.min(0.9999999, r));
  const t = clampedR * Math.sqrt(degreesOfFreedom / (1 - clampedR * clampedR));
  const p = twoTailedFromCDF(studentTCDF(Math.abs(t), degreesOfFreedom));

  const z = Math.atanh(clampedR);
  const standardError = 1 / Math.sqrt(n - 3);
  const ciLow = Math.tanh(z - 1.959964 * standardError);
  const ciHigh = Math.tanh(z + 1.959964 * standardError);

  return { test: "pearson", r, n, degreesOfFreedom, p, ciLow, ciHigh };
}

// --- multiple-comparison correction -------------------------------------------

export interface AdjustedPValue {
  index: number;
  p: number;
  adjustedP: number;
  significant: boolean;
}

// Benjamini-Hochberg false discovery rate correction: running dozens of tests
// across every field pair means some will look "significant" at p<0.05 by
// chance alone (about 1 in 20, by construction) -- this controls the
// expected proportion of false positives among everything flagged as
// significant, rather than treating each test's p-value in isolation.
// Standard step-up procedure: sort ascending, find the largest p(i) with
// p(i) <= (i/m)*alpha, reject that one and everything smaller.
export function benjaminiHochberg(pValues: number[], alpha = 0.05): AdjustedPValue[] {
  const m = pValues.length;
  if (m === 0) return [];

  const sorted = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjustedSorted = new Array<number>(m);
  // Adjusted p-values are computed from the largest rank down, each capped by
  // the next-larger rank's value -- this is what keeps the adjusted sequence
  // monotonic (required; the raw p(i)*m/i formula alone isn't guaranteed to
  // be monotonic on its own).
  let runningMin = 1;
  for (let i = m - 1; i >= 0; i -= 1) {
    const rank = i + 1;
    const raw = (sorted[i].p * m) / rank;
    runningMin = Math.min(runningMin, raw);
    adjustedSorted[i] = Math.min(1, runningMin);
  }

  const results = new Array<AdjustedPValue>(m);
  for (let i = 0; i < m; i += 1) {
    results[sorted[i].index] = {
      index: sorted[i].index,
      p: sorted[i].p,
      adjustedP: adjustedSorted[i],
      significant: adjustedSorted[i] <= alpha,
    };
  }
  return results;
}
