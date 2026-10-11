import { useState, type FocusEvent, type KeyboardEvent } from "react";
import {
  NO_BOX,
  bandLayout,
  estimateTextWidth,
  fitLabel,
  finiteOrZero,
  groupLayout,
  hoverAnchor,
  isActivationKey,
  labelsFit,
  topRoundedBarPath,
} from "./bars";
import { formatCompact, formatNumber, niceTicks } from "./format";
import { ChartTooltip, Legend, TooltipRow, type HoverState } from "./Tooltip";
import { useWidth } from "./useWidth";

/** One series: one bar per category, e.g. one data source. The colour comes from seriesColor. */
export interface GroupedSeries {
  key: string;
  label: string;
  color: string;
}

/** Past this many categories only the largest by total are drawn; the rest are counted below. */
const MAX_CATEGORIES = 16;
const AXIS_FONT = 11;
const BAR_RADIUS = 4;
const MAX_BAR_WIDTH = 24;
/** Room for a rotated category label, in px. */
const ROTATED_LABEL_PX = 110;
const PLOT_TOP = 10;
const RIGHT_PAD = 6;
const AXIS_STYLE = { fill: "var(--color-muted)", fontSize: AXIS_FONT };

/** The `max` categories with the largest totals, in their original order. */
function largestCategories<T extends { key: string }>(
  categories: readonly T[],
  totalOf: (key: string) => number,
  max: number,
): T[] {
  const keep = new Set(
    [...categories]
      .sort((a, b) => totalOf(b.key) - totalOf(a.key))
      .slice(0, max)
      .map((c) => c.key),
  );
  return categories.filter((c) => keep.has(c.key));
}

/**
 * Vertical grouped columns: categories along x, one bar per series inside each group, and a value
 * axis that starts at zero. Use it to compare sources or variants per category. Hovering or
 * focusing a category lists every series' value for it.
 */
export function GroupedBars({
  categories,
  series,
  values,
  valueFormat = formatNumber,
  axisFormat = formatCompact,
  height = 260,
  ariaLabel,
  onSelect,
}: {
  categories: { key: string; label: string }[];
  series: GroupedSeries[];
  values: Record<string, Record<string, number>>;
  valueFormat?: (v: number) => string;
  axisFormat?: (v: number) => string;
  height?: number;
  ariaLabel: string;
  onSelect?: (categoryKey: string) => void;
}) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<HoverState | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  if (categories.length === 0 || series.length === 0) return null;

  const valueOf = (categoryKey: string, seriesKey: string) =>
    finiteOrZero(values[categoryKey]?.[seriesKey]);
  const totalOf = (categoryKey: string) =>
    series.reduce((sum, s) => sum + Math.max(0, valueOf(categoryKey, s.key)), 0);

  const shown =
    categories.length <= MAX_CATEGORIES
      ? categories
      : largestCategories(categories, totalOf, MAX_CATEGORIES);
  const hidden = categories.length - shown.length;

  const peak = Math.max(0, ...shown.flatMap((c) => series.map((s) => valueOf(c.key, s.key))));
  const ticks = niceTicks(0, peak, 4);
  const scaleTop = Math.max(...ticks);

  const axisWidth = Math.max(...ticks.map((t) => estimateTextWidth(axisFormat(t), AXIS_FONT)));
  const left = Math.ceil(axisWidth) + 12;
  const plotW = Math.max(0, width - left - RIGHT_PAD);
  const band = bandLayout(shown.length, plotW, 0.3);
  // Labels stay flat when they fit their slot; otherwise they are shortened and rotated −30°.
  const flat = labelsFit(
    shown.map((c) => c.label),
    band.step,
    AXIS_FONT,
    8,
  );
  const xLabels = shown.map((c) =>
    flat ? c.label : fitLabel(c.label, ROTATED_LABEL_PX, AXIS_FONT),
  );
  const bottom = flat
    ? 22
    : Math.ceil(
        Math.max(...xLabels.map((l) => estimateTextWidth(l, AXIS_FONT))) * Math.sin(Math.PI / 6),
      ) + 16;
  const plotH = Math.max(40, height - PLOT_TOP - bottom);
  const plotBottom = PLOT_TOP + plotH;
  const svgH = plotBottom + bottom;
  const y = (v: number) => plotBottom - (scaleTop > 0 ? (v / scaleTop) * plotH : 0);
  const bars = groupLayout(series.length, band.bandwidth, 2, MAX_BAR_WIDTH);
  const slotX = (i: number) => left + i * band.step;
  // Hairlines land on whole pixels when offset by half a pixel.
  const crisp = (v: number) => Math.round(v) + 0.5;

  const show = (el: Element, category: { key: string; label: string }) => {
    const box = ref.current?.getBoundingClientRect() ?? NO_BOX;
    const rect = el.getBoundingClientRect();
    setActiveKey(category.key);
    setTip({
      ...hoverAnchor(box, rect),
      // The tooltip hangs from the top of the column, centred on it, so it never covers the axis.
      y: rect.top - box.top + 8,
      content: (
        <>
          <div className="mb-1 font-medium">{category.label}</div>
          {series.map((s) => {
            const raw = values[category.key]?.[s.key];
            const text = typeof raw === "number" && Number.isFinite(raw) ? valueFormat(raw) : "–";
            return <TooltipRow key={s.key} color={s.color} label={s.label} value={text} />;
          })}
        </>
      ),
    });
  };
  const hide = () => {
    setActiveKey(null);
    setTip(null);
  };

  return (
    <div ref={ref} className="relative min-w-0">
      {series.length > 1 && (
        <div className="mb-2">
          <Legend items={series} />
        </div>
      )}
      <svg
        role="img"
        aria-label={ariaLabel}
        width={width}
        height={svgH}
        viewBox={`0 0 ${width} ${svgH}`}
        className="block overflow-visible"
      >
        {ticks.map((t) => (
          <line
            key={`grid-${t}`}
            x1={left}
            x2={left + plotW}
            y1={crisp(y(t))}
            y2={crisp(y(t))}
            strokeWidth={1}
            style={{ stroke: "var(--color-line)" }}
          />
        ))}
        {shown.map((c, i) =>
          activeKey === c.key ? (
            <rect
              key={`band-${c.key}`}
              x={slotX(i)}
              y={PLOT_TOP}
              width={band.step}
              height={plotH}
              style={{ fill: "var(--color-panel-2)" }}
            />
          ) : null,
        )}
        {shown.flatMap((c, i) =>
          series.map((s, j) => {
            const v = valueOf(c.key, s.key);
            if (!(v > 0)) return null;
            const barTop = y(v);
            const x = slotX(i) + band.start + (bars.offsets[j] ?? 0);
            const d = topRoundedBarPath(x, barTop, bars.barWidth, plotBottom - barTop, BAR_RADIUS);
            return <path key={`bar-${c.key}-${s.key}`} d={d} style={{ fill: s.color }} />;
          }),
        )}
        {shown.map((c, i) => (
          <rect
            key={`hit-${c.key}`}
            x={slotX(i)}
            y={PLOT_TOP}
            width={band.step}
            height={plotH}
            tabIndex={0}
            role={onSelect ? "button" : undefined}
            style={{ fill: "transparent", cursor: onSelect ? "pointer" : undefined }}
            onPointerEnter={(e) => show(e.currentTarget, c)}
            onPointerLeave={hide}
            onFocus={(e: FocusEvent<SVGRectElement>) => show(e.currentTarget, c)}
            onBlur={hide}
            onClick={() => onSelect?.(c.key)}
            onKeyDown={(e: KeyboardEvent<SVGRectElement>) => {
              if (onSelect && isActivationKey(e.key)) {
                e.preventDefault();
                onSelect(c.key);
              }
            }}
          />
        ))}
        {ticks.map((t) => (
          <text
            key={`tick-${t}`}
            x={left - 6}
            y={y(t)}
            dy="0.32em"
            textAnchor="end"
            className="tabular-nums"
            style={AXIS_STYLE}
          >
            {axisFormat(t)}
          </text>
        ))}
        {shown.map((c, i) => {
          const cx = slotX(i) + band.step / 2;
          const label = xLabels[i] ?? c.label;
          return flat ? (
            <text
              key={`x-${c.key}`}
              x={cx}
              y={plotBottom + 15}
              textAnchor="middle"
              style={AXIS_STYLE}
            >
              {label}
            </text>
          ) : (
            <text
              key={`x-${c.key}`}
              transform={`translate(${cx + 4} ${plotBottom + 8}) rotate(-30)`}
              textAnchor="end"
              style={AXIS_STYLE}
            >
              {label}
              {label !== c.label && <title>{c.label}</title>}
            </text>
          );
        })}
      </svg>
      {hidden > 0 && (
        <p className="mt-2 text-xs text-muted">
          +{hidden} more not shown (the largest {MAX_CATEGORIES} by total are drawn)
        </p>
      )}
      <ChartTooltip hover={tip} width={width} />
    </div>
  );
}
