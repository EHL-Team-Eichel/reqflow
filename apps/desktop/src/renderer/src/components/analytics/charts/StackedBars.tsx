import {
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cx } from "@/lib/cx";
import { formatNumber, formatPercent } from "./format";
import { NO_BOX, hoverAnchor, isActivationKey, ratio } from "./bars";
import { ChartTooltip, Legend, TooltipRow, type HoverState } from "./Tooltip";
import { useWidth } from "./useWidth";

/** One bar: its parts in stacking order, left to right. Each part carries its own colour. */
export interface StackRow {
  key: string;
  label: string;
  parts: { key: string; label: string; value: number; color: string }[];
}

/** Only the last segment of a bar is round: it is the data end. */
const END_RADIUS = "0 4px 4px 0";

/** Non-negative finite values; anything else counts as nothing. */
function sizeOf(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Horizontal stacked bars, one row per entity, parts stacked left to right with a 2px surface gap.
 * With `normalize` (the default) every row is 100 %, so rows compare by mix; without it, rows
 * compare by size against the largest total. Segments carry no inline text: the legend names the
 * parts and the tooltip gives each value and share.
 */
export function StackedBars({
  rows,
  ariaLabel,
  normalize = true,
  valueFormat = formatNumber,
  onSelect,
}: {
  rows: StackRow[];
  ariaLabel: string;
  normalize?: boolean;
  valueFormat?: (v: number) => string;
  onSelect?: (rowKey: string, partKey: string) => void;
}) {
  const [ref, width] = useWidth();
  const [tip, setTip] = useState<HoverState | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  if (rows.length === 0) return null;

  const totals = rows.map((row) => row.parts.reduce((sum, p) => sum + sizeOf(p.value), 0));
  const peak = Math.max(0, ...totals);

  // Legend entries in order of first appearance; a part keeps its colour in every row.
  const legend: { key: string; label: string; color: string }[] = [];
  for (const row of rows) {
    for (const part of row.parts) {
      if (!legend.some((item) => item.key === part.key)) {
        legend.push({ key: part.key, label: part.label, color: part.color });
      }
    }
  }

  const place = (
    el: Element,
    content: ReactNode,
    pointer?: { clientX: number; clientY: number },
  ): HoverState => {
    const box = ref.current?.getBoundingClientRect() ?? NO_BOX;
    const rect = el.getBoundingClientRect();
    return {
      ...hoverAnchor(box, rect, pointer && { x: pointer.clientX, y: pointer.clientY }),
      content,
    };
  };

  return (
    <div
      ref={ref}
      role="group"
      aria-label={ariaLabel}
      className="relative flex min-w-0 flex-col gap-1.5"
    >
      {legend.length > 1 && (
        <div className="pb-1">
          <Legend items={legend} />
        </div>
      )}
      {rows.map((row, r) => {
        const total = totals[r] ?? 0;
        const fill = normalize ? 1 : ratio(total, peak);
        const parts = row.parts.filter((p) => sizeOf(p.value) > 0);
        return (
          <div key={row.key} className="flex items-center gap-3">
            <span className="w-28 shrink-0 truncate text-xs text-muted" title={row.label}>
              {row.label}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex h-7 gap-0.5" style={{ width: `${fill * 100}%` }}>
                {parts.map((part, i) => {
                  const id = `${row.key}/${part.key}`;
                  const share = ratio(part.value, total);
                  const hovered = activeId === id;
                  const content = (
                    <>
                      <div className="font-medium">{row.label}</div>
                      <TooltipRow
                        color={part.color}
                        label={part.label}
                        value={`${valueFormat(part.value)} · ${formatPercent(share)}`}
                      />
                    </>
                  );
                  return (
                    <div
                      key={part.key}
                      tabIndex={0}
                      role={onSelect ? "button" : undefined}
                      className={cx(
                        "flex h-full min-w-0 items-center",
                        onSelect && "cursor-pointer",
                      )}
                      style={{ flexGrow: sizeOf(part.value), flexBasis: 0 }}
                      onPointerEnter={(e: PointerEvent<HTMLDivElement>) => {
                        setActiveId(id);
                        setTip(place(e.currentTarget, content, e));
                      }}
                      onPointerLeave={() => {
                        setActiveId(null);
                        setTip(null);
                      }}
                      onFocus={(e: FocusEvent<HTMLDivElement>) => {
                        setActiveId(id);
                        setTip(place(e.currentTarget, content));
                      }}
                      onBlur={() => {
                        setActiveId(null);
                        setTip(null);
                      }}
                      onClick={() => onSelect?.(row.key, part.key)}
                      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
                        if (onSelect && isActivationKey(e.key)) {
                          e.preventDefault();
                          onSelect(row.key, part.key);
                        }
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className="block h-4 w-full"
                        style={{
                          background: part.color,
                          borderRadius: i === parts.length - 1 ? END_RADIUS : undefined,
                          filter: hovered ? "brightness(1.12)" : undefined,
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-ink">
              n = {valueFormat(total)}
            </span>
          </div>
        );
      })}
      <ChartTooltip hover={tip} width={width} />
    </div>
  );
}
