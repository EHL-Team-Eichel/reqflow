/**
 * Pure geometry and label helpers for the analytics charts. No React and no DOM access, so every
 * function here is unit-tested in bars.test.ts. Angles are radians: 0 is 12 o'clock and they run
 * clockwise, the way SVG arcs and donut slices are laid out.
 */

/** A full turn in radians. */
export const TAU = Math.PI * 2;

/** Key of the "Other" row that foldOther adds when it folds the tail of a ranking. */
export const OTHER_KEY = "__other__";

/** A rectangle in CSS pixels. A DOMRect satisfies it. */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point in CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

/** Stand-in for a container that has not been measured yet. */
export const NO_BOX: Box = { left: 0, top: 0, width: 0, height: 0 };

/** Average glyph width of the UI font as a fraction of its size. Deliberately generous. */
const GLYPH_EM = 0.6;

/** Rounds to three decimals so generated SVG path strings stay short and stable. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Finite numbers pass through; NaN, Infinity and missing values count as zero. */
export function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Enter and Space activate a focusable chart mark, the way a native button would. */
export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

/** value / max clamped to 0–1: how far a bar reaches on its scale. Zero when max is not positive. */
export function ratio(value: number, max: number): number {
  if (!Number.isFinite(value) || !(max > 0)) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** Geometry of an equal-band scale (see bandLayout). */
export interface BandLayout {
  /** Distance from the start of one band to the start of the next. */
  step: number;
  /** Width of one band; the rest of the step is the gap between bands. */
  bandwidth: number;
  /** Offset of the first band from the left edge: half of the padding. */
  start: number;
}

/**
 * Equal bands across `width`, like a d3 band scale. `padding` (0–0.9) is the share of each step
 * left empty between bands; half of that is left at each end. Band i starts at start + i × step.
 * bandLayout(3, 300, 0.2) → step 100, bandwidth 80, start 10.
 */
export function bandLayout(count: number, width: number, padding = 0.2): BandLayout {
  if (!(count > 0) || !(width > 0)) return { step: 0, bandwidth: 0, start: 0 };
  const p = Math.min(0.9, Math.max(0, padding));
  const step = width / count;
  return { step, bandwidth: step * (1 - p), start: (step * p) / 2 };
}

/** Where the bars of one group sit inside a band. */
export interface GroupLayout {
  barWidth: number;
  /** Offset of each bar from the band's left edge. The group is centred in the band. */
  offsets: number[];
}

/**
 * `count` bars side by side inside one band, `gap` apart and centred. Bars are capped at
 * `maxBarWidth` so they stay thin, and shrink to fit a narrow band.
 */
export function groupLayout(
  count: number,
  bandwidth: number,
  gap = 2,
  maxBarWidth = 24,
): GroupLayout {
  if (!(count > 0) || !(bandwidth > 0)) return { barWidth: 0, offsets: [] };
  const fit = (bandwidth - gap * (count - 1)) / count;
  const barWidth = Math.max(1, Math.min(maxBarWidth, fit));
  const groupWidth = barWidth * count + gap * (count - 1);
  const left = (bandwidth - groupWidth) / 2;
  const offsets = Array.from({ length: count }, (_, i) => left + i * (barWidth + gap));
  return { barWidth, offsets };
}

/**
 * SVG path of an annular sector: a donut slice from `startAngle` to `endAngle`. With `rInner` 0 it
 * is a pie slice. A full turn is drawn as two half-rings, because an arc whose start and end meet
 * draws nothing at all.
 */
export function arcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number,
): string {
  const end = Math.min(endAngle, startAngle + TAU);
  const span = end - startAngle;
  if (!(span > 0) || !(rOuter > 0)) return "";
  if (span >= TAU - 1e-9) {
    const mid = startAngle + Math.PI;
    const first = arcPath(cx, cy, rOuter, rInner, startAngle, mid);
    const second = arcPath(cx, cy, rOuter, rInner, mid, startAngle + TAU);
    return `${first} ${second}`;
  }
  const at = (r: number, angle: number) =>
    `${round(cx + r * Math.sin(angle))} ${round(cy - r * Math.cos(angle))}`;
  const large = span > Math.PI ? 1 : 0;
  if (!(rInner > 0)) {
    return `M ${round(cx)} ${round(cy)} L ${at(rOuter, startAngle)} A ${round(rOuter)} ${round(rOuter)} 0 ${large} 1 ${at(rOuter, end)} Z`;
  }
  const r = Math.min(rInner, rOuter);
  return `M ${at(rOuter, startAngle)} A ${round(rOuter)} ${round(rOuter)} 0 ${large} 1 ${at(rOuter, end)} L ${at(r, end)} A ${round(r)} ${round(r)} 0 ${large} 0 ${at(r, startAngle)} Z`;
}

/** The arc of one part of a split, in radians from 12 o'clock. */
export interface AngularSpan {
  /** Index of the value in the input array. */
  index: number;
  start: number;
  end: number;
}

/**
 * Clockwise spans from 12 o'clock for a part-to-whole split, in input order. Zero, negative and
 * non-numeric values get no span, and an input that sums to zero has no spans at all.
 */
export function angularSpans(values: readonly number[]): AngularSpan[] {
  const sizes = values.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = sizes.reduce((sum, v) => sum + v, 0);
  if (!(total > 0)) return [];
  const spans: AngularSpan[] = [];
  let acc = 0;
  sizes.forEach((v, index) => {
    if (v <= 0) return;
    const start = (acc / total) * TAU;
    acc += v;
    spans.push({ index, start, end: (acc / total) * TAU });
  });
  return spans;
}

/**
 * A vertical bar with its top corners rounded by `radius` and its baseline square, so only the data
 * end is rounded. Empty when the bar has no width or no height.
 */
export function topRoundedBarPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  if (!(width > 0) || !(height > 0)) return "";
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const right = x + width;
  const bottom = y + height;
  if (r === 0) {
    return `M ${round(x)} ${round(bottom)} L ${round(x)} ${round(y)} L ${round(right)} ${round(y)} L ${round(right)} ${round(bottom)} Z`;
  }
  return `M ${round(x)} ${round(bottom)} L ${round(x)} ${round(y + r)} A ${round(r)} ${round(r)} 0 0 1 ${round(x + r)} ${round(y)} L ${round(right - r)} ${round(y)} A ${round(r)} ${round(r)} 0 0 1 ${round(right)} ${round(y + r)} L ${round(right)} ${round(bottom)} Z`;
}

/** Estimated rendered width of `text` in px. SVG text cannot be measured here, so this is a bound. */
export function estimateTextWidth(text: string, fontPx: number): number {
  return text.length * fontPx * GLYPH_EM;
}

/** Shortens `text` with an ellipsis until its estimated width fits `widthPx`. */
export function fitLabel(text: string, widthPx: number, fontPx: number): string {
  const maxChars = Math.floor(widthPx / (fontPx * GLYPH_EM));
  if (text.length <= maxChars) return text;
  return maxChars <= 1 ? "…" : `${text.slice(0, maxChars - 1)}…`;
}

/** True when every label fits a slot of `slotPx`, keeping `paddingPx` clear, at `fontPx`. */
export function labelsFit(
  labels: readonly string[],
  slotPx: number,
  fontPx: number,
  paddingPx = 4,
): boolean {
  return labels.every((label) => estimateTextWidth(label, fontPx) <= slotPx - paddingPx);
}

/** Anything foldOther can rank: a key, a label, a value and optionally a share (0–1). */
export interface Foldable {
  key: string;
  label: string;
  value: number;
  share?: number;
}

/** The "Other (k)" row that foldOther adds for the tail of a ranking. */
export interface OtherRow {
  key: typeof OTHER_KEY;
  label: string;
  value: number;
  share?: number;
}

/**
 * Ranks by value, largest first (ties keep their input order), keeps the top `limit` and sums the
 * rest into one "Other (k)" row, where k is the number of folded items. The share is summed too
 * when every folded item has one. A list that already fits is returned ranked and unfolded.
 */
export function foldOther<T extends Foldable>(
  items: readonly T[],
  limit: number,
): (T | OtherRow)[] {
  const ranked = [...items].sort((a, b) => finiteOrZero(b.value) - finiteOrZero(a.value));
  const keep = Math.max(0, Math.floor(limit));
  if (ranked.length <= keep) return ranked;
  const rest = ranked.slice(keep);
  const sharesKnown = rest.every((r) => typeof r.share === "number" && Number.isFinite(r.share));
  const other: OtherRow = {
    key: OTHER_KEY,
    label: `Other (${rest.length})`,
    value: rest.reduce((sum, r) => sum + finiteOrZero(r.value), 0),
    ...(sharesKnown ? { share: rest.reduce((sum, r) => sum + finiteOrZero(r.share), 0) } : {}),
  };
  return [...ranked.slice(0, keep), other];
}

/**
 * Where a tooltip's anchor sits inside its container: under the pointer when there is one, else at
 * the centre of the element that got focus.
 */
export function hoverAnchor(container: Box, target: Box, pointer?: Point): Point {
  if (pointer) return { x: pointer.x - container.left, y: pointer.y - container.top };
  return {
    x: target.left - container.left + target.width / 2,
    y: target.top - container.top + target.height / 2,
  };
}
