import { useMemo, useState } from "react";
import { Select } from "@/components/ui/controls";
import { useAnalytics } from "../context";
import { countByCategory, countByTopic, sentimentSplit } from "../engine/aggregate";
import { TOPICS, topicGroup, type TopicGroup } from "../engine/topics";
import { SENTIMENTS, UNKNOWN_KEY } from "../engine/types";
import { BarList } from "../charts/BarList";
import { ChartCard, EmptyChart } from "../charts/ChartCard";
import { Donut } from "../charts/Donut";
import { StackedBars } from "../charts/StackedBars";
import { formatNumber, formatPercent } from "../charts/format";
import { OTHER_COLOR, SENTIMENT_COLOR, SENTIMENT_LABEL, seriesColor } from "../charts/palette";
import {
  barItems,
  countTable,
  Explain,
  sentimentStack,
  sentimentTable,
  TabGrid,
  toggle,
} from "./shared";

const GROUPS: TopicGroup[] = [...new Set(TOPICS.map((t) => t.group))];

/** What the records are about (keyword topics and the data's own classifications) and their tone. */
export function TopicsTab() {
  const { dataset, rows, filters, setFilters } = useAnalytics();
  const [column, setColumn] = useState(dataset.categoryColumns[0] ?? "");
  const topics = useMemo(() => countByTopic(rows), [rows]);
  const split = useMemo(() => sentimentSplit(rows), [rows]);
  const perTopic = useMemo(
    () =>
      topics
        .slice(0, 12)
        .map((t) =>
          sentimentStack(
            t.key,
            t.label,
            sentimentSplit(rows.filter((r) => r.topics.includes(t.key))),
          ),
        ),
    [rows, topics],
  );
  const groups = useMemo(() => {
    const counts = new Map<TopicGroup, number>();
    for (const r of rows) {
      const seen = new Set(r.topics.map(topicGroup).filter((g): g is TopicGroup => !!g));
      for (const g of seen) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return GROUPS.map((g, i) => ({
      key: g,
      label: g,
      value: counts.get(g) ?? 0,
      color: seriesColor(i),
    }));
  }, [rows]);
  const categories = useMemo(() => (column ? countByCategory(rows, column) : []), [rows, column]);
  const untagged = rows.filter((r) => r.topics.length === 0).length;

  return (
    <TabGrid testId="analytics-topics">
      {dataset.textual ? (
        <>
          <ChartCard
            title="Topics"
            subtitle="Share of records that mention each topic · a record can mention several · click to filter"
            table={countTable(topics, "Topic")}
            testId="chart-topics"
            footnote={`${formatNumber(untagged)} records (${formatPercent(rows.length ? untagged / rows.length : 0)}) mention none of the topic keywords.`}
          >
            {topics.length ? (
              <BarList
                items={barItems(topics, () => seriesColor(0))}
                limit={28}
                showOther={false}
                max={rows.length}
                ariaLabel="Topics"
                selectedKeys={filters.topics}
                onSelect={(key) => setFilters({ topics: toggle(filters.topics, key) })}
              />
            ) : (
              <EmptyChart>None of the topic keywords occur in these records.</EmptyChart>
            )}
          </ChartCard>

          <ChartCard
            title="Tone per topic"
            subtitle="Positive, neutral and negative records among those that mention the topic (top 12)"
            table={sentimentTable(perTopic, "Topic")}
            testId="chart-topic-sentiment"
          >
            {perTopic.length ? (
              <StackedBars
                rows={perTopic}
                ariaLabel="Sentiment per topic"
                onSelect={(topic, sentiment) =>
                  setFilters({
                    topics: [topic],
                    sentiments: [sentiment as (typeof SENTIMENTS)[number]],
                  })
                }
              />
            ) : (
              <EmptyChart>No topics to show.</EmptyChart>
            )}
          </ChartCard>

          <ChartCard
            title="Overall sentiment"
            subtitle={
              dataset.sentimentColumn
                ? `From "${dataset.sentimentColumn}" where it names one, else an English and German word list`
                : "From an English and German word list with negation (rules, no AI)"
            }
            testId="chart-sentiment"
            table={{
              columns: ["Sentiment", "Records", "Share"],
              rows: SENTIMENTS.map((s) => [
                SENTIMENT_LABEL[s],
                formatNumber(split[s]),
                formatPercent(rows.length ? split[s] / rows.length : 0),
              ]),
            }}
            footnote={`Net sentiment ${formatSigned(rows.length ? (split.positive - split.negative) / rows.length : 0)} (positive minus negative share).`}
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
              ariaLabel="Overall sentiment"
              onSelect={(s) =>
                setFilters({
                  sentiments: toggle(filters.sentiments, s as (typeof SENTIMENTS)[number]),
                })
              }
            />
          </ChartCard>

          <ChartCard
            title="Topic areas"
            subtitle="Records mentioning at least one topic of each area"
            testId="chart-topic-groups"
            table={{
              columns: ["Area", "Records", "Share"],
              rows: groups.map((g) => [
                g.label,
                formatNumber(g.value),
                formatPercent(rows.length ? g.value / rows.length : 0),
              ]),
            }}
          >
            <Donut
              slices={groups}
              centerValue={formatNumber(rows.length - untagged)}
              centerLabel="with a topic"
              ariaLabel="Topic areas"
            />
          </ChartCard>
        </>
      ) : (
        <div className="xl:col-span-2">
          <EmptyChart>
            These inputs are tables of figures, so there are no topics or sentiment to count. Their
            columns are below.
          </EmptyChart>
        </div>
      )}

      {dataset.categoryColumns.length > 0 && (
        <ChartCard
          title={column ? `By "${column}"` : "By classification"}
          subtitle="The data's own classification columns, counted as they are"
          className="xl:col-span-2"
          testId="chart-categories"
          actions={
            <label className="flex items-center gap-2 text-xs font-medium text-muted">
              Column
              <Select
                id="topics-category-column"
                value={column}
                onChange={setColumn}
                options={dataset.categoryColumns.map((c) => ({ value: c, label: c }))}
              />
            </label>
          }
          table={countTable(categories, column || "Value")}
          footnote={
            <Explain>
              Merged rows can carry several values of a column; such a record counts once under
              each.
            </Explain>
          }
        >
          {categories.length ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
              <BarList
                items={barItems(categories, () => seriesColor(1))}
                limit={20}
                max={rows.length}
                ariaLabel={`Records by ${column}`}
              />
              {categories.filter((c) => c.key !== UNKNOWN_KEY).length <= 6 && (
                <Donut
                  slices={categories.map((c, i) => ({
                    key: c.key,
                    label: c.label,
                    value: c.count,
                    color: c.key === UNKNOWN_KEY ? OTHER_COLOR : seriesColor(i),
                  }))}
                  ariaLabel={`Split by ${column}`}
                />
              )}
            </div>
          ) : (
            <EmptyChart>No values in this column.</EmptyChart>
          )}
        </ChartCard>
      )}
    </TabGrid>
  );
}

function formatSigned(share: number): string {
  const text = formatPercent(Math.abs(share));
  return share > 0 ? `+${text}` : share < 0 ? `−${text}` : text;
}
