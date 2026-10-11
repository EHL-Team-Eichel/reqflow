import { useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "@/lib/cx";
import { formatNumber, formatPercent } from "./format";
import { NO_BOX, TAU, angularSpans, arcPath, hoverAnchor, isActivationKey, ratio } from "./bars";
import { ChartTooltip, TooltipRow, type HoverState } from "./Tooltip";
import { useWidth } from "./useWidth";

/** One slice. The caller picks the colour (seriesColor for identity, OTHER_COLOR for the tail). */
export interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** Below this width the legend moves under the ring instead of beside it. */
const STACK_BELOW = 360;

/**
 * Part-to-whole ring, slices clockwise from 12 o'clock. Every slice is named in the legend beside
 * the ring, so colour never carries identity alone. Keep it to a handful of slices, and use BarList
 * when the values are close to each other.
 */
export function Donut({
  slices,
  size = 180,
  centerLabel,
  centerValue,
  ariaLabel,
  onSelect,
  valueFormat = formatNumber,
}: {
  slices: Slice[];
  size?: number;
  centerLabel?: string;
  centerValue?: string;
  ariaLabel: string;
  onSelect?: (key: string) => void;
  valueFormat?: (v: number) => string;
}) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<HoverState | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  if (slices.length === 0) return null;

  const total = slices.reduce(
    (sum, s) => sum + (Number.isFinite(s.value) && s.value > 0 ? s.value : 0),
    0,
  );
  const spans = angularSpans(slices.map((s) => s.value));
  const centre = size / 2;
  // Four pixels of room for the hover thickening (3px) and the outline of the surface gap.
  const outer = centre - 4;
  // The ring is 22 % of its radius thick.
  const inner = outer * 0.78;
  const stacked = width < STACK_BELOW;

  const place = (
    el: Element,
    slice: Slice,
    share: number,
    pointer?: { clientX: number; clientY: number },
  ): HoverState => {
    const box = ref.current?.getBoundingClientRect() ?? NO_BOX;
    const rect = el.getBoundingClientRect();
    return {
      ...hoverAnchor(box, rect, pointer && { x: pointer.clientX, y: pointer.clientY }),
      content: (
        <TooltipRow
          color={slice.color}
          label={slice.label}
          value={`${valueFormat(slice.value)} · ${formatPercent(share)}`}
        />
      ),
    };
  };

  const leave = () => {
    setActiveKey(null);
    setTip(null);
  };

  return (
    <div
      ref={ref}
      className={cx(
        "relative flex min-w-0 gap-4",
        stacked ? "flex-col items-center" : "items-center",
      )}
    >
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg
          role="img"
          aria-label={ariaLabel}
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="block overflow-visible"
        >
          {total === 0 && (
            <path
              d={arcPath(centre, centre, outer, inner, 0, TAU)}
              style={{ fill: "var(--color-panel-2)" }}
            />
          )}
          {spans.map((span) => {
            const slice = slices[span.index];
            if (!slice) return null;
            const share = ratio(slice.value, total);
            const active = activeKey === slice.key;
            return (
              <path
                key={slice.key}
                d={arcPath(centre, centre, active ? outer + 3 : outer, inner, span.start, span.end)}
                style={{ fill: slice.color, stroke: "var(--color-panel)", strokeWidth: 2 }}
                tabIndex={0}
                role={onSelect ? "button" : undefined}
                aria-label={`${slice.label}: ${valueFormat(slice.value)}`}
                onPointerEnter={(e: PointerEvent<SVGPathElement>) => {
                  setActiveKey(slice.key);
                  setTip(place(e.currentTarget, slice, share, e));
                }}
                onPointerLeave={leave}
                onFocus={(e: FocusEvent<SVGPathElement>) => {
                  setActiveKey(slice.key);
                  setTip(place(e.currentTarget, slice, share));
                }}
                onBlur={leave}
                onClick={() => onSelect?.(slice.key)}
                onKeyDown={(e: KeyboardEvent<SVGPathElement>) => {
                  if (onSelect && isActivationKey(e.key)) {
                    e.preventDefault();
                    onSelect(slice.key);
                  }
                }}
              />
            );
          })}
        </svg>
        {(centerValue || centerLabel) && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
            {centerValue && <span className="text-xl font-semibold text-ink">{centerValue}</span>}
            {centerLabel && <span className="text-xs text-muted">{centerLabel}</span>}
          </div>
        )}
      </div>
      <ul className="w-full min-w-0 flex-1 space-y-1 text-xs">
        {slices.map((s) => (
          <li
            key={s.key}
            className={cx(
              "flex items-center gap-2 rounded px-1 py-0.5",
              activeKey === s.key && "bg-panel-2",
            )}
            onPointerEnter={() => setActiveKey(s.key)}
            onPointerLeave={() => setActiveKey(null)}
          >
            <span
              aria-hidden="true"
              className="inline-block size-2.5 shrink-0 rounded-sm"
              style={{ background: s.color }}
            />
            <span className="min-w-0 flex-1 truncate text-muted" title={s.label}>
              {s.label}
            </span>
            <span className="shrink-0 text-right tabular-nums text-ink">
              {valueFormat(s.value)}
            </span>
            <span className="w-12 shrink-0 text-right tabular-nums text-muted">
              {formatPercent(ratio(s.value, total))}
            </span>
          </li>
        ))}
      </ul>
      <ChartTooltip hover={tip} width={width} />
    </div>
  );
}
