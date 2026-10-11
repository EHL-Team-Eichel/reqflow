import { colorSlots, countByCountry, countryLabel, type SeriesSpec } from "../engine/aggregate";
import { UNKNOWN_KEY, type AnalyticsRow, type Series } from "../engine/types";

/** How the main timeline splits its lines. */
export type TimelineSplit = "total" | "inputs" | "countries" | "sentiment";
/** What the main timeline counts per bucket. */
export type TimelineMetric = "records" | "people" | "negative" | "positive";

/**
 * Line definitions for the main timeline. Colours follow the entity: inputs their port slot,
 * countries their slot in the whole dataset (the rest share "Other"), and sentiment uses the slots
 * whose hues match the sentiment tokens (positive = M blue slot 0, negative = M red slot 1,
 * neutral = grey "Other").
 */
export function timelineSpecs(
  split: TimelineSplit,
  metric: TimelineMetric,
  ctx: {
    allRows: readonly AnalyticsRow[];
    inputs: readonly { index: number; label: string }[];
  },
): SeriesSpec[] {
  const counts =
    metric === "negative"
      ? (r: AnalyticsRow) => r.sentiment === "negative"
      : metric === "positive"
        ? (r: AnalyticsRow) => r.sentiment === "positive"
        : undefined;
  const withCounts = (spec: Omit<SeriesSpec, "counts">): SeriesSpec =>
    counts ? { ...spec, counts } : spec;

  if (split === "inputs") {
    return ctx.inputs.map((i) =>
      withCounts({
        key: `input-${i.index}`,
        label: i.label,
        colorIndex: i.index,
        includes: (r) => r.input === i.index,
      }),
    );
  }
  if (split === "countries") {
    const all = countByCountry(ctx.allRows).filter((c) => c.key !== UNKNOWN_KEY);
    const slots = colorSlots(all);
    const top = all.slice(0, 5).map((c) => c.key);
    const specs = top.map((code) =>
      withCounts({
        key: `country-${code}`,
        label: countryLabel(code),
        colorIndex: slots.get(code) ?? 8,
        includes: (r) => r.country === code,
      }),
    );
    if (all.length > top.length) {
      specs.push(
        withCounts({
          key: "country-other",
          label: "Other countries",
          colorIndex: 8,
          includes: (r) => r.country !== null && !top.includes(r.country),
        }),
      );
    }
    return specs;
  }
  if (split === "sentiment") {
    // Sentiment as lines counts each sentiment's records; a share metric would be trivially 0/1.
    return [
      {
        key: "positive",
        label: "Positive",
        colorIndex: 0,
        includes: (r) => r.sentiment === "positive",
      },
      {
        key: "negative",
        label: "Negative",
        colorIndex: 1,
        includes: (r) => r.sentiment === "negative",
      },
      {
        key: "neutral",
        label: "Neutral",
        colorIndex: 8,
        includes: (r) => r.sentiment === "neutral",
      },
    ];
  }
  return [withCounts({ key: "total", label: "All records", colorIndex: 0, includes: () => true })];
}

/** The bucket with the most records of the first series, or null without data. */
export function busiest(series: readonly Series[]): { label: string; value: number } | null {
  const points = series[0]?.points ?? [];
  let best: { label: string; value: number } | null = null;
  for (const p of points)
    if (!best || p.value > best.value) best = { label: p.label, value: p.value };
  return best && best.value > 0 ? best : null;
}
