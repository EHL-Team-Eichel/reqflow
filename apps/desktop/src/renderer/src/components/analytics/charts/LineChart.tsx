import { useMemo, useState, type ReactElement } from "react";
import { cx } from "@/lib/cx";
import type { Series } from "../engine/types";
import { formatCompact, formatNumber, niceTicks, truncate } from "./format";
import { seriesColor } from "./palette";
import { ChartTooltip, Legend, TooltipRow, type HoverState } from "./Tooltip";
import { useWidth } from "./useWidth";
import {
  areaPath,
  linearScale,
  linePath,
  nearestIndex,
  nudgeLabels,
  thinLabels,
  type Pt,
} from "./lines";

const PLOT_TOP = 12;
const PLOT_BOTTOM_GUTTER = 26; // bucket labels sit below the plot
const MARKER_LIMIT = 24; // more buckets than this: markers only at the hovered bucket
const END_LABEL_SERIES = 4; // direct end labels for up to this many series
const END_LABEL_CHARS = 18;
const CHAR_PX = 6.5; // generous advance of 11px text, for layout only

const textWidth = (s: string) => s.length * CHAR_PX;

function widest(texts: string[]): number {
  let w = 0;
  for (const t of texts) w = Math.max(w, textWidth(t));
  return w;
}

/** Half a pixel, so 1px lines are drawn crisp. */
const crisp = (v: number) => Math.round(v) + 0.5;

/** The union of all series' buckets (ascending), and each series' value per bucket (null = none). */
function alignSeries(series: Series[]): {
  buckets: { t: number; label: string }[];
  values: (number | null)[][];
} {
  const labels = new Map<number, string>();
  for (const s of series) for (const p of s.points) if (!labels.has(p.t)) labels.set(p.t, p.label);
  const buckets = [...labels.keys()]
    .sort((a, b) => a - b)
    .map((t) => ({ t, label: labels.get(t) ?? "" }));
  const values = series.map((s) => {
    const byT = new Map(s.points.map((p) => [p.t, p.value] as const));
    return buckets.map((b) => {
      const v = byT.get(b.t);
      return v !== undefined && Number.isFinite(v) ? v : null;
    });
  });
  return { buckets, values };
}

/**
 * Line chart over shared time buckets. The crosshair and one tooltip show every series at the
 * hovered bucket; up to four series get direct end labels, two or more get a legend. The plot is
 * focusable: the arrow keys move the crosshair, Enter selects the bucket.
 */
export function LineChart({
  series,
  height = 240,
  valueFormat = formatNumber,
  axisFormat = formatCompact,
  area = false,
  dashedFrom,
  yMax,
  ariaLabel,
  onSelectBucket,
}: {
  series: Series[];
  height?: number;
  valueFormat?: (v: number) => string;
  axisFormat?: (v: number) => string;
  area?: boolean;
  dashedFrom?: number;
  yMax?: number;
  ariaLabel: string;
  onSelectBucket?: (t: number) => void;
}): ReactElement | null {
  const [ref, width] = useWidth();
  const [cursor, setCursor] = useState<number | null>(null);
  const { buckets, values } = useMemo(() => alignSeries(series), [series]);
  if (series.length === 0 || buckets.length === 0) return null;

  const n = buckets.length;
  const active = cursor !== null && cursor >= 0 && cursor < n ? cursor : null;
  const colors = series.map((s) => seriesColor(s.colorIndex));

  // Y axis: from zero up to the given maximum, else the nice maximum of the data.
  let dataMax = 0;
  for (const line of values) for (const v of line) if (v !== null && v > dataMax) dataMax = v;
  const rawTicks = niceTicks(0, yMax ?? dataMax);
  const top = yMax !== undefined && yMax > 0 ? yMax : (rawTicks.at(-1) ?? 1);
  const ticks = rawTicks.filter((t) => t <= top + 1e-9);

  // Gutters: y labels on the left, direct end labels on the right.
  const showEnds = series.length <= END_LABEL_SERIES && n > 1;
  const fullLabels = series.map((s) => s.label);
  const endTexts = fullLabels.map((label) => truncate(label, END_LABEL_CHARS));
  const gutterLeft = Math.max(28, Math.ceil(widest(ticks.map((t) => axisFormat(t)))) + 14);
  const gutterRight = showEnds ? 8 + widest(endTexts) + 6 : 16;
  const plotL = gutterLeft;
  const plotR = Math.max(plotL + 40, width - gutterRight);
  const plotT = PLOT_TOP;
  const plotB = Math.max(plotT + 40, height - PLOT_BOTTOM_GUTTER);

  const x = linearScale([0, n - 1], [plotL, plotR]);
  const y = linearScale([0, top], [plotB, plotT]);
  const xs = buckets.map((_, i) => x(i));
  const pts: (Pt | null)[][] = values.map((line) =>
    line.map((v, i) =>
      v === null ? null : { x: xs[i] ?? plotL, y: y(Math.min(Math.max(v, 0), top)) },
    ),
  );

  // Planned values: from the first bucket at or after dashedFrom the line is dashed.
  let firstDashed = n;
  if (dashedFrom !== undefined) {
    const at = buckets.findIndex((b) => b.t >= dashedFrom);
    if (at !== -1) firstDashed = at;
  }

  const lastIndex = values.map((line) => {
    for (let i = line.length - 1; i >= 0; i--) if (line[i] !== null) return i;
    return -1;
  });
  const allMarkers = n <= MARKER_LIMIT;
  const labelIndexes = thinLabels(n, plotR - plotL, widest(buckets.map((b) => b.label)) + 14);

  // Direct end labels: each series' last point, nudged apart so the labels never overlap.
  const ends = series.flatMap((s, si) => {
    const i = lastIndex[si] ?? -1;
    const p = i >= 0 ? (pts[si]?.[i] ?? null) : null;
    if (!p) return [];
    return [
      {
        key: s.key,
        full: fullLabels[si] ?? "",
        label: endTexts[si] ?? "",
        color: colors[si] ?? "",
        px: p.x,
        py: p.y,
      },
    ];
  });
  const endY = showEnds
    ? nudgeLabels(
        ends.map((e) => e.py),
        14,
        plotT,
        plotB,
      )
    : [];

  const hover: HoverState | null =
    active === null
      ? null
      : {
          x: xs[active] ?? plotL,
          y: plotT + 4,
          content: (
            <>
              <div className="mb-1 font-medium text-ink">{buckets[active]?.label}</div>
              {series.map((s, si) => {
                const v = values[si]?.[active] ?? null;
                return (
                  <TooltipRow
                    key={s.key}
                    color={colors[si]}
                    label={s.label}
                    value={v === null ? "–" : valueFormat(v)}
                  />
                );
              })}
            </>
          ),
        };

  const dashNote =
    firstDashed < n ? `Dashed: planned, from ${buckets[firstDashed]?.label ?? ""}` : null;
  const legendItems = series.map((s, si) => ({
    key: s.key,
    label: s.label,
    color: colors[si] ?? "",
  }));

  return (
    <div ref={ref} className="min-w-0">
      {(series.length > 1 || dashNote) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <Legend items={legendItems} />
          {dashNote && <span className="text-xs text-muted">{dashNote}</span>}
        </div>
      )}
      <div className="relative">
        <svg
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className={cx(
            "block rounded-sm focus-visible:outline-2 focus-visible:outline-brand",
            onSelectBucket && "cursor-pointer",
          )}
          onPointerMove={(e) =>
            setCursor(nearestIndex(xs, e.clientX - e.currentTarget.getBoundingClientRect().left))
          }
          onPointerLeave={() => setCursor(null)}
          onFocus={() => setCursor((c) => c ?? n - 1)}
          onBlur={() => setCursor(null)}
          onClick={(e) => {
            if (!onSelectBucket) return;
            const i = nearestIndex(xs, e.clientX - e.currentTarget.getBoundingClientRect().left);
            const bucket = buckets[i];
            if (bucket) onSelectBucket(bucket.t);
          }}
          onKeyDown={(e) => {
            const current = active ?? n - 1;
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
              e.preventDefault();
              if (e.key === "ArrowLeft") setCursor(Math.max(0, current - 1));
              else if (e.key === "ArrowRight") setCursor(Math.min(n - 1, current + 1));
              else setCursor(e.key === "Home" ? 0 : n - 1);
            } else if ((e.key === "Enter" || e.key === " ") && onSelectBucket) {
              e.preventDefault();
              const bucket = buckets[current];
              if (bucket) onSelectBucket(bucket.t);
            }
          }}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={plotL}
                x2={plotR}
                y1={crisp(y(t))}
                y2={crisp(y(t))}
                strokeWidth={1}
                style={{ stroke: "var(--color-line)" }}
              />
              <text
                x={plotL - 8}
                y={y(t)}
                textAnchor="end"
                dominantBaseline="central"
                fontSize={11}
                className="tabular-nums"
                style={{ fill: "var(--color-muted)" }}
              >
                {axisFormat(t)}
              </text>
            </g>
          ))}

          {area && series.length === 1 && n > 1 && (
            <path
              d={areaPath(pts[0] ?? [], plotB)}
              fillOpacity={0.12}
              style={{ fill: colors[0] }}
            />
          )}

          {n > 1 &&
            series.map((s, si) => {
              const line = pts[si] ?? [];
              return (
                <g key={s.key}>
                  <path
                    d={linePath(line.slice(0, firstDashed))}
                    fill="none"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ stroke: colors[si] }}
                  />
                  {firstDashed < n && (
                    <path
                      d={linePath(line.slice(Math.max(0, firstDashed - 1)))}
                      fill="none"
                      strokeWidth={2}
                      strokeDasharray="5 4"
                      strokeLinejoin="round"
                      style={{ stroke: colors[si] }}
                    />
                  )}
                </g>
              );
            })}

          {active !== null && (
            <line
              x1={crisp(xs[active] ?? plotL)}
              x2={crisp(xs[active] ?? plotL)}
              y1={plotT}
              y2={plotB}
              strokeWidth={1}
              style={{ stroke: "var(--color-line-strong)" }}
            />
          )}

          {series.map((s, si) => (
            <g key={s.key}>
              {(pts[si] ?? []).map((p, i) => {
                const shown = allMarkers || i === active || (showEnds && i === lastIndex[si]);
                if (!p || !shown) return null;
                return (
                  <circle
                    key={i}
                    cx={p.x}
                    cy={p.y}
                    r={4}
                    strokeWidth={2}
                    style={{ fill: colors[si], stroke: "var(--color-panel)" }}
                  />
                );
              })}
            </g>
          ))}

          {labelIndexes.map((i) => {
            const label = buckets[i]?.label ?? "";
            const half = textWidth(label) / 2;
            const cx = Math.min(Math.max(xs[i] ?? plotL, half + 2), width - half - 2);
            return (
              <text
                key={i}
                x={cx}
                y={height - 8}
                textAnchor="middle"
                fontSize={11}
                style={{ fill: "var(--color-muted)" }}
              >
                {label}
              </text>
            );
          })}

          {showEnds &&
            ends.map((e, k) => {
              const labelY = endY[k] ?? e.py;
              const labelX = plotR + 8;
              return (
                <g key={e.key}>
                  {Math.abs(labelY - e.py) > 3 && (
                    <line
                      x1={e.px + 5}
                      y1={e.py}
                      x2={labelX - 3}
                      y2={labelY}
                      strokeWidth={1}
                      style={{ stroke: e.color }}
                    />
                  )}
                  <text
                    x={labelX}
                    y={labelY + 4}
                    fontSize={11}
                    style={{ fill: "var(--color-muted)" }}
                  >
                    <title>{e.full}</title>
                    {e.label}
                  </text>
                </g>
              );
            })}
        </svg>
        <ChartTooltip hover={hover} width={width} />
      </div>
    </div>
  );
}
