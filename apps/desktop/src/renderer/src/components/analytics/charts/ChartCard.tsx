import { useState, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { ChartIcon, TableIcon } from "@/components/ui/icons";

/** The same numbers as a chart, for reading exact values and for screen readers. */
export interface ChartTable {
  columns: string[];
  rows: (string | number)[][];
}

/**
 * Frame of every chart: title, one-line subtitle (what is counted), optional controls, and a
 * chart ⇄ table switch. The table is always available, so no value depends on colour alone.
 */
export function ChartCard({
  title,
  subtitle,
  actions,
  legend,
  footnote,
  table,
  className,
  testId,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  legend?: ReactNode;
  footnote?: ReactNode;
  table?: ChartTable;
  className?: string;
  testId?: string;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section
      data-testid={testId}
      className={cx("flex min-w-0 flex-col rounded-xl border border-line bg-panel", className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {table && (
            <button
              type="button"
              className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-brand"
              aria-label={showTable ? `Show ${title} as a chart` : `Show ${title} as a table`}
              title={showTable ? "Show chart" : "Show table"}
              onClick={() => setShowTable((v) => !v)}
            >
              {showTable ? <ChartIcon className="size-4" /> : <TableIcon className="size-4" />}
            </button>
          )}
        </div>
      </header>
      {legend && !showTable && <div className="px-4 pt-2">{legend}</div>}
      <div className="min-h-0 flex-1 px-4 pt-2 pb-3">
        {showTable && table ? <DataTable table={table} /> : children}
      </div>
      {footnote && (
        <div className="border-t border-line px-4 py-2 text-xs text-muted">{footnote}</div>
      )}
    </section>
  );
}

export function DataTable({ table }: { table: ChartTable }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-line">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-panel-2 text-muted">
          <tr>
            {table.columns.map((c, i) => (
              <th key={i} className={cx("px-3 py-2 font-medium", i > 0 && "text-right")}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r} className="border-t border-line">
              {row.map((cell, i) => (
                <td
                  key={i}
                  className={cx("px-3 py-1.5 text-ink", i > 0 && "text-right tabular-nums")}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Shown in place of a chart when the data has nothing to plot. Says why, never a blank box. */
export function EmptyChart({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-line px-6 py-8 text-center text-sm text-muted">
      {children}
    </div>
  );
}
