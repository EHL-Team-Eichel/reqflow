import { useMemo } from "react";
import { useAnalytics } from "../context";
import {
  countByCountry,
  countByRegion,
  countByTopic,
  countryLabel,
  crossTab,
  sentimentSplit,
} from "../engine/aggregate";
import { topicLabel } from "../engine/topics";
import { UNKNOWN_KEY } from "../engine/types";
import { BarList } from "../charts/BarList";
import { ChartCard, EmptyChart } from "../charts/ChartCard";
import { Donut } from "../charts/Donut";
import { GroupedBars } from "../charts/GroupedBars";
import { Heatmap } from "../charts/Heatmap";
import { StackedBars } from "../charts/StackedBars";
import { formatNumber, formatPercent } from "../charts/format";
import { seriesColor } from "../charts/palette";
import { barItems, countTable, sentimentStack, sentimentTable, TabGrid, toggle } from "./shared";

/** Regions in a fixed order, so each keeps its colour whatever the filters leave. */
const REGIONS = [
  "Europe",
  "China",
  "North America",
  "Asia-Pacific",
  "Middle East & Africa",
  "Latin America",
  "Other",
];

/** Where the records come from, and how what people say differs by country. */
export function CountriesTab() {
  const { dataset, rows, filters, setFilters, countryColor, inputColor } = useAnalytics();
  const countries = useMemo(() => countByCountry(rows), [rows]);
  const known = countries.filter((c) => c.key !== UNKNOWN_KEY);
  const regions = useMemo(() => countByRegion(rows), [rows]);
  const top = known.slice(0, 10);

  const sentimentRows = useMemo(
    () =>
      top.map((c) =>
        sentimentStack(c.key, c.label, sentimentSplit(rows.filter((r) => r.country === c.key))),
      ),
    [rows, countries],
  );

  const heat = useMemo(() => {
    const topics = countByTopic(rows).slice(0, 10);
    const tab = crossTab(
      rows,
      (r) => r.country,
      (r) => r.topics,
    );
    return { topics, ...tab };
  }, [rows]);

  const mix = useMemo(() => {
    const categories = known.slice(0, 12).map((c) => ({ key: c.key, label: c.label }));
    const values: Record<string, Record<string, number>> = {};
    for (const input of dataset.inputs) {
      const ofInput = rows.filter((r) => r.input === input.index);
      for (const c of categories) {
        (values[c.key] ??= {})[String(input.index)] = ofInput.length
          ? ofInput.filter((r) => r.country === c.key).length / ofInput.length
          : 0;
      }
    }
    return { categories, values };
  }, [rows, countries, dataset.inputs]);

  if (!known.length) {
    const candidates = dataset.columns
      .filter((c) => c.role === "category" || c.role === "other")
      .slice(0, 8)
      .map((c) => `"${c.name}"`);
    return (
      <TabGrid testId="analytics-countries">
        <div className="xl:col-span-2">
          <EmptyChart>
            No country column found in these inputs, so there is nothing to count by country. Name
            it in the block's <em>Country column</em> parameter
            {candidates.length ? ` (columns here: ${candidates.join(", ")})` : ""}.
          </EmptyChart>
        </div>
      </TabGrid>
    );
  }

  return (
    <TabGrid testId="analytics-countries">
      <ChartCard
        title="Records by country"
        subtitle="How many records come from each country · click to filter"
        table={countTable(countries, "Country")}
        testId="chart-countries"
      >
        <BarList
          items={barItems(countries, countryColor)}
          limit={20}
          ariaLabel="Records by country"
          selectedKeys={filters.countries}
          onSelect={(key) => setFilters({ countries: toggle(filters.countries, key) })}
        />
      </ChartCard>

      <ChartCard
        title="By region"
        subtitle="Countries grouped into BMW's market regions"
        table={countTable(regions, "Region")}
        testId="chart-regions"
      >
        <Donut
          slices={REGIONS.flatMap((region, i) => {
            const c = regions.find((r) => r.key === region);
            return c ? [{ key: region, label: region, value: c.count, color: seriesColor(i) }] : [];
          })}
          centerValue={formatNumber(known.reduce((a, c) => a + c.count, 0))}
          centerLabel="with a country"
          ariaLabel="Records by region"
        />
      </ChartCard>

      {dataset.textual && (
        <ChartCard
          title="Sentiment by country"
          subtitle={
            dataset.sentimentColumn
              ? `From "${dataset.sentimentColumn}" where it names one, else a word list · top 10 countries`
              : "From an English and German word list · top 10 countries"
          }
          table={sentimentTable(sentimentRows, "Country")}
          testId="chart-country-sentiment"
        >
          <StackedBars
            rows={sentimentRows}
            ariaLabel="Sentiment by country"
            onSelect={(country, sentiment) =>
              setFilters({
                countries: [country],
                sentiments: [sentiment as "positive" | "neutral" | "negative"],
              })
            }
          />
        </ChartCard>
      )}

      {dataset.textual && heat.topics.length > 0 && (
        <ChartCard
          title="Topics by country"
          subtitle="Share of each country's records that mention the topic · click a cell to filter"
          className="xl:col-span-2"
          testId="chart-country-topics"
          table={{
            columns: ["Country", ...heat.topics.map((t) => t.label)],
            rows: top.map((c) => [
              c.label,
              ...heat.topics.map((t) => formatPercent(heat.values[c.key]?.[t.key] ?? 0)),
            ]),
          }}
        >
          <Heatmap
            rows={top.map((c) => ({ key: c.key, label: c.label, total: c.count }))}
            columns={heat.topics.map((t) => ({ key: t.key, label: topicLabel(t.key) }))}
            values={heat.values}
            cellDetail={(country, topic) => {
              const n = heat.counts[country]?.[topic] ?? 0;
              const total = top.find((c) => c.key === country)?.count ?? 0;
              return `${formatNumber(n)} of ${formatNumber(total)} records`;
            }}
            ariaLabel="Topics by country"
            onSelect={(country, topic) => setFilters({ countries: [country], topics: [topic] })}
          />
        </ChartCard>
      )}

      {dataset.inputs.length > 1 && (
        <ChartCard
          title="Country mix per input"
          subtitle="Share of each input's records from the country, so inputs of different size compare fairly"
          className="xl:col-span-2"
          testId="chart-country-mix"
          table={{
            columns: ["Country", ...dataset.inputs.map((i) => i.label)],
            rows: mix.categories.map((c) => [
              c.label,
              ...dataset.inputs.map((i) =>
                formatPercent(mix.values[c.key]?.[String(i.index)] ?? 0),
              ),
            ]),
          }}
        >
          <GroupedBars
            categories={mix.categories}
            series={dataset.inputs.map((i) => ({
              key: String(i.index),
              label: i.label,
              color: inputColor(i.index),
            }))}
            values={mix.values}
            valueFormat={formatPercent}
            axisFormat={formatPercent}
            ariaLabel="Country mix per input"
            onSelect={(country) => setFilters({ countries: toggle(filters.countries, country) })}
          />
        </ChartCard>
      )}

      {dataset.yearSeries.length > 0 && <FiguresByCountry />}
    </TabGrid>
  );
}

/** The latest actual year of each year column, per country (e.g. sales volume 2025). */
function FiguresByCountry() {
  const { dataset, countryColor } = useAnalytics();
  const actualYears = dataset.yearSeries.filter((p) => !p.planned).map((p) => p.year);
  const year = actualYears.length
    ? Math.max(...actualYears)
    : Math.max(...dataset.yearSeries.map((p) => p.year));
  const points = dataset.yearSeries.filter((p) => p.year === year);
  const column = points[0]?.column ?? String(year);
  const total = points.reduce((a, p) => a + p.value, 0) || 1;
  const items = points.map((p, i) => ({
    key: `${p.input}:${p.label}:${i}`,
    label: p.country ? countryLabel(p.country) : p.label,
    value: p.value,
    share: p.value / total,
    color: p.country ? countryColor(p.country) : seriesColor(0),
  }));
  return (
    <ChartCard
      title={`${column} by country`}
      subtitle={`The latest ${actualYears.length ? "actual" : "planned"} year (${year}) of the year columns`}
      testId="chart-country-figures"
      table={{
        columns: ["Row", String(year), "Share"],
        rows: items.map((i) => [i.label, formatNumber(i.value), formatPercent(i.share)]),
      }}
    >
      <BarList items={items} showOther={false} ariaLabel={`${column} by country`} />
    </ChartCard>
  );
}
