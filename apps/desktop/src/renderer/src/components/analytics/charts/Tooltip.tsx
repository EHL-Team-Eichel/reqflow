import type { ReactNode } from "react";

/** What a chart shows on hover: an anchor point in the chart's own pixels and the content. */
export interface HoverState {
  x: number;
  y: number;
  content: ReactNode;
}

/**
 * A tooltip positioned inside a `relative` chart container. It flips to the left of the pointer
 * in the right half of the chart so it never runs off the edge. Text uses ink tokens; a colour
 * swatch next to a value carries the series identity.
 */
export function ChartTooltip({ hover, width }: { hover: HoverState | null; width: number }) {
  if (!hover) return null;
  const flip = hover.x > width / 2;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 max-w-72 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-ink shadow-lg"
      style={{
        left: flip ? undefined : hover.x + 12,
        right: flip ? Math.max(0, width - hover.x + 12) : undefined,
        top: Math.max(0, hover.y - 12),
      }}
    >
      {hover.content}
    </div>
  );
}

/** One "■ label  value" line inside a tooltip. */
export function TooltipRow({
  color,
  label,
  value,
}: {
  color?: string;
  label: ReactNode;
  value: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-0.5">
      <span className="flex min-w-0 items-center gap-2">
        {color && (
          <span
            aria-hidden="true"
            className="inline-block size-2.5 shrink-0 rounded-sm"
            style={{ background: color }}
          />
        )}
        <span className="truncate text-muted">{label}</span>
      </span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

/** Legend for two or more series: swatch + label, in series order. */
export function Legend({
  items,
}: {
  items: { key: string; label: string; color: string; dashed?: boolean }[];
}) {
  if (items.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-3 rounded-sm"
            style={
              item.dashed
                ? { border: `2px dashed ${item.color}`, background: "transparent" }
                : { background: item.color }
            }
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
