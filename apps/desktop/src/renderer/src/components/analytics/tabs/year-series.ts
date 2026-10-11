import type { Series, YearSeriesPoint } from "../engine/types";

/**
 * Year columns ("volume_2024", "volume_2025", "volume_2030") read as one time series per row:
 * grouped by the column name without its year, one line per row label. Only the years that are
 * columns become buckets, so a gap (2025 → 2030) shows as one step, which the chart notes.
 */
export interface YearGroup {
  name: string; // "volume"
  years: number[];
  series: Series[];
  /** Bucket start of the first year after this one (a plan), or undefined when all are actuals. */
  dashedFrom?: number;
  irregular: boolean; // years aren't consecutive
}

export const yearStart = (year: number) => Date.UTC(year, 0, 1);

/** "volume_2024" → "volume", "Sales 2030" → "Sales", "2025" → "Value". */
export function yearGroupName(column: string): string {
  const name = column
    .replace(/(19|20)\d{2}/, "")
    .replace(/[\s_\-./]+$/g, "")
    .replace(/^[\s_\-./]+/g, "")
    .trim();
  return name || "Value";
}

export function groupYearSeries(
  points: readonly YearSeriesPoint[],
  opts: {
    labelOf: (point: YearSeriesPoint) => string;
    colorIndexOf: (point: YearSeriesPoint, order: number) => number;
    inputs: number;
    inputLabel: (index: number) => string;
  },
): YearGroup[] {
  const groups = new Map<string, YearSeriesPoint[]>();
  for (const p of points) {
    const name = yearGroupName(p.column);
    const list = groups.get(name) ?? [];
    list.push(p);
    groups.set(name, list);
  }
  return [...groups.entries()].map(([name, list]) => {
    const years = [...new Set(list.map((p) => p.year))].sort((a, b) => a - b);
    const lines = new Map<
      string,
      { label: string; first: YearSeriesPoint; byYear: Map<number, number> }
    >();
    for (const p of list) {
      const key = `${p.input}:${p.label}`;
      let line = lines.get(key);
      if (!line) {
        const label = opts.labelOf(p);
        line = {
          label: opts.inputs > 1 ? `${label} · ${opts.inputLabel(p.input)}` : label,
          first: p,
          byYear: new Map(),
        };
        lines.set(key, line);
      }
      line.byYear.set(p.year, (line.byYear.get(p.year) ?? 0) + p.value);
    }
    const series: Series[] = [...lines.entries()].map(([key, line], order) => ({
      key,
      label: line.label,
      colorIndex: opts.colorIndexOf(line.first, order),
      points: years.map((year) => ({
        t: yearStart(year),
        label: String(year),
        value: line.byYear.get(year) ?? 0,
      })),
    }));
    const firstPlanned = list
      .filter((p) => p.planned)
      .map((p) => p.year)
      .sort((a, b) => a - b)[0];
    return {
      name,
      years,
      series,
      ...(firstPlanned !== undefined ? { dashedFrom: yearStart(firstPlanned) } : {}),
      irregular: years.some((y, i) => i > 0 && y !== years[i - 1]! + 1),
    };
  });
}
