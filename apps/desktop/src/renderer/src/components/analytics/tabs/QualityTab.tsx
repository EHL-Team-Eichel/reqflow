import { useMemo } from "react";
import { cx } from "@/lib/cx";
import { useAnalytics } from "../context";
import { countBy, coverage } from "../engine/aggregate";
import { UNKNOWN_KEY, type ColumnRole } from "../engine/types";
import { BarList } from "../charts/BarList";
import { ChartCard } from "../charts/ChartCard";
import { Donut } from "../charts/Donut";
import { StatGrid, StatTile } from "../charts/StatTile";
import { formatNumber, formatPercent } from "../charts/format";
import { OTHER_COLOR, seriesColor } from "../charts/palette";
import { countTable, TabGrid } from "./shared";

const ROLE_LABEL: Record<ColumnRole, string> = {
  country: "Country",
  time: "Time",
  id: "Person ID",
  text: "Comment text",
  category: "Classification",
  number: "Number",
  year_series: "Figure per year",
  other: "Not used",
};

const LENGTHS: { key: string; label: string; test: (words: number) => boolean }[] = [
  { key: "0", label: "Empty", test: (w) => w === 0 },
  { key: "1-10", label: "1–10 words", test: (w) => w >= 1 && w <= 10 },
  { key: "11-25", label: "11–25 words", test: (w) => w >= 11 && w <= 25 },
  { key: "26-50", label: "26–50 words", test: (w) => w >= 26 && w <= 50 },
  { key: "51-100", label: "51–100 words", test: (w) => w >= 51 && w <= 100 },
  { key: "100+", label: "Over 100 words", test: (w) => w > 100 },
];

/** What the numbers rest on: how complete the data is and how each column was read. */
export function QualityTab() {
  const { dataset, rows, inputs } = useAnalytics();
  const cov = useMemo(() => coverage(rows), [rows]);
  const languages = useMemo(() => countBy(rows, (r) => r.language), [rows]);
  const lengths = LENGTHS.map((l) => ({ ...l, count: rows.filter((r) => l.test(r.words)).length }));
  const total = dataset.rows.length || 1;

  return (
    <TabGrid testId="analytics-quality">
      <div className="xl:col-span-2">
        <StatGrid>
          <StatTile
            label="With a country"
            value={formatPercent(cov.country)}
            hint={dataset.countryColumn ? `"${dataset.countryColumn}"` : "no country column"}
          />
          <StatTile
            label="Dated"
            value={formatPercent(cov.time)}
            hint={dataset.timeColumn ? `"${dataset.timeColumn}"` : "no time column yet"}
          />
          <StatTile
            label="With a person ID"
            value={formatPercent(cov.person)}
            hint={dataset.idColumn ? `"${dataset.idColumn}"` : "no ID column"}
          />
          {dataset.textual && (
            <StatTile label="With a topic" value={formatPercent(cov.topic)} hint="keyword rules" />
          )}
          {dataset.textual && (
            <StatTile label="Words per record" value={formatNumber(cov.avgWords)} hint="average" />
          )}
          <StatTile
            label="Repeated texts"
            value={formatNumber(cov.duplicates)}
            hint="records whose text appears earlier"
            delta={
              cov.duplicates
                ? { text: "check for duplicates", tone: "down" }
                : { text: "none", tone: "flat" }
            }
          />
        </StatGrid>
      </div>

      <ChartCard
        title="Inputs"
        subtitle="What arrived on each input of the block"
        className="xl:col-span-2"
        testId="chart-quality-inputs"
      >
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-3 font-medium">Input</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 text-right font-medium">Records</th>
              <th className="py-2 pr-3 text-right font-medium">Sources</th>
              <th className="py-2 font-medium">Note</th>
            </tr>
          </thead>
          <tbody>
            {inputs.map((input) => (
              <tr key={input.port} className="border-b border-line last:border-0">
                <td className="py-1.5 pr-3">
                  <span className="inline-flex items-center gap-1.5 text-ink">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2.5 rounded-sm"
                      style={{ background: seriesColor(input.index) }}
                    />
                    {input.label}
                  </span>
                </td>
                <td
                  className={cx(
                    "py-1.5 pr-3",
                    input.status === "error" ? "text-danger" : "text-ink",
                  )}
                >
                  {input.status === "ready"
                    ? "Read"
                    : input.status === "needs_run"
                      ? "Needs a run"
                      : input.status === "unconnected"
                        ? "Not connected"
                        : input.status === "error"
                          ? "Error"
                          : "Reading"}
                </td>
                <td className="py-1.5 pr-3 text-right text-ink tabular-nums">
                  {formatNumber(input.data?.records.length ?? 0)}
                </td>
                <td className="py-1.5 pr-3 text-right text-ink tabular-nums">
                  {formatNumber(input.data?.sources.length ?? 0)}
                </td>
                <td className="py-1.5 text-xs text-muted">
                  {input.message ?? input.data?.sources.map((s) => s.title).join(", ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ChartCard>

      <ChartCard
        title="Columns"
        subtitle="How each column of the data was read (detected from its name and values, or set on the block)"
        className="xl:col-span-2"
        testId="chart-quality-columns"
      >
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-panel text-xs text-muted">
              <tr className="border-b border-line">
                <th className="py-2 pr-3 font-medium">Column</th>
                <th className="py-2 pr-3 font-medium">Read as</th>
                <th className="py-2 pr-3 text-right font-medium">Filled</th>
                <th className="py-2 text-right font-medium">Distinct values</th>
              </tr>
            </thead>
            <tbody>
              {dataset.columns.map((c) => (
                <tr key={c.name} className="border-b border-line last:border-0">
                  <td className="py-1.5 pr-3 text-ink">{c.name}</td>
                  <td className={cx("py-1.5 pr-3", c.role === "other" ? "text-muted" : "text-ink")}>
                    {ROLE_LABEL[c.role]}
                    {c.role === "other" && c.distinct === 1 ? " (one value only)" : ""}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-ink tabular-nums">
                    {formatPercent(c.filled / total)}
                  </td>
                  <td className="py-1.5 text-right text-ink tabular-nums">
                    {formatNumber(c.distinct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>

      {dataset.textual && (
        <ChartCard
          title="Comment length"
          subtitle="Words per record: very short comments carry little detail"
          testId="chart-quality-length"
          table={{
            columns: ["Length", "Records", "Share"],
            rows: lengths.map((l) => [
              l.label,
              formatNumber(l.count),
              formatPercent(rows.length ? l.count / rows.length : 0),
            ]),
          }}
        >
          <BarList
            items={lengths.map((l) => ({
              key: l.key,
              label: l.label,
              value: l.count,
              share: rows.length ? l.count / rows.length : 0,
              color: seriesColor(0),
            }))}
            showOther={false}
            ariaLabel="Comment length"
          />
        </ChartCard>
      )}

      {dataset.textual && (
        <ChartCard
          title="Languages"
          subtitle="From the data's language column, else guessed by the Raw block"
          testId="chart-quality-languages"
          table={countTable(languages, "Language", false)}
        >
          <Donut
            slices={languages.slice(0, 8).map((l, i) => ({
              key: l.key,
              label: l.key === UNKNOWN_KEY ? "Unknown" : l.label.toUpperCase(),
              value: l.count,
              color: l.key === UNKNOWN_KEY ? OTHER_COLOR : seriesColor(i),
            }))}
            centerValue={formatNumber(rows.length)}
            centerLabel="records"
            ariaLabel="Languages"
          />
        </ChartCard>
      )}

      <ChartCard
        title="How this was counted"
        subtitle="Everything detected from the data"
        className="xl:col-span-2"
        testId="chart-quality-notes"
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          {dataset.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          <li>
            Every number on these pages is counted from the records by fixed rules. No AI model
            reads, summarises or scores them.
          </li>
        </ul>
      </ChartCard>
    </TabGrid>
  );
}
