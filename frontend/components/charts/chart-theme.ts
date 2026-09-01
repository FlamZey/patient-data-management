// Palette + scale helpers shared by every chart in this folder.
//
// The app is committed to one dark theme, the "Nocturne" ink-indigo + blurple
// system (see globals.css: --background #161826, --surface #232532, --accent
// #9184d9, --danger #c1543f). These are that exact palette, stepped for data
// marks instead of hand-picked hues -- a chart here should read as part of
// this app, not a generic rainbow dashboard. Every palette below was checked
// with the dataviz skill's validator against the real card surface
// (#232532), not eyeballed:
//
//   categorical (2): lightness band, chroma floor, CVD separation (23.7
//                    deutan), normal-vision separation (23.4), and >=3:1
//                    contrast -- all pass with no WARNs.
//   sequential (5):  monotone lightness, single hue (the site's own accent),
//                    near-surface step still clears 2.06:1 -- all pass.
//
// Only two fixed hues, not a rotating multi-series palette: the design this
// dashboard is built from draws every multi-category figure as tint/shade
// steps of ONE hue plus a neutral tail, never a rainbow of distinct hues --
// see RANK_RAMP below, which is what ShareBars' rows actually use.
// CATEGORICAL's two slots exist only for a chart that needs a second,
// clearly-different role alongside a primary series in the SAME hue family
// (LineChart's monthly line vs. its rolling-average overlay).
export const CATEGORICAL = [
  "#9184d9", // the app's actual --accent, used as-is -- the primary series
  "#c28833", // gold -- the secondary role (the rolling average)
] as const;

// A miscellaneous/"Other" row, or anything past RANK_RAMP's steps, is never
// assigned another hue -- it isn't a real identity a reader needs to track,
// so it recedes as the app's own muted ink instead (matching how the design
// mockup this dashboard is built from renders every "Other" bar in a flat
// neutral gray, never another accent tint).
export const NEUTRAL = "#9397ab"; // the app's --muted, reused verbatim

// Magnitude ramp, low -> high, in the app's own accent hue. Used wherever a
// chart is about "how many" rather than "which one" -- most of this
// dashboard, in other words.
export const SEQUENTIAL = ["#574f82", "#7369ab", "#8f82d5", "#ab9cfc", "#cbbfff"] as const;

// Rank ramp for a sorted part-to-whole breakdown (ShareBars' rows, biggest
// first): the same single hue as SEQUENTIAL, brightest for the largest row
// and stepping darker for the next two -- the exact pattern the design
// mockup uses (its top categories are drawn as --color-accent, then
// -accent-600, then -accent-700). Only the top three ranks get a step; every
// row past that -- the long tail a reader isn't meant to individually
// track -- falls back to NEUTRAL. A four-or-more-hue breakdown is what the
// "still too many colors" feedback was about; this caps it at one hue.
export const RANK_RAMP = [CATEGORICAL[0], SEQUENTIAL[1], SEQUENTIAL[0]] as const;

// Correlation runs -1..+1, so it needs a diverging scale with a neutral
// middle: --danger (negative) and --accent (positive) are the app's own
// warm/cool opposition, and the midpoint is a desaturated step of the same
// cool-gray family as --border so "no correlation" reads as nothing rather
// than as a weak color.
export const DIVERGING_NEGATIVE = ["#934c3d", "#c1543f"] as const;
export const DIVERGING_NEUTRAL = "#3b3d44";
export const DIVERGING_POSITIVE = ["#625a93", "#9184d9"] as const;

// Recessive chrome -- these intentionally read as background, not data.
// Sourced from the app's own --border (axis) and a darker step of the same
// cool-gray family (grid), and the real --surface for the gap stroke between
// adjacent fills, so a chart's chrome disappears into its card exactly the
// way the card itself does.
export const AXIS_COLOR = "#3f424d";
export const GRID_COLOR = "#2b2d37";
export const SURFACE_COLOR = "#232532";

// Maps a 0-based rank (0 = largest slice) onto RANK_RAMP, falling back to
// NEUTRAL past its length -- the long tail of a sorted breakdown recedes
// into the app's muted ink instead of generating a new hue.
export function rankColor(index: number): string {
  return index < RANK_RAMP.length ? RANK_RAMP[index] : NEUTRAL;
}

// Same as rankColor, but a slice literally labeled "Other" (a real recorded
// value, or a countBy folded-tail bucket -- both share this exact label)
// always recedes to neutral regardless of its rank, since it isn't an
// identity a reader needs to track.
export function rankOrNeutralColor(label: string, index: number): string {
  return label === "Other" ? NEUTRAL : rankColor(index);
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

export function formatNumber(value: number, maximumFractionDigits = 1): string {
  return value.toLocaleString(undefined, { maximumFractionDigits });
}

export function formatPercent(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${((100 * part) / whole).toFixed(1)}%`;
}
