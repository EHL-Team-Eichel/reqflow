import { useMemo, useState } from "react";
import { Select } from "@/components/ui/controls";
import { useAnalytics, type AnalyticsContextValue } from "../context";
import { colorSlots, countBy, countryLabel, flowData, type FlowStage } from "../engine/aggregate";
import { countryRegion } from "../engine/countries";
import { TOPICS, topicGroup, topicLabel } from "../engine/topics";
import type { AnalyticsDataset, AnalyticsRow, Sentiment } from "../engine/types";
import { ChartCard, EmptyChart } from "../charts/ChartCard";
import { Sankey } from "../charts/Sankey";
import { formatNumber } from "../charts/format";
import { SENTIMENT_COLOR, SENTIMENT_LABEL, seriesColor } from "../charts/palette";
import { Explain, TabGrid, Toolbar } from "./shared";

interface StageOption {
  value: string;
  label: string;
  stage: FlowStage;
}

const REGIONS = [
  "Europe",
  "China",
  "North America",
  "Asia-Pacific",
  "Middle East & Africa",
  "Latin America",
  "Other",
];
const TOPIC_GROUPS = [...new Set(TOPICS.map((t) => t.group))];

/** Every dimension a record can flow through, with colours that match the other tabs. */
function stageOptions(dataset: AnalyticsDataset, ctx: AnalyticsContextValue): StageOption[] {
  const byRank = (keyOf: (r: AnalyticsRow) => string | null) => {
    const slots = colorSlots(countBy(dataset.rows, keyOf, (k) => k, false));
    return (key: string) => seriesColor(slots.get(key) ?? 8);
  };
  const options: StageOption[] = [];
  if (dataset.inputs.length > 1) {
    options.push({
      value: "input",
      label: "Input",
      stage: {
        label: "Input",
        keyOf: (r) => String(r.input),
        labelOf: (k) => dataset.inputs.find((i) => String(i.index) === k)?.label ?? k,
        colorOf: (k) => ctx.inputColor(Number(k)),
      },
    });
  }
  const sourceKey = (r: AnalyticsRow) => r.sourceId;
  const titles = new Map(dataset.rows.map((r) => [r.sourceId, r.sourceTitle]));
  if (titles.size > 1) {
    options.push({
      value: "source",
      label: "Source file",
      stage: {
        label: "Source file",
        keyOf: sourceKey,
        labelOf: (k) => titles.get(k) ?? k,
        colorOf: byRank(sourceKey),
      },
    });
  }
  if (dataset.rows.some((r) => r.country)) {
    options.push({
      value: "region",
      label: "Region",
      stage: {
        label: "Region",
        keyOf: (r) => (r.country ? countryRegion(r.country) : null),
        labelOf: (k) => k,
        colorOf: (k) => seriesColor(Math.max(0, REGIONS.indexOf(k))),
      },
    });
    options.push({
      value: "country",
      label: "Country",
      stage: {
        label: "Country",
        keyOf: (r) => r.country,
        labelOf: countryLabel,
        colorOf: ctx.countryColor,
      },
    });
  }
  if (dataset.textual) {
    options.push({
      value: "topic-group",
      label: "Topic area",
      stage: {
        label: "Topic area",
        keyOf: (r) => (r.topics[0] ? (topicGroup(r.topics[0]) ?? null) : null),
        labelOf: (k) => k,
        colorOf: (k) =>
          seriesColor(Math.max(0, TOPIC_GROUPS.indexOf(k as (typeof TOPIC_GROUPS)[number]))),
      },
    });
    const topicKey = (r: AnalyticsRow) => r.topics[0] ?? null;
    options.push({
      value: "topic",
      label: "First topic",
      stage: {
        label: "First topic",
        keyOf: topicKey,
        labelOf: topicLabel,
        colorOf: byRank(topicKey),
      },
    });
    options.push({
      value: "sentiment",
      label: "Sentiment",
      stage: {
        label: "Sentiment",
        keyOf: (r) => r.sentiment,
        labelOf: (k) => SENTIMENT_LABEL[k as Sentiment] ?? k,
        colorOf: (k) => SENTIMENT_COLOR[k as Sentiment] ?? seriesColor(8),
      },
    });
  }
  for (const column of dataset.categoryColumns) {
    const keyOf = (r: AnalyticsRow) => r.categories[column]?.[0] ?? null;
    options.push({
      value: `category:${column}`,
      label: `"${column}"`,
      stage: { label: column, keyOf, labelOf: (k) => k, colorOf: byRank(keyOf) },
    });
  }
  return options;
}

function defaultStages(options: StageOption[]): string[] {
  const has = (v: string) => options.some((o) => o.value === v);
  const order = has("input")
    ? ["input", "country", "sentiment"]
    : ["country", "topic-group", "sentiment"];
  const picked = order.filter(has);
  for (const o of options) if (picked.length < 3 && !picked.includes(o.value)) picked.push(o.value);
  return picked.slice(0, Math.max(2, Math.min(3, options.length)));
}

/**
 * Flow charts. Every record walks left to right through the chosen stages; a band's width is the
 * number of records taking that path. Per stage the eight most common values get their own node.
 */
export function FlowTab() {
  const ctx = useAnalytics();
  const { dataset, rows } = ctx;
  const options = useMemo(() => stageOptions(dataset, ctx), [dataset, ctx]);
  const [stages, setStages] = useState<string[]>(() => defaultStages(options));
  const chosen = stages
    .map((v) => options.find((o) => o.value === v))
    .filter((o): o is StageOption => !!o);
  const flow = useMemo(
    () =>
      flowData(
        rows,
        chosen.map((o) => o.stage),
      ),
    [rows, chosen],
  );

  const lineage = useMemo(() => {
    const inputStage: FlowStage = {
      label: "Input",
      keyOf: (r) => String(r.input),
      labelOf: (k) => dataset.inputs.find((i) => String(i.index) === k)?.label ?? k,
      colorOf: (k) => ctx.inputColor(Number(k)),
    };
    const titles = new Map(dataset.rows.map((r) => [r.sourceId, r.sourceTitle]));
    const sourceStage: FlowStage = {
      label: "Source file",
      keyOf: (r) => r.sourceId,
      labelOf: (k) => titles.get(k) ?? k,
      colorOf: () => seriesColor(8),
    };
    return flowData(rows, [sourceStage, inputStage], 12);
  }, [rows, dataset, ctx]);

  if (options.length < 2) {
    return (
      <TabGrid testId="analytics-flow">
        <div className="xl:col-span-2">
          <EmptyChart>
            A flow needs at least two dimensions (inputs, countries, topics, sentiment or a
            classification column). These records have fewer.
          </EmptyChart>
        </div>
      </TabGrid>
    );
  }

  const setStage = (i: number, value: string) => {
    const next = [...stages];
    if (value === "") next.splice(i, 1);
    else next[i] = value;
    setStages(next);
  };

  return (
    <TabGrid testId="analytics-flow">
      <Toolbar className="rounded-xl border border-line bg-panel p-4">
        {stages.map((value, i) => (
          <label key={i} className="flex items-center gap-2 text-sm font-medium text-ink">
            {i === 0 ? "From" : "then"}
            <Select
              id={`flow-stage-${i}`}
              value={value}
              onChange={(v) => setStage(i, v)}
              options={[
                ...(stages.length > 2 ? [{ value: "", label: "— remove —" }] : []),
                ...options.filter((o) => o.value === value || !stages.includes(o.value)),
              ]}
            />
          </label>
        ))}
        {stages.length < 4 && stages.length < options.length && (
          <button
            type="button"
            data-testid="flow-add-stage"
            className="rounded-md px-2 py-1 text-sm font-medium text-brand hover:bg-brand-soft"
            onClick={() =>
              setStages([...stages, options.find((o) => !stages.includes(o.value))!.value])
            }
          >
            + Add stage
          </button>
        )}
        <Explain>
          Each record flows left to right; band width = records taking that path. Per stage the
          eight most common values get their own node, the rest are “Other”.
        </Explain>
      </Toolbar>

      <ChartCard
        title={chosen.map((o) => o.stage.label).join(" → ")}
        subtitle={`${formatNumber(rows.length)} records`}
        className="xl:col-span-2"
        testId="chart-flow"
        table={{
          columns: ["From", "To", "Records"],
          rows: flow.links.map((l) => [
            flow.nodes.find((n) => n.id === l.source)?.label ?? l.source,
            flow.nodes.find((n) => n.id === l.target)?.label ?? l.target,
            formatNumber(l.value),
          ]),
        }}
      >
        {flow.links.length ? (
          <Sankey
            nodes={flow.nodes}
            links={flow.links}
            stageLabels={chosen.map((o) => o.stage.label)}
            height={Math.max(360, Math.min(640, 48 * Math.max(...countPerStage(flow.nodes))))}
            ariaLabel={`Flow of records: ${chosen.map((o) => o.stage.label).join(" to ")}`}
          />
        ) : (
          <EmptyChart>No records to flow.</EmptyChart>
        )}
      </ChartCard>

      <ChartCard
        title="Where the records come from"
        subtitle="Source files → the block's inputs"
        className="xl:col-span-2"
        testId="chart-flow-lineage"
        table={{
          columns: ["Source file", "Input", "Records"],
          rows: lineage.links.map((l) => [
            lineage.nodes.find((n) => n.id === l.source)?.label ?? l.source,
            lineage.nodes.find((n) => n.id === l.target)?.label ?? l.target,
            formatNumber(l.value),
          ]),
        }}
      >
        {lineage.links.length ? (
          <Sankey
            nodes={lineage.nodes}
            links={lineage.links}
            stageLabels={["Source file", "Input"]}
            height={Math.max(200, 56 * Math.max(...countPerStage(lineage.nodes)))}
            ariaLabel="Source files to inputs"
          />
        ) : (
          <EmptyChart>No records.</EmptyChart>
        )}
      </ChartCard>
    </TabGrid>
  );
}

function countPerStage(nodes: readonly { stage: number }[]): number[] {
  const counts: number[] = [];
  for (const n of nodes) counts[n.stage] = (counts[n.stage] ?? 0) + 1;
  return counts.length ? counts : [1];
}
