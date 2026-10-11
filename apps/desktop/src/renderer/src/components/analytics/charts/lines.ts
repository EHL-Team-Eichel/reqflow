/**
 * Pure helpers behind LineChart: scales, path building, nearest-point lookup and label placement.
 * No React and no DOM, so they run and are unit-tested in plain Node.
 */

/** A point in the chart's own pixels. */
export interface Pt {
  x: number;
  y: number;
}

/** Two decimals keep path strings short. */
function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * Linear map from `domain` to `range`: linearScale([0, 10], [200, 0])(5) === 100. A degenerate
 * domain maps everything to the middle of the range.
 */
export function linearScale(
  domain: [number, number],
  range: [number, number],
): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (!Number.isFinite(span) || span === 0) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** SVG path (M/L) through the points. A null entry lifts the pen, so a gap breaks the line. */
export function linePath(points: (Pt | null)[]): string {
  let d = "";
  let drawing = false;
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      drawing = false;
      continue;
    }
    d += `${drawing ? "L" : "M"}${num(p.x)} ${num(p.y)}`;
    drawing = true;
  }
  return d;
}

/** Closed fill under each run of consecutive points, down to `baseY`. Gaps split the area. */
export function areaPath(points: (Pt | null)[], baseY: number): string {
  let d = "";
  let run: Pt[] = [];
  const close = () => {
    if (run.length >= 2) {
      d += `M${num(run[0]!.x)} ${num(baseY)}`;
      for (const p of run) d += `L${num(p.x)} ${num(p.y)}`;
      d += `L${num(run[run.length - 1]!.x)} ${num(baseY)}Z`;
    }
    run = [];
  };
  for (const p of points) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) close();
    else run.push(p);
  }
  close();
  return d;
}

/**
 * Index of the value in `xs` (ascending) closest to `x`; a tie goes to the earlier index. Returns
 * -1 when `xs` is empty or `x` is not a number.
 */
export function nearestIndex(xs: number[], x: number): number {
  if (xs.length === 0 || !Number.isFinite(x)) return -1;
  // first index whose value is >= x; the last index when x lies beyond the end
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return 0;
  const before = xs[lo - 1]!;
  const after = xs[lo]!;
  return x - before <= after - x ? lo - 1 : lo;
}

/**
 * Indexes of the labels to draw for `count` points spread evenly over `widthPx`, so that
 * neighbouring labels are at least `minGapPx` apart. The first and the last point are always
 * labelled; when the last one would crowd its neighbour, that neighbour is dropped.
 */
export function thinLabels(count: number, widthPx: number, minGapPx: number): number[] {
  if (count <= 0) return [];
  const last = count - 1;
  if (last === 0) return [0];
  const gap = Number.isFinite(minGapPx) ? Math.max(0, minGapPx) : 0;
  const slot = Number.isFinite(widthPx) && widthPx > 0 ? widthPx / last : 0;
  const step = slot > 0 ? Math.max(1, Math.ceil(gap / slot)) : count;
  const picked: number[] = [];
  for (let i = 0; i < last; i += step) picked.push(i);
  if (picked.length > 1 && last - picked[picked.length - 1]! < step) picked.pop();
  picked.push(last);
  return picked;
}

/**
 * Resolves label overlaps. Labels keep their vertical order and sit at least `minGap` apart,
 * moved only as far as needed and kept inside [min, max] when that is possible; when they cannot
 * fit, they are stacked from `min` on. `ys` may come in any order: the result matches its order.
 */
export function nudgeLabels(ys: number[], minGap: number, min: number, max: number): number[] {
  const n = ys.length;
  if (n === 0) return [];
  const gap = Math.max(0, minGap);
  const wanted = ys.map((y) => (Number.isFinite(y) ? y : min));
  const order = wanted.map((_, i) => i).sort((a, b) => wanted[a]! - wanted[b]! || a - b);
  const pos = order.map((i) => wanted[i]!);
  // push each label below its predecessor
  pos[0] = Math.max(min, pos[0]!);
  for (let k = 1; k < n; k++) pos[k] = Math.max(pos[k]!, pos[k - 1]! + gap);
  // the stack ends too low: pull it up from the bottom
  if (pos[n - 1]! > max) {
    pos[n - 1] = max;
    for (let k = n - 2; k >= 0; k--) pos[k] = Math.min(pos[k]!, pos[k + 1]! - gap);
  }
  // still above the top edge: it cannot fit, so stack from the top edge
  if (pos[0]! < min) {
    for (let k = 0; k < n; k++) pos[k] = min + k * gap;
  }
  const out = new Array<number>(n).fill(0);
  order.forEach((i, k) => {
    out[i] = pos[k]!;
  });
  return out;
}
