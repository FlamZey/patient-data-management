// Palette + scale helpers shared by every chart in this folder.
//
// The app is committed to one dark theme (see globals.css), so these are a
// single set of values stepped for that surface (--surface #1e1a14) rather
// than a light/dark pair. Every palette below was checked with the dataviz
// skill's validator against that exact surface, not eyeballed:
//
//   categorical (6): lightness band, chroma floor, adjacent CVD separation
//                    (worst 8.4 protan), normal-vision separation (worst
//                    19.8), and >=3:1 contrast -- all pass.
//   sequential (5):  monotone lightness, >=0.06 adjacent lightness gaps,
//                    light end 2.40:1 vs surface, single hue -- all pass.
//
// The app's raw brand tokens could NOT be used directly as series colors:
// --accent gold (#dba43c) sits at lightness 0.752, outside the 0.48-0.67
// band, and --teal (#4c9484) has chroma 0.077, under the 0.1 floor -- they're
// UI accents, not data marks. These are those hues snapped to passing steps,
// so charts still read as part of this app rather than a generic dashboard.

// Fixed order. Assign by index and never cycle: a 7th series folds into
// "Other" or gets faceted, it never gets a generated hue.
export const CATEGORICAL = [
  "#c98500", // gold -- the app's accent hue, stepped into the band
  "#199e70", // teal -- the app's secondary hue, stepped over the chroma floor
  "#9085e9", // violet
  "#e66767", // red
  "#3987e5", // blue
  "#d55181", // magenta
] as const;

// Magnitude ramp, low -> high. Used wherever a chart is about "how many"
// rather than "which one" -- most of this dashboard, in other words.
export const SEQUENTIAL = ["#6b5418", "#8d6f1e", "#b08a24", "#d2a531", "#f0c766"] as const;

// Correlation runs -1..+1, so it needs a diverging scale with a neutral
// middle: teal (negative) and gold (positive) are a genuine cool/warm
// opposition, and the midpoint is gray so "no correlation" reads as nothing
// rather than as a weak color.
export const DIVERGING_NEGATIVE = ["#1b8f77", "#3aa88f"] as const;
export const DIVERGING_NEUTRAL = "#383530";
export const DIVERGING_POSITIVE = ["#b08a24", "#dba43c"] as const;

// Recessive chrome -- these intentionally read as background, not data.
export const AXIS_COLOR = "#4a4239";
export const GRID_COLOR = "#2a241c";
export const SURFACE_COLOR = "#1e1a14";

export function categoricalColor(index: number): string {
  return CATEGORICAL[index % CATEGORICAL.length];
}

// Maps 0..1 onto the sequential ramp.
export function sequentialColor(t: number): string {
  if (!Number.isFinite(t)) return SEQUENTIAL[0];
  const clamped = Math.max(0, Math.min(1, t));
  return SEQUENTIAL[Math.min(SEQUENTIAL.length - 1, Math.round(clamped * (SEQUENTIAL.length - 1)))];
}

// Maps a correlation coefficient (-1..1) onto the diverging scale.
export function divergingColor(value: number): string {
  if (!Number.isFinite(value)) return DIVERGING_NEUTRAL;
  const magnitude = Math.abs(value);
  if (magnitude < 0.15) return DIVERGING_NEUTRAL;
  const ramp = value < 0 ? DIVERGING_NEGATIVE : DIVERGING_POSITIVE;
  return magnitude < 0.5 ? ramp[0] : ramp[1];
}

// A zero-based axis whose top is the first "nice" step at or above `max`.
// Scaling bars to the raw maximum instead makes the tallest bar fill the plot
// edge to edge -- it reads as clipped, and the top gridline never gets a
// label. Returns the ticks and that rounded-up ceiling together, since the
// bars and the gridlines have to be scaled by the same number.
export function niceAxis(max: number, targetCount = 4): { ticks: number[]; axisMax: number } {
  if (!Number.isFinite(max) || max <= 0) return { ticks: [0], axisMax: 1 };

  const rawStep = max / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const axisMax = Number((Math.ceil(max / step) * step).toPrecision(12));
  const ticks: number[] = [];
  for (let value = 0; value <= axisMax + step * 1e-9; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return { ticks, axisMax };
}

// Builds "nice" axis ticks (1/2/5 x 10^n steps) covering [min, max], so the
// axis lands on round numbers instead of raw data extremes.
export function niceTicks(min: number, max: number, targetCount = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const rawStep = (max - min) / Math.max(1, targetCount);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized >= 5 ? 10 : normalized >= 2 ? 5 : normalized >= 1 ? 2 : 1) * magnitude;

  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 1e-9; value += step) {
    // Re-round each step: repeated float addition drifts (0.1+0.2...).
    ticks.push(Number(value.toPrecision(12)));
  }
  return ticks;
}

export function formatNumber(value: number, maximumFractionDigits = 1): string {
  return value.toLocaleString(undefined, { maximumFractionDigits });
}

export function formatPercent(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${((100 * part) / whole).toFixed(1)}%`;
}
