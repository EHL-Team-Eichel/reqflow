import { useMemo } from "react";
import { useAnalytics } from "../context";
import {
  countByCountry,
  countByTopic,
  peopleCount,
  sentimentSplit,
  timeExtent,
  timeSeries,
} from "../engine/aggregate";
import { topTerms } from "../engine/text";
import { formatDay } from "../engine/time";
import { SENTIMENTS, UNKNOWN_KEY } from "../engine/types";
import { BarList } from "../charts/BarList";
import { ChartCard, EmptyChart } from "../charts/ChartCard";
import { Donut } from "../charts/Donut";
import { LineChart } from "../charts/LineChart";
import { StatGrid, StatTile } from "../charts/StatTile";
import { formatNumber, formatPercent } from "../charts/format";
import { SENTIMENT_COLOR, SENTIMENT_LABEL, seriesColor } from "../charts/palette";
import { barItems, countTable, TabGrid, toggle } from "./shared";
import { YearSeriesCharts } from "./YearSeriesCharts";

const GRANULARITY_WORD = {
  day: "day",
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

/** The one-screen summary: headline numbers, then the most useful chart of every other tab. */
export function OverviewTab() {
  const { dataset, rows, filters, setFilters, countryColor, inputColor, granularity } =
    useAnalytics();
  const countries = useMemo(() => countByCountry(rows), [rows]);
  const topics = useMemo(() => countByTopic(rows), [rows]);
  const split = useMemo(() => sentimentSplit(rows), [rows]);
  const extent = useMemo(() => timeExtent(rows), [rows]);
  const people = useMemo(() => peopleCount(rows), [rows]);
  const series = useMemo(
    () =>
      timeSeries(rows, granularity, [
        { key: "all", label: "Records", colorIndex: 0, includes: () => true },
      ]),
    [rows, granularity],
  );
  const phrases = useMemo(
    () =>
      dataset.textual
        ? topTerms(
            rows.map((r) => r.text),
            { ngram: 2, limit: 10 },
          )
        : [],
    [rows, dataset.textual],
  );
  const knownCountries = countries.filter((c) => c.key !== UNKNOWN_KEY);
  const inputCounts = dataset.inputs.map((i) => ({
    ...i,
    count: rows.filter((r) => r.input === i.index).length,
  }));

  return (
    <TabGrid testId="analytics-overview">
      <div className="xl:col-span-2">
        <StatGrid>
          <StatTile
            testId="kpi-records"
            label="Records"
            value={formatNumber(rows.length)}
            hint="comments or rows counted"
          />
          <StatTile
            testId="kpi-people"
            label="People"
            value={formatNumber(people)}
            hint={
              dataset.idColumn ? `distinct "${dataset.idColumn}"` : "no ID column: one per record"
            }
          />
          <StatTile
            testId="kpi-countries"
            label="Countries"
            value={formatNumber(knownCountries.length)}
            hint={
              knownCountries[0]
                ? `most: ${knownCountries[0].label} (${formatPercent(knownCountries[0].share)})`
                : "no country column"
            }
          />
          <StatTile
            testId="kpi-time"
            label="Time span"
            value={
              extent
                ? `${formatDay(extent[0]).slice(0, 7)} – ${formatDay(extent[1]).slice(0, 7)}`
                : "No dates yet"
            }
            hint={
              extent
                ? `${formatPercent(rows.filter((r) => r.time !== null).length / (rows.length || 1))} dated`
                : "add a date column"
            }
          />
          {dataset.textual && (
            <StatTile
              testId="kpi-negative"
              label="Negative"
              value={formatPercent(rows.length ? split.negative / rows.length : 0)}
              hint={`${formatNumber(split.negative)} records · ${formatPercent(rows.length ? split.positive / rows.length : 0)} positive`}
            />
          )}
          {dataset.textual && (
            <StatTile
              testId="kpi-topic"
              label="Top topic"
              value={topics[0]?.label ?? "–"}
              hint={
                topics[0] ? `${formatPercent(topics[0].share)} of records` : "no topic words found"
              }
            />
          )}
        </StatGrid>
      </div>

      <ChartCard
        title="Records by country"
        subtitle="Click a country to filter every view"
        table={countTable(countries, "Country")}
        testId="chart-overview-countries"
      >
        {knownCountries.length ? (
          <BarList
            items={barItems(countries, countryColor)}
            limit={10}
            ariaLabel="Records by country"
            selectedKeys={filters.countries}
            onSelect={(key) => setFilters({ countries: toggle(filters.countries, key) })}
          />
        ) : (
          <EmptyChart>
            No country column found. Name it in the block's <em>Country column</em> parameter.
          </EmptyChart>
        )}
      </ChartCard>

      {dataset.textual ? (
        <ChartCard
          title="Sentiment"
          subtitle={
            dataset.sentimentColumn
              ? `From "${dataset.sentimentColumn}" where it names one, else a word list`
              : "From an English and German word list (rules, no AI)"
          }
          table={{
            columns: ["Sentiment", "Records", "Share"],
            rows: SENTIMENTS.map((s) => [
              SENTIMENT_LABEL[s],
              formatNumber(split[s]),
              formatPercent(rows.length ? split[s] / rows.length : 0),
            ]),
          }}
          testId="chart-overview-sentiment"
        >
          <Donut
            slices={SENTIMENTS.map((s) => ({
              key: s,
              label: SENTIMENT_LABEL[s],
              value: split[s],
              color: SENTIMENT_COLOR[s],
            }))}
            centerValue={formatNumber(rows.length)}
            centerLabel="records"
            ariaLabel="Sentiment split"
            onSelect={(key) =>
              setFilters({
                sentiments: toggle(filters.sentiments, key as (typeof SENTIMENTS)[number]),
              })
            }
          />
        </ChartCard>
      ) : (
        <ChartCard title="Inputs" subtitle="Records per input" testId="chart-overview-inputs">
          <Donut
            slices={inputCounts.map((i) => ({
              key: String(i.index),
              label: i.label,
              value: i.count,
              color: inputColor(i.index),
            }))}
            centerValue={formatNumber(rows.length)}
            centerLabel="records"
            ariaLabel="Records per input"
          />
        </ChartCard>
      )}

      {dataset.textual && (
        <ChartCard
          title="What people talk about"
          subtitle="Share of records that mention each topic (keyword rules; a record can mention several)"
          table={countTable(topics, "Topic")}
          testId="chart-overview-topics"
        >
          {topics.length ? (
            <BarList
              items={barItems(topics, () => seriesColor(0))}
              limit={10}
              showOther={false}
              max={rows.length}
              ariaLabel="Topics mentioned"
              selectedKeys={filters.topics}
              onSelect={(key) => setFilters({ topics: toggle(filters.topics, key) })}
            />
          ) : (
            <EmptyChart>None of the topic keywords occur in these records.</EmptyChart>
          )}
        </ChartCard>
      )}

      <ChartCard
        title="Over time"
        subtitle={extent ? `Records per ${GRANULARITY_WORD[granularity]}` : "Needs a date column"}
        table={
          series[0]
            ? {
                columns: ["Period", "Records"],
                rows: series[0].points.map((p) => [p.label, formatNumber(p.value)]),
              }
            : undefined
        }
        testId="chart-overview-time"
      >
        {series[0] ? (
          <LineChart series={series} area height={220} ariaLabel="Records over time" />
        ) : (
          <EmptyChart>
            No time column yet. The timeline fills in as soon as a dataset has a date, month,
            quarter or year column.
          </EmptyChart>
        )}
      </ChartCard>

      {dataset.textual && phrases.length > 0 && (
        <ChartCard
          title="Most used phrases"
          subtitle="Two-word phrases by the share of records that use them (stop words left out)"
          table={{
            columns: ["Phrase", "Records", "Share"],
            rows: phrases.map((p) => [p.term, formatNumber(p.docs), formatPercent(p.share)]),
          }}
          testId="chart-overview-phrases"
        >
          <BarList
            items={phrases.map((p) => ({
              key: p.term,
              label: p.term,
              value: p.docs,
              share: p.share,
              color: seriesColor(2),
            }))}
            showOther={false}
            ariaLabel="Most used phrases"
            onSelect={(term) => setFilters({ search: `"${term}"` })}
          />
        </ChartCard>
      )}

      {dataset.inputs.length > 1 && dataset.textual && (
        <ChartCard
          title="Inputs"
          subtitle="Records per input after the filters"
          table={{
            columns: ["Input", "Records"],
            rows: inputCounts.map((i) => [i.label, formatNumber(i.count)]),
          }}
          testId="chart-overview-inputs"
        >
          <Donut
            slices={inputCounts.map((i) => ({
              key: String(i.index),
              label: i.label,
              value: i.count,
              color: inputColor(i.index),
            }))}
            centerValue={formatNumber(rows.length)}
            centerLabel="records"
            ariaLabel="Records per input"
            onSelect={(key) => setFilters({ inputs: toggle(filters.inputs, Number(key)) })}
          />
        </ChartCard>
      )}

      {dataset.yearSeries.length > 0 && <YearSeriesCharts />}

      <ChartCard
        title="How this was counted"
        subtitle="Detected from the data, rules only"
        className="xl:col-span-2"
        testId="analytics-notes"
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink">
          {dataset.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </ChartCard>
    </TabGrid>
  );
}
