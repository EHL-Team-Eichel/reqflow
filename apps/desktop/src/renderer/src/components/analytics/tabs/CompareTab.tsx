import { useMemo, useState } from "react";
import { Select } from "@/components/ui/controls";
import { cx } from "@/lib/cx";
import { useAnalytics } from "../context";
import {
  countByCountry,
  countByTopic,
  segmentsOf,
  sentimentSplit,
  timeSeries,
  type CompareBy,
  type Segment,
} from "../engine/aggregate";
import { distinctiveTerms } from "../engine/text";
import { UNKNOWN_KEY } from "../engine/types";
import { ChartCard, EmptyChart } from "../charts/ChartCard";
import { GroupedBars } from "../charts/GroupedBars";
import { LineChart } from "../charts/LineChart";
import { StackedBars } from "../charts/StackedBars";
import { formatNumber, formatPercent, formatPoints } from "../charts/format";
import { seriesColor } from "../charts/palette";
import { biggestDifferences, comparisonFeatures, segmentSummary } from "./compare-helpers";
import { Explain, sentimentStack, sentimentTable, TabGrid, Toolbar } from "./shared";

const MAX_SEGMENTS = 6;

/**
 * Data sources side by side. Shares, not counts, so a small source compares fairly with a big
 * one; differences are tested (two-proportion z-test) before they're called differences.
 */
export function CompareTab() {
  const { dataset, rows, phrases, granularity } = useAnalytics();
  const options = useMemo(() => {
    const list: { value: CompareBy; label: string }[] = [];
    if (dataset.inputs.length > 1) list.push({ value: "input", label: "Inputs" });
    if (new Set(dataset.rows.map((r) => r.sourceId)).size > 1)
      list.push({ value: "source", label: "Source files" });
    if (dataset.rows.some((r) => r.country)) list.push({ value: "country", label: "Countries" });
    for (const c of dataset.categoryColumns) list.push({ value: `category:${c}`, label: `"${c}"` });
    return list;
  }, [dataset]);
  const [by, setBy] = useState<CompareBy>(options[0]?.value ?? "input");
  const all = useMemo(() => segmentsOf(dataset, rows, by), [dataset, rows, by]);
  // The picks per "compare by" choice; until the user picks, the largest segments (all inputs).
  const [picks, setPicks] = useState<Partial<Record<CompareBy, string[]>>>({});
  const picked = picks[by] ?? all.slice(0, by === "input" ? MAX_SEGMENTS : 4).map((s) => s.key);
  const setPicked = (next: string[]) => setPicks((p) => ({ ...p, [by]: next }));
  const pickedKey = picked.join("\u0000");
  const segments = useMemo(
    () => all.filter((s) => picked.includes(s.key) && s.rows.length > 0),
    // `pickedKey` stands for `picked`, which is a new array on every render until the user picks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, pickedKey],
  );

  const features = useMemo(
    () => comparisonFeatures(rows, phrases, dataset.textual),
    [rows, phrases, dataset.textual],
  );
  const differences = useMemo(() => biggestDifferences(segments, features), [segments, features]);

  if (!options.length) {
    return (
      <TabGrid testId="analytics-compare">
        <div className="xl:col-span-2">
          <EmptyChart>
            There is only one source here and nothing to split it by. Add a second input with
            <strong> + Add input</strong> on the block and connect another source, or use data with
            a country or classification column.
          </EmptyChart>
        </div>
      </TabGrid>
    );
  }

  const color = (s: Segment) => seriesColor(s.colorIndex);

  return (
    <TabGrid testId="analytics-compare">
      <Toolbar className="rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-sm font-medium text-ink">
          Compare
          <Select
            id="compare-by"
            value={by}
            onChange={(v) => setBy(v as CompareBy)}
            options={options}
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Segments">
          {all.slice(0, 24).map((s) => {
            const on = picked.includes(s.key);
            return (
              <button
                key={s.key}
                type="button"
                aria-pressed={on}
                data-testid="compare-segment"
                disabled={!on && picked.length >= MAX_SEGMENTS}
                onClick={() =>
                  setPicked(on ? picked.filter((k) => k !== s.key) : [...picked, s.key])
                }
                className={cx(
                  "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium disabled:opacity-40",
                  on
                    ? "border-brand bg-brand-soft text-ink"
                    : "border-line bg-panel text-muted hover:text-ink",
                )}
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-2 rounded-full"
                  style={{ background: color(s) }}
                />
                {s.label}
                <span className="text-muted">{formatNumber(s.rows.length)}</span>
              </button>
            );
          })}
        </div>
        <Explain>Pick up to {MAX_SEGMENTS}. Every share is of that segment's own records.</Explain>
      </Toolbar>

      {segments.length < 2 ? (
        <div className="xl:col-span-2">
          <EmptyChart>Pick at least two segments with records to compare them.</EmptyChart>
        </div>
      ) : (
        <>
          <SideBySide segments={segments} textual={dataset.textual} hasId={!!dataset.idColumn} />
          {dataset.textual && <TopicShares segments={segments} />}
          {dataset.textual && <SentimentBySegment segments={segments} />}
          {by !== "country" && <CountryMix segments={segments} />}

          {dataset.textual && (
            <ChartCard
              title="Biggest differences"
              subtitle="Topics, sentiment and tracked phrases with the largest gap between segments"
              className="xl:col-span-2"
              testId="chart-compare-differences"
              footnote={
                <Explain>
                  ▲ / ▼: this segment's share is significantly higher / lower than in all other
                  selected segments together (two-proportion z-test, p &lt; 0.05). “few” = too few
                  records for the test. Differences without a mark may be chance.
                </Explain>
              }
            >
              <div className="max-h-[28rem] overflow-auto">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-panel text-muted">
                    <tr className="border-b border-line">
                      <th className="py-2 pr-3 font-medium">What</th>
                      {segments.map((s) => (
                        <th key={s.key} className="px-2 py-2 text-right font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            <span
                              aria-hidden="true"
                              className="inline-block size-2 rounded-full"
                              style={{ background: color(s) }}
                            />
                            {s.label}
                          </span>
                        </th>
                      ))}
                      <th className="py-2 pl-2 text-right font-medium">Gap</th>
                    </tr>
                  </thead>
                  <tbody>
                    {differences.slice(0, 20).map((d) => (
                      <tr key={d.feature.key} className="border-b border-line last:border-0">
                        <td className="py-1.5 pr-3 text-ink">{d.feature.label}</td>
                        {d.cells.map((cell) => (
                          <td
                            key={cell.segment}
                            className="px-2 py-1.5 text-right text-ink tabular-nums"
                          >
                            {formatPercent(cell.share)}{" "}
                            <span
                              className={cx(
                                "inline-block w-7 text-left",
                                cell.vsRest.significant
                                  ? cell.vsRest.delta > 0
                                    ? "text-ok"
                                    : "text-danger"
                                  : "text-muted",
                              )}
                              title={
                                cell.vsRest.enoughData
                                  ? `${formatPoints(cell.vsRest.delta)} vs the rest, p = ${cell.vsRest.p.toFixed(3)}`
                                  : "Too few records for the test"
                              }
                            >
                              {!cell.vsRest.enoughData
                                ? "few"
                                : cell.vsRest.significant
                                  ? cell.vsRest.delta > 0
                                    ? "▲"
                                    : "▼"
                                  : ""}
                            </span>
                          </td>
                        ))}
                        <td className="py-1.5 pl-2 text-right text-muted tabular-nums">
                          {formatPoints(d.spread).replace("+", "")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartCard>
          )}

          {dataset.textual && <DistinctiveWords segments={segments} />}

          {segments.some((s) => s.rows.some((r) => r.time !== null)) && (
            <OverTime segments={segments} granularity={granularity} rows={rows} />
          )}
        </>
      )}
    </TabGrid>
  );
}

function SideBySide({
  segments,
  textual,
  hasId,
}: {
  segments: Segment[];
  textual: boolean;
  hasId: boolean;
}) {
  const summaries = segments.map(segmentSummary);
  const lines: [string, (i: number) => string][] = [
    ["Records", (i) => formatNumber(summaries[i]!.records)],
    [hasId ? "People" : "People (no ID column)", (i) => formatNumber(summaries[i]!.people)],
    ["Countries", (i) => formatNumber(summaries[i]!.countries)],
    ["Dated", (i) => formatPercent(summaries[i]!.dated)],
    ...(textual
      ? ([
          ["Words per record", (i) => formatNumber(summaries[i]!.avgWords)],
          ["Negative", (i) => formatPercent(summaries[i]!.negative)],
          ["Positive", (i) => formatPercent(summaries[i]!.positive)],
          ["Top topic", (i) => summaries[i]!.topTopic],
        ] as [string, (i: number) => string][])
      : []),
  ];
  return (
    <ChartCard
      title="Side by side"
      subtitle="Headline numbers of each segment"
      className="xl:col-span-2"
      testId="chart-compare-summary"
    >
      <div className="overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-3 font-medium" />
              {segments.map((s) => (
                <th key={s.key} className="px-3 py-2 text-right font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2.5 rounded-sm"
                      style={{ background: seriesColor(s.colorIndex) }}
                    />
                    {s.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map(([label, value]) => (
              <tr key={label} className="border-b border-line last:border-0">
                <td className="py-1.5 pr-3 text-xs text-muted">{label}</td>
                {segments.map((s, i) => (
                  <td key={s.key} className="px-3 py-1.5 text-right text-ink tabular-nums">
                    {value(i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

function TopicShares({ segments }: { segments: Segment[] }) {
  const data = useMemo(() => {
    const topics = countByTopic(segments.flatMap((s) => s.rows)).slice(0, 10);
    const values: Record<string, Record<string, number>> = {};
    for (const t of topics)
      for (const s of segments)
        (values[t.key] ??= {})[s.key] = s.rows.length
          ? s.rows.filter((r) => r.topics.includes(t.key)).length / s.rows.length
          : 0;
    return { topics, values };
  }, [segments]);
  return (
    <ChartCard
      title="Topics per segment"
      subtitle="Share of each segment's records that mention the topic (top 10 topics)"
      className="xl:col-span-2"
      testId="chart-compare-topics"
      table={{
        columns: ["Topic", ...segments.map((s) => s.label)],
        rows: data.topics.map((t) => [
          t.label,
          ...segments.map((s) => formatPercent(data.values[t.key]?.[s.key] ?? 0)),
        ]),
      }}
    >
      <GroupedBars
        categories={data.topics.map((t) => ({ key: t.key, label: t.label }))}
        series={segments.map((s) => ({
          key: s.key,
          label: s.label,
          color: seriesColor(s.colorIndex),
        }))}
        values={data.values}
        valueFormat={formatPercent}
        axisFormat={formatPercent}
        height={280}
        ariaLabel="Topic shares per segment"
      />
    </ChartCard>
  );
}

function SentimentBySegment({ segments }: { segments: Segment[] }) {
  const rows = segments.map((s) => sentimentStack(s.key, s.label, sentimentSplit(s.rows)));
  return (
    <ChartCard
      title="Sentiment per segment"
      subtitle="Positive, neutral and negative records of each segment"
      table={sentimentTable(rows, "Segment")}
      testId="chart-compare-sentiment"
    >
      <StackedBars rows={rows} ariaLabel="Sentiment per segment" />
    </ChartCard>
  );
}

function CountryMix({ segments }: { segments: Segment[] }) {
  const data = useMemo(() => {
    const countries = countByCountry(segments.flatMap((s) => s.rows))
      .filter((c) => c.key !== UNKNOWN_KEY)
      .slice(0, 10);
    const values: Record<string, Record<string, number>> = {};
    for (const c of countries)
      for (const s of segments)
        (values[c.key] ??= {})[s.key] = s.rows.length
          ? s.rows.filter((r) => r.country === c.key).length / s.rows.length
          : 0;
    return { countries, values };
  }, [segments]);
  if (!data.countries.length) return null;
  return (
    <ChartCard
      title="Country mix per segment"
      subtitle="Share of each segment's records from the country"
      testId="chart-compare-countries"
      table={{
        columns: ["Country", ...segments.map((s) => s.label)],
        rows: data.countries.map((c) => [
          c.label,
          ...segments.map((s) => formatPercent(data.values[c.key]?.[s.key] ?? 0)),
        ]),
      }}
    >
      <GroupedBars
        categories={data.countries.map((c) => ({ key: c.key, label: c.label }))}
        series={segments.map((s) => ({
          key: s.key,
          label: s.label,
          color: seriesColor(s.colorIndex),
        }))}
        values={data.values}
        valueFormat={formatPercent}
        axisFormat={formatPercent}
        ariaLabel="Country mix per segment"
      />
    </ChartCard>
  );
}

function DistinctiveWords({ segments }: { segments: Segment[] }) {
  const lists = useMemo(
    () =>
      segments.map((s) => ({
        segment: s,
        terms: distinctiveTerms(
          s.rows.map((r) => r.text),
          segments.filter((o) => o.key !== s.key).flatMap((o) => o.rows.map((r) => r.text)),
          { limit: 8 },
        ),
      })),
    [segments],
  );
  return (
    <ChartCard
      title="Words that set each segment apart"
      subtitle="Used clearly more often here than in the other segments (weighted log-odds, z > 1.96)"
      className="xl:col-span-2"
      testId="chart-compare-words"
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {lists.map(({ segment, terms }) => (
          <div key={segment.key} className="rounded-lg border border-line p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
              <span
                aria-hidden="true"
                className="inline-block size-2.5 rounded-sm"
                style={{ background: seriesColor(segment.colorIndex) }}
              />
              {segment.label}
            </div>
            {terms.length ? (
              <ol className="space-y-1 text-xs">
                {terms.map((t) => (
                  <li key={t.term} className="flex justify-between gap-3">
                    <span className="text-ink">{t.term}</span>
                    <span className="text-muted tabular-nums">
                      {formatPercent(t.shareA)} vs {formatPercent(t.shareB)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-muted">No word stands out with enough records.</p>
            )}
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

function OverTime({
  segments,
  granularity,
  rows,
}: {
  segments: Segment[];
  granularity: Parameters<typeof timeSeries>[1];
  rows: Parameters<typeof timeSeries>[0];
}) {
  const series = useMemo(() => {
    const ids = new Map(segments.map((s) => [s.key, new Set(s.rows.map((r) => r.id))]));
    return timeSeries(
      rows,
      granularity,
      segments.map((s) => ({
        key: s.key,
        label: s.label,
        colorIndex: s.colorIndex,
        includes: (r) => ids.get(s.key)!.has(r.id),
      })),
    );
  }, [segments, granularity, rows]);
  return (
    <ChartCard
      title="Records over time per segment"
      subtitle={`Records per ${granularity}`}
      className="xl:col-span-2"
      testId="chart-compare-time"
      table={{
        columns: ["Period", ...series.map((s) => s.label)],
        rows: (series[0]?.points ?? []).map((p, i) => [
          p.label,
          ...series.map((s) => formatNumber(s.points[i]?.value ?? 0)),
        ]),
      }}
    >
      <LineChart series={series} ariaLabel="Records over time per segment" />
    </ChartCard>
  );
}
