import { useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { formatNumber, formatPercent, truncate } from "./format";
import { sequentialColor, sequentialInk } from "./palette";
import { ChartTooltip, type HoverState } from "./Tooltip";
import { useWidth } from "./useWidth";

const CELL_H = 26;
const MIN_CELL_W = 28; // below this the grid scrolls sideways
const MAX_CELL_W = 96;
const VALUE_MIN_W = 34; // narrower cells show their value only on hover and focus
const LABEL_MAX_PX = 170;
const COL_NAME_CHARS = 16;
const ROTATION = 40; // column headers turn by this many degrees when narrow
const CHAR_PX = 6.5; // generous advance of 11px text, for layout only
const KEY_STEPS: Record<string, [number, number]> = {
  ArrowRight: [0, 1],
  ArrowLeft: [0, -1],
  ArrowDown: [1, 0],
  ArrowUp: [-1, 0],
};

const textWidth = (s: string) => s.length * CHAR_PX;

function widest(texts: string[]): number {
  let w = 0;
  for (const t of texts) w = Math.max(w, textWidth(t));
  return w;
}

/**
 * Rows × columns grid, each cell shaded on one blue ramp by its value (0 = lightest). Cells are
 * focusable: the arrow keys move between them, and focus or hover shows row × column, the value
 * and the optional detail. The grid scrolls sideways rather than squeezing cells below 28px.
 */
export function Heatmap({
  rows,
  columns,
  values,
  max,
  valueFormat = formatPercent,
  cellDetail,
  ariaLabel,
  onSelect,
}: {
  rows: { key: string; label: string; total?: number }[];
  columns: { key: string; label: string }[];
  values: Record<string, Record<string, number>>;
  max?: number;
  valueFormat?: (v: number) => string;
  cellDetail?: (rowKey: string, colKey: string) => string | undefined;
  ariaLabel: string;
  onSelect?: (rowKey: string, colKey: string) => void;
}): ReactElement | null {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<{ r: number; c: number; hover: HoverState } | null>(null);
  if (rows.length === 0 || columns.length === 0) return null;

  const cellValue = (rowKey: string, colKey: string): number => {
    const v = values[rowKey]?.[colKey];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  let dataMax = 0;
  for (const row of rows) {
    for (const col of columns) dataMax = Math.max(dataMax, cellValue(row.key, col.key));
  }
  const colorMax = max !== undefined && max > 0 ? max : dataMax > 0 ? dataMax : 1;

  // Row labels, then an optional column of totals, then the grid.
  const hasTotals = rows.some((row) => row.total !== undefined);
  const labelBox = Math.min(LABEL_MAX_PX, widest(rows.map((row) => row.label)));
  const totalBox = hasTotals ? widest(rows.map((row) => formatNumber(row.total ?? 0))) : 0;
  const labelCol = labelBox + (hasTotals ? totalBox + 12 : 0) + 12;
  const labelChars = Math.max(4, Math.floor(labelBox / CHAR_PX));

  // Columns share the card's width, never narrower than 28px. Rotated headers reach past the last
  // column, so that room is reserved before the cells are sized.
  const colNames = columns.map((col) => truncate(col.label, COL_NAME_CHARS));
  const colNameBox = widest(colNames);
  const slantOverhang = Math.ceil(colNameBox * Math.cos((ROTATION * Math.PI) / 180));
  const cellW = Math.min(
    MAX_CELL_W,
    Math.max(MIN_CELL_W, Math.floor((width - labelCol - slantOverhang) / columns.length)),
  );
  const rotated = colNameBox > cellW - 4;
  const headerH = rotated ? Math.ceil(colNameBox * Math.sin((ROTATION * Math.PI) / 180)) + 16 : 28;
  const overhang = rotated ? slantOverhang : 0;
  const svgW = labelCol + columns.length * cellW + overhang;
  const svgH = headerH + rows.length * CELL_H;

  const tooltip = (r: number, c: number): ReactNode => {
    const row = rows[r];
    const col = columns[c];
    if (!row || !col) return null;
    const detail = cellDetail?.(row.key, col.key);
    return (
      <div>
        <div className="text-muted">
          {row.label} × {col.label}
        </div>
        <div className="text-sm font-semibold tabular-nums text-ink">
          {valueFormat(cellValue(row.key, col.key))}
        </div>
        {detail && <div className="text-muted">{detail}</div>}
      </div>
    );
  };

  // Anchor the tooltip on the cell itself, so it is right after scrolling and for keyboard focus.
  const show = (el: Element, r: number, c: number) => {
    const outer = ref.current;
    if (!outer) return;
    const cell = el.getBoundingClientRect();
    const box = outer.getBoundingClientRect();
    setActive({
      r,
      c,
      hover: {
        x: cell.left - box.left + cell.width / 2,
        y: cell.top - box.top,
        content: tooltip(r, c),
      },
    });
  };

  const onCellKey = (
    e: KeyboardEvent<SVGGElement>,
    r: number,
    c: number,
    rowKey: string,
    colKey: string,
  ) => {
    const step = KEY_STEPS[e.key];
    if (step) {
      e.preventDefault();
      const target = `[data-r="${r + step[0]}"][data-c="${c + step[1]}"]`;
      e.currentTarget.closest("svg")?.querySelector<SVGGElement>(target)?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect?.(rowKey, colKey);
    }
  };

  return (
    <div ref={ref} className="min-w-0">
      <div className="relative">
        <div className="overflow-x-auto">
          <svg
            role="img"
            aria-label={ariaLabel}
            width={svgW}
            height={svgH}
            viewBox={`0 0 ${svgW} ${svgH}`}
            className="block"
          >
            {columns.map((col, c) => {
              const cx = labelCol + c * cellW + cellW / 2;
              const name = colNames[c] ?? col.label;
              return rotated ? (
                <text
                  key={col.key}
                  x={cx}
                  y={headerH - 6}
                  transform={`rotate(-${ROTATION} ${cx} ${headerH - 6})`}
                  fontSize={11}
                  style={{ fill: "var(--color-muted)" }}
                >
                  <title>{col.label}</title>
                  {name}
                </text>
              ) : (
                <text
                  key={col.key}
                  x={cx}
                  y={headerH - 8}
                  textAnchor="middle"
                  fontSize={11}
                  style={{ fill: "var(--color-muted)" }}
                >
                  <title>{col.label}</title>
                  {truncate(col.label, Math.max(3, Math.floor((cellW - 6) / CHAR_PX)))}
                </text>
              );
            })}

            {rows.map((row, r) => {
              const cy = headerH + r * CELL_H + CELL_H / 2;
              return (
                <g key={row.key}>
                  <text
                    x={0}
                    y={cy}
                    dominantBaseline="central"
                    fontSize={12}
                    style={{ fill: "var(--color-ink)" }}
                  >
                    <title>{row.label}</title>
                    {truncate(row.label, labelChars)}
                  </text>
                  {row.total !== undefined && (
                    <text
                      x={labelCol - 12}
                      y={cy}
                      textAnchor="end"
                      dominantBaseline="central"
                      fontSize={11}
                      className="tabular-nums"
                      style={{ fill: "var(--color-muted)" }}
                    >
                      {formatNumber(row.total)}
                    </text>
                  )}
                </g>
              );
            })}

            {rows.map((row, r) => (
              <g key={`cells-${row.key}`}>
                {columns.map((col, c) => {
                  const v = cellValue(row.key, col.key);
                  const t = Math.min(1, Math.max(0, v / colorMax));
                  const x = labelCol + c * cellW;
                  const y = headerH + r * CELL_H;
                  const isActive = active !== null && active.r === r && active.c === c;
                  const text = valueFormat(v);
                  const detail = cellDetail?.(row.key, col.key);
                  return (
                    <g
                      key={col.key}
                      data-r={r}
                      data-c={c}
                      tabIndex={0}
                      role={onSelect ? "button" : "img"}
                      aria-label={`${row.label}, ${col.label}: ${text}${detail ? `. ${detail}` : ""}`}
                      onPointerEnter={(e) => show(e.currentTarget, r, c)}
                      onPointerLeave={() => setActive(null)}
                      onFocus={(e) => show(e.currentTarget, r, c)}
                      onBlur={() => setActive(null)}
                      onClick={() => onSelect?.(row.key, col.key)}
                      onKeyDown={(e) => onCellKey(e, r, c, row.key, col.key)}
                    >
                      <rect
                        x={x + 1}
                        y={y + 1}
                        width={cellW - 2}
                        height={CELL_H - 2}
                        rx={3}
                        style={{ fill: sequentialColor(t) }}
                      />
                      {isActive && (
                        <rect
                          x={x + 2}
                          y={y + 2}
                          width={cellW - 4}
                          height={CELL_H - 4}
                          rx={2}
                          fill="none"
                          strokeWidth={2}
                          style={{ stroke: "var(--color-ink)" }}
                        />
                      )}
                      {cellW >= VALUE_MIN_W && (
                        <text
                          x={x + cellW / 2}
                          y={y + CELL_H / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fontSize={11}
                          className="tabular-nums"
                          style={{ fill: sequentialInk(t) }}
                        >
                          {text}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>
        </div>
        <ChartTooltip hover={active?.hover ?? null} width={width} />
      </div>

      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        <span className="tabular-nums">{valueFormat(0)}</span>
        <span
          role="img"
          aria-label={`Colour scale from ${valueFormat(0)} to ${valueFormat(colorMax)}`}
          className="flex"
        >
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <span key={i} className="h-2.5 w-6" style={{ background: sequentialColor(i / 6) }} />
          ))}
        </span>
        <span className="tabular-nums">{valueFormat(colorMax)}</span>
      </div>
    </div>
  );
}
