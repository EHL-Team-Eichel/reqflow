import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { countryLabel } from "../engine/aggregate";
import { SENTIMENTS, UNKNOWN_KEY, type CountRow, type Sentiment } from "../engine/types";
import type { BarItem } from "../charts/BarList";
import type { ChartTable } from "../charts/ChartCard";
import type { StackRow } from "../charts/StackedBars";
import { formatNumber, formatPercent } from "../charts/format";
import { OTHER_COLOR, SENTIMENT_COLOR, SENTIMENT_LABEL } from "../charts/palette";

/** Helpers every tab shares: grids, toggles, and turning counts into chart items and tables. */

export function TabGrid({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div data-testid={testId} className="grid gap-4 xl:grid-cols-2">
      {children}
    </div>
  );
}

/** A row of controls above the charts of a tab. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-wrap items-center gap-x-5 gap-y-2 xl:col-span-2", className)}>
      {children}
    </div>
  );
}

export function ToolbarItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="font-medium text-muted">{label}</span>
      {children}
    </div>
  );
}

export function toggle<T>(list: readonly T[] | undefined, value: T): T[] {
  const set = new Set(list ?? []);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return [...set];
}

/** Count rows → ranked bars ("1,204 · 42%", people in the tooltip). */
export function barItems(
  counts: readonly CountRow[],
  colorOf: (key: string) => string,
  peopleLabel = "people",
): BarItem[] {
  return counts.map((c) => ({
    key: c.key,
    label: c.label,
    value: c.count,
    share: c.share,
    color: c.key === UNKNOWN_KEY ? OTHER_COLOR : colorOf(c.key),
    detail: `${formatNumber(c.people)} ${peopleLabel}`,
  }));
}

/** The same counts as a table: label, records, share, people. */
export function countTable(
  counts: readonly CountRow[],
  first: string,
  withPeople = true,
): ChartTable {
  return {
    columns: withPeople ? [first, "Records", "Share", "People"] : [first, "Records", "Share"],
    rows: counts.map((c) =>
      withPeople
        ? [c.label, formatNumber(c.count), formatPercent(c.share), formatNumber(c.people)]
        : [c.label, formatNumber(c.count), formatPercent(c.share)],
    ),
  };
}

/** One 100% bar per group with its positive / neutral / negative parts, colours fixed. */
export function sentimentStack(
  key: string,
  label: string,
  split: Record<Sentiment, number>,
): StackRow {
  return {
    key,
    label,
    parts: SENTIMENTS.map((s) => ({
      key: s,
      label: SENTIMENT_LABEL[s],
      value: split[s],
      color: SENTIMENT_COLOR[s],
    })),
  };
}

export function sentimentTable(rows: readonly StackRow[], first: string): ChartTable {
  return {
    columns: [first, "Records", ...SENTIMENTS.map((s) => SENTIMENT_LABEL[s])],
    rows: rows.map((row) => {
      const total = row.parts.reduce((a, p) => a + p.value, 0) || 1;
      return [
        row.label,
        formatNumber(row.parts.reduce((a, p) => a + p.value, 0)),
        ...row.parts.map((p) => `${formatPercent(p.value / total)} (${formatNumber(p.value)})`),
      ];
    }),
  };
}

export { countryLabel };

/** "records" or "people": what a person is, given whether the data has an ID column. */
export function peopleWord(hasId: boolean): string {
  return hasId ? "people" : "records (no ID column)";
}

/** Small muted paragraph explaining where a number comes from. */
export function Explain({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted">{children}</p>;
}
