/** Number formatting shared by every chart, tooltip and table of the analytics view. */

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** 1234 → "1,234"; 0.5 → "0.5"; 12.345 → "12.3". */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "–";
  return Math.abs(n) >= 100 || Number.isInteger(n) ? integer.format(n) : oneDecimal.format(n);
}

/** 12345 → "12.3k", 1_250_000 → "1.3M": for axis ticks, where space is short. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${oneDecimal.format(n / 1e6)}M`;
  if (abs >= 1e4) return `${oneDecimal.format(n / 1e3)}k`;
  return formatNumber(n);
}

/** Share 0–1 → "42%"; below 10 % one decimal ("4.2%"); exact zero "0%". */
export function formatPercent(share: number): string {
  if (!Number.isFinite(share)) return "–";
  const pct = share * 100;
  if (pct === 0) return "0%";
  if (Math.abs(pct) < 10) return `${oneDecimal.format(pct)}%`;
  return `${integer.format(pct)}%`;
}

/** Difference of two shares in percentage points: +3.4 pp, −12 pp. */
export function formatPoints(delta: number): string {
  if (!Number.isFinite(delta)) return "–";
  const pp = delta * 100;
  const sign = pp > 0 ? "+" : pp < 0 ? "−" : "±";
  const abs = Math.abs(pp);
  return `${sign}${abs < 10 ? oneDecimal.format(abs) : integer.format(abs)} pp`;
}

/**
 * Round axis ticks from 0 (or min) to at least max: steps of 1, 2 or 5 × 10^n.
 * niceTicks(0, 87) → [0, 20, 40, 60, 80, 100].
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max <= min) max = min + 1;
  const raw = (max - min) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v < max + step * 0.5 && ticks.length < 50; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  if (ticks[ticks.length - 1]! < max) ticks.push(Number((start + ticks.length * step).toFixed(10)));
  return ticks;
}

/** Shortens a label to `max` characters with an ellipsis; the full text goes in a tooltip. */
export function truncate(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, Math.max(1, max - 1))}…`;
}
