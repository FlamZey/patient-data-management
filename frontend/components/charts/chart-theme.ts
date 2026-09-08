// Palette + scale helpers for every chart here, stepped from the app's own
// dark "Nocturne" theme (see globals.css) rather than generic hues, and
// checked against the real card surface with the dataviz skill's validator.
export const CATEGORICAL = [
  "#9184d9", // the app's actual --accent, used as-is -- the primary series
  "#c28833", // gold -- the secondary role (the rolling average)
] as const;

// A misc/"Other" row, or anything past RANK_RAMP's steps, is never assigned
// another hue -- it isn't an identity worth tracking, so it recedes to the
// app's muted ink instead of a new accent tint.
export const NEUTRAL = "#9397ab"; // the app's --muted, reused verbatim

// Magnitude ramp, low -> high, in the app's own accent hue. Used wherever a
// chart is about "how many" rather than "which one" -- most of this
// dashboard, in other words.
export const SEQUENTIAL = ["#574f82", "#7369ab", "#8f82d5", "#ab9cfc", "#cbbfff"] as const;

// Rank ramp for a sorted part-to-whole breakdown (ShareBars, biggest first):
// one hue, brightest for rank 0, stepping darker for the next two. Only the
// top three ranks get a step; everything past that falls back to NEUTRAL.
export const RANK_RAMP = [CATEGORICAL[0], SEQUENTIAL[1], SEQUENTIAL[0]] as const;

// Correlation runs -1..+1: --danger (negative) and --accent (positive) are
// the app's own warm/cool opposition, with a desaturated cool-gray midpoint
// so "no correlation" reads as nothing rather than a weak color.
export const DIVERGING_NEGATIVE = ["#934c3d", "#c1543f"] as const;
export const DIVERGING_NEUTRAL = "#3b3d44";
export const DIVERGING_POSITIVE = ["#625a93", "#9184d9"] as const;

// Recessive chrome, sourced from the app's own --border/--surface tones, so
// a chart's chrome disappears into its card exactly the way the card does.
export const AXIS_COLOR = "#3f424d";
export const GRID_COLOR = "#2b2d37";
export const SURFACE_COLOR = "#232532";

// Maps a 0-based rank (0 = largest slice) onto RANK_RAMP, falling back to
// NEUTRAL past its length -- the long tail of a sorted breakdown recedes
// into the app's muted ink instead of generating a new hue.
export function rankColor(index: number): string {
  return index < RANK_RAMP.length ? RANK_RAMP[index] : NEUTRAL;
}

// Same as rankColor, but a slice literally labeled "Other" (a real value, or
// a countBy folded-tail bucket) always recedes to neutral regardless of rank.
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

// A zero-based axis whose top is the first "nice" step at or above `max` --
// scaling to the raw max instead clips the tallest bar against the plot edge
// with no room for a top label. Returns ticks and ceiling together.
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
