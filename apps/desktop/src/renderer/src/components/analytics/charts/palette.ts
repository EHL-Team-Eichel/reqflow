import type { Sentiment } from "../engine/types";

/**
 * BMW M chart colours, read from the CSS tokens in globals.css (light and dark are both defined
 * there, so charts follow the theme without code). Categorical slots are assigned in fixed order
 * and follow the entity (input, country, …), never its rank. More than eight series fold into
 * "Other".
 */
export const SERIES_SLOTS = 8;

export function seriesColor(slot: number): string {
  if (slot < 0 || slot >= SERIES_SLOTS) return "var(--color-viz-other)";
  return `var(--color-viz-${slot + 1})`;
}

export const OTHER_COLOR = "var(--color-viz-other)";

export const SENTIMENT_COLOR: Record<Sentiment, string> = {
  positive: "var(--color-viz-positive)",
  neutral: "var(--color-viz-neutral)",
  negative: "var(--color-viz-negative)",
};

export const SENTIMENT_LABEL: Record<Sentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
};

const SEQUENTIAL_STEPS = 7;

/** One M-blue hue, light → dark (dark → light in dark mode). `t` in 0–1; 0 = near zero. */
export function sequentialColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const step = Math.round(clamped * (SEQUENTIAL_STEPS - 1));
  return `var(--color-viz-seq-${step})`;
}

/** Text drawn on a sequential cell: the token flips with the ramp in dark mode. */
export function sequentialInk(t: number): string {
  return t > 0.55 ? "var(--color-viz-seq-ink-high)" : "var(--color-ink)";
}
