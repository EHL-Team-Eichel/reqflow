import { useMemo, useState } from "react";
import type { TimeGranularity } from "@reqflow/core";
import { Segmented } from "@/components/settings/Segmented";
import { useAnalytics } from "../context";
import { countByTopic, peopleCount, timeExtent, timeSeries } from "../engine/aggregate";
import { matchesPhrase, parsePhrase } from "../engine/text";
import { formatDay } from "../engine/time";
import { topicLabel } from "../engine/topics";
import { ChartCard, EmptyChart } from "../charts/ChartCard";
import { LineChart } from "../charts/LineChart";
import { StatGrid, StatTile } from "../charts/StatTile";
import { formatNumber, formatPercent } from "../charts/format";
import { TabGrid, Toolbar, ToolbarItem } from "./shared";
import {
  busiest,
  timelineSpecs,
  type TimelineMetric,
  type TimelineSplit,
} from "./timeline-helpers";
import { YearSeriesCharts } from "./YearSeriesCharts";

const BUCKETS: { value: TimeGranularity; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

/** How things change over time: records, people or sentiment per bucket, split as you choose. */
export function TimelineTab() {
  const {
    dataset,
    rows,
    allRows,
    granularity,
    granularitySetting,
    setGranularity,
    phrases,
    setFilters,
  } = useAnalytics();
  const [metric, setMetric] = useState<TimelineMetric>("records");
  const [split, setSplit] = useState<TimelineSplit>("total");
  const extent = useMemo(() => timeExtent(rows), [rows]);
  const isShare = metric === "negative" || metric === "positive";

  const main = useMemo(
    () =>
      timeSeries(
        rows,
        granularity,
        timelineSpecs(split, metric, { allRows, inputs: dataset.inputs }),
        isShare && split !== "sentiment" ? "share" : metric === "people" ? "people" : "records",
      ),
    [rows, granularity, split, metric, allRows, dataset.inputs, isShare],
  );
  const phraseSeries = useMemo(() => {
    if (!dataset.textual || !phrases.length) return [];
    const parsed = phrases
      .slice(0, 8)
      .map((p) => ({ raw: p, query: parsePhrase(p) }))
      .filter((p) => p.query);
    return timeSeries(
      rows,
      granularity,
      parsed.map(({ raw, query }, i) => ({
        key: raw,
        label: raw,
        colorIndex: i,
        includes: () => true,
        counts: (r) => matchesPhrase(r.text, query!),
      })),
      "share",
    );
  }, [rows, granularity, phrases, dataset.textual]);
  const topicSeries = useMemo(() => {
    if (!dataset.textual) return [];
    const topics = countByTopic(rows).slice(0, 5);
    return timeSeries(
      rows,
      granularity,
      topics.map((t, i) => ({
        key: t.key,
        label: topicLabel(t.key),
        colorIndex: i,
        includes: () => true,
        counts: (r) => r.topics.includes(t.key),
      })),
      "share",
    );
  }, [rows, granularity, dataset.textual]);

  if (!extent) {
    return (
      <TabGrid testId="analytics-timeline">
        <div className="xl:col-span-2">
          <EmptyChart>
            <span>
              No time column yet — the timeline fills in automatically as soon as a dataset has a
              date, month, quarter or year column (e.g. Date, Created, Month, Year). You can also
              name it in the block's <em>Time column</em> parameter.
              {dataset.notes
                .filter((n) => /time/i.test(n))
                .map((n) => (
                  <span key={n} className="mt-2 block">
                    {n}
                  </span>
                ))}
            </span>
          </EmptyChart>
        </div>
        {dataset.yearSeries.length > 0 && <YearSeriesCharts />}
      </TabGrid>
    );
  }

  const peak = busiest(main);
  const dated = rows.filter((r) => r.time !== null).length;
  const buckets = main[0]?.points.length ?? 0;
  const unit = granularity;
  const valueFormat = isShare && split !== "sentiment" ? formatPercent : formatNumber;
  const metricWord =
    metric === "records"
      ? "Records"
      : metric === "people"
        ? "People"
        : `Share ${metric === "negative" ? "negative" : "positive"}`;

  return (
    <TabGrid testId="analytics-timeline">
      <Toolbar>
        <ToolbarItem label="Buckets">
          <Segmented
            options={BUCKETS}
            value={granularitySetting}
            onChange={setGranularity}
            testIdPrefix="timeline-bucket-"
          />
        </ToolbarItem>
        <ToolbarItem label="Count">
          <Segmented<TimelineMetric>
            options={[
              { value: "records", label: "Records" },
              { value: "people", label: "People" },
              ...(dataset.textual
                ? ([
                    { value: "negative", label: "Negative %" },
                    { value: "positive", label: "Positive %" },
                  ] as const)
                : []),
            ]}
            value={metric}
            onChange={setMetric}
            testIdPrefix="timeline-metric-"
          />
        </ToolbarItem>
        <ToolbarItem label="Split by">
          <Segmented<TimelineSplit>
            options={[
              { value: "total", label: "Total" },
              ...(dataset.inputs.length > 1
                ? ([{ value: "inputs", label: "Inputs" }] as const)
                : []),
              { value: "countries", label: "Countries" },
              ...(dataset.textual ? ([{ value: "sentiment", label: "Sentiment" }] as const) : []),
            ]}
            value={split}
            onChange={setSplit}
            testIdPrefix="timeline-split-"
          />
        </ToolbarItem>
      </Toolbar>

      <ChartCard
        title={`${split === "sentiment" ? "Records by sentiment" : metricWord} per ${unit}`}
        subtitle={`${formatDay(extent[0])} to ${formatDay(extent[1])} · ${formatNumber(dated)} dated records · click a ${unit} to filter to it`}
        className="xl:col-span-2"
        testId="chart-timeline"
        table={{
          columns: [unit[0]!.toUpperCase() + unit.slice(1), ...main.map((s) => s.label)],
          rows: (main[0]?.points ?? []).map((p, i) => [
            p.label,
            ...main.map((s) => valueFormat(s.points[i]?.value ?? 0)),
          ]),
        }}
      >
        <LineChart
          series={main}
          area={main.length === 1}
          height={280}
          valueFormat={valueFormat}
          axisFormat={isShare && split !== "sentiment" ? formatPercent : undefined}
          yMax={isShare && split !== "sentiment" ? 1 : undefined}
          ariaLabel={`${metricWord} per ${unit}`}
          onSelectBucket={(t) => {
            const next = main[0]?.points.findIndex((p) => p.t === t) ?? -1;
            const end = main[0]?.points[next + 1]?.t ?? extent[1] + 1;
            setFilters({ from: t, to: end });
          }}
        />
      </ChartCard>

      <div className="xl:col-span-2">
        <StatGrid>
          <StatTile
            label={`Busiest ${unit}`}
            value={peak ? peak.label : "–"}
            hint={
              peak
                ? `${formatNumber(peak.value)} ${metric === "people" ? "people" : "records"}`
                : undefined
            }
          />
          <StatTile
            label="Dated records"
            value={formatPercent(rows.length ? dated / rows.length : 0)}
            hint={`${formatNumber(dated)} of ${formatNumber(rows.length)}`}
          />
          <StatTile label="Span" value={`${formatDay(extent[0])} – ${formatDay(extent[1])}`} />
          <StatTile
            label={`Average per ${unit}`}
            value={formatNumber(buckets ? dated / buckets : 0)}
            hint={`${formatNumber(peopleCount(rows))} people overall`}
          />
        </StatGrid>
      </div>

      {phraseSeries.length > 0 && (
        <ChartCard
          title="Tracked phrases over time"
          subtitle={`Share of records per ${unit} that say it (phrases from "What people say")`}
          testId="chart-timeline-phrases"
          table={{
            columns: ["Period", ...phraseSeries.map((s) => s.label)],
            rows: (phraseSeries[0]?.points ?? []).map((p, i) => [
              p.label,
              ...phraseSeries.map((s) => formatPercent(s.points[i]?.value ?? 0)),
            ]),
          }}
        >
          <LineChart
            series={phraseSeries}
            valueFormat={formatPercent}
            axisFormat={formatPercent}
            ariaLabel="Tracked phrases over time"
          />
        </ChartCard>
      )}

      {topicSeries.length > 0 && (
        <ChartCard
          title="Topics over time"
          subtitle={`The five most mentioned topics: share of records per ${unit}`}
          testId="chart-timeline-topics"
          className={phraseSeries.length ? undefined : "xl:col-span-2"}
          table={{
            columns: ["Period", ...topicSeries.map((s) => s.label)],
            rows: (topicSeries[0]?.points ?? []).map((p, i) => [
              p.label,
              ...topicSeries.map((s) => formatPercent(s.points[i]?.value ?? 0)),
            ]),
          }}
        >
          <LineChart
            series={topicSeries}
            valueFormat={formatPercent}
            axisFormat={formatPercent}
            ariaLabel="Topics over time"
          />
        </ChartCard>
      )}

      {dataset.yearSeries.length > 0 && <YearSeriesCharts />}
    </TabGrid>
  );
}
