import { useState, type FocusEvent, type PointerEvent } from "react";
import { cx } from "@/lib/cx";
import { formatNumber, formatPercent } from "./format";
import { NO_BOX, OTHER_KEY, foldOther, hoverAnchor, ratio } from "./bars";
import { OTHER_COLOR, seriesColor } from "./palette";
import { ChartTooltip, TooltipRow, type HoverState } from "./Tooltip";
import { useWidth } from "./useWidth";

/** One bar. `share` (0–1) is printed after the value; `detail` only appears in the tooltip. */
export interface BarItem {
  key: string;
  label: string;
  value: number;
  color?: string;
  detail?: string;
  share?: number;
}

/** Bars are thin and round only at the data end; the baseline stays square. */
const END_RADIUS = "0 4px 4px 0";

interface Row {
  key: string;
  label: string;
  value: number;
  share?: number;
  color: string;
  detail?: string;
  isOther: boolean;
}

function valueText(row: Row, valueFormat: (v: number) => string): string {
  const base = valueFormat(row.value);
  if (row.share === undefined || !Number.isFinite(row.share)) return base;
  return `${base} · ${formatPercent(row.share)}`;
}

/**
 * Ranked horizontal bars, one row per item, largest first. Rows past `limit` are summed into an
 * "Other (n)" row. Use it for countries, topics or terms; use Donut for a part-to-whole split.
 */
export function BarList({
  items,
  max,
  valueFormat = formatNumber,
  limit = 12,
  onSelect,
  selectedKeys = [],
  ariaLabel,
  showOther = true,
}: {
  items: BarItem[];
  max?: number;
  valueFormat?: (v: number) => string;
  limit?: number;
  onSelect?: (key: string) => void;
  selectedKeys?: string[];
  ariaLabel: string;
  showOther?: boolean;
}) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<HoverState | null>(null);
  if (items.length === 0) return null;

  const rows: Row[] = foldOther(items, limit)
    .filter((r) => showOther || r.key !== OTHER_KEY)
    .map((r) => {
      const isOther = r.key === OTHER_KEY;
      const item = r as BarItem;
      return {
        key: r.key,
        label: r.label,
        value: Number.isFinite(r.value) ? r.value : 0,
        share: r.share,
        color: isOther ? OTHER_COLOR : (item.color ?? seriesColor(0)),
        detail: isOther ? undefined : item.detail,
        isOther,
      };
    });
  const scaleMax = max ?? Math.max(0, ...rows.map((r) => r.value));
  const valueCh = Math.max(...rows.map((r) => valueText(r, valueFormat).length)) + 1;
  const gridTemplateColumns = `minmax(0, 38%) minmax(0, 1fr) ${valueCh}ch`;

  const place = (
    el: HTMLElement,
    row: Row,
    pointer?: { clientX: number; clientY: number },
  ): HoverState => {
    const box = ref.current?.getBoundingClientRect() ?? NO_BOX;
    const rect = el.getBoundingClientRect();
    const anchor = hoverAnchor(
      box,
      rect,
      pointer && { x: pointer.clientX, y: rect.top + rect.height / 2 },
    );
    return {
      ...anchor,
      content: (
        <>
          <TooltipRow color={row.color} label={row.label} value={valueText(row, valueFormat)} />
          {row.detail && <div className="mt-0.5 text-muted">{row.detail}</div>}
        </>
      ),
    };
  };

  return (
    <div ref={ref} className="relative min-w-0">
      <div role="list" aria-label={ariaLabel} className="flex flex-col">
        {rows.map((row) => {
          const selected = selectedKeys.includes(row.key);
          const dimmed = selectedKeys.length > 0 && !selected;
          const interactive = Boolean(onSelect) && !row.isOther;
          const className = cx(
            "grid h-7 w-full items-center gap-3 rounded-md px-1.5 text-xs focus-visible:outline-2 focus-visible:outline-brand",
            interactive && "cursor-pointer hover:bg-panel-2",
            selected && "bg-brand-soft",
            dimmed && "opacity-40",
          );
          const handlers = {
            onPointerEnter: (e: PointerEvent<HTMLElement>) =>
              setTip(place(e.currentTarget, row, e)),
            onPointerLeave: () => setTip(null),
            onFocus: (e: FocusEvent<HTMLElement>) => setTip(place(e.currentTarget, row)),
            onBlur: () => setTip(null),
          };
          const body = (
            <>
              <span className="min-w-0 truncate text-muted" title={row.label}>
                {row.label}
              </span>
              <span
                aria-hidden="true"
                className="relative block h-2.5 min-w-0 bg-panel-2"
                style={{ borderRadius: END_RADIUS }}
              >
                <span
                  className="absolute inset-y-0 left-0"
                  style={{
                    width: `${ratio(row.value, scaleMax) * 100}%`,
                    minWidth: row.value > 0 ? 2 : 0,
                    background: row.color,
                    borderRadius: END_RADIUS,
                  }}
                />
              </span>
              <span className="text-right tabular-nums text-ink">
                {valueText(row, valueFormat)}
              </span>
            </>
          );
          return (
            <div role="listitem" key={row.key}>
              {interactive ? (
                <button
                  type="button"
                  aria-pressed={selected}
                  className={className}
                  style={{ gridTemplateColumns }}
                  onClick={() => onSelect?.(row.key)}
                  {...handlers}
                >
                  {body}
                </button>
              ) : (
                <div
                  tabIndex={0}
                  className={className}
                  style={{ gridTemplateColumns }}
                  {...handlers}
                >
                  {body}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <ChartTooltip hover={tip} width={width} />
    </div>
  );
}
