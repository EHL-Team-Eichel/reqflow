import { countryName, countryRegion } from "./countries";
import { matchesPhrase, parsePhrase, type PhraseQuery } from "./text";
import { bucketLabel, bucketRange, bucketStart } from "./time";
import { topicLabel } from "./topics";
import {
  SENTIMENTS,
  UNKNOWN_KEY,
  type AnalyticsDataset,
  type AnalyticsFilters,
  type AnalyticsRow,
  type CountRow,
  type Granularity,
  type Sentiment,
  type Series,
} from "./types";

/**
 * Counting, by rules only. Every function takes rows (already filtered) and returns plain numbers;
 * nothing is sampled or estimated except where a function says so (the significance test).
 */

/** Distinct people among rows: the ID column's values, plus one per row without an ID. */
export function peopleCount(rows: readonly AnalyticsRow[]): number {
  const people = new Set<string>();
  let anonymous = 0;
  for (const r of rows) {
    if (r.person === null) anonymous++;
    else people.add(r.person);
  }
  return people.size + anonymous;
}

/** Rows that pass every filter. A query that can't be parsed doesn't filter. */
export function applyFilters(
  rows: readonly AnalyticsRow[],
  filters: AnalyticsFilters,
): AnalyticsRow[] {
  const inputs = filters.inputs?.length ? new Set(filters.inputs) : null;
  const countries = filters.countries?.length ? new Set(filters.countries) : null;
  const sentiments = filters.sentiments?.length ? new Set(filters.sentiments) : null;
  const topics = filters.topics?.length ? new Set(filters.topics) : null;
  const query = filters.search ? parsePhrase(filters.search) : null;
  const from = filters.from ?? null;
  const to = filters.to ?? null;
  return rows.filter(
    (r) =>
      (!inputs || inputs.has(r.input)) &&
      (!countries || countries.has(r.country ?? UNKNOWN_KEY)) &&
      (!sentiments || sentiments.has(r.sentiment)) &&
      (!topics || r.topics.some((t) => topics.has(t))) &&
      (from === null || (r.time !== null && r.time >= from)) &&
      (to === null || (r.time !== null && r.time < to)) &&
      (!query || matchesPhrase(r.text, query)),
  );
}

type KeyOf = (row: AnalyticsRow) => string | readonly string[] | null;

/**
 * Records (and people) per key. A row with several keys (topics, list values) counts once under
 * each; a row with none counts under UNKNOWN_KEY when `includeUnknown` is set. Sorted by count,
 * then label, so the order is stable.
 */
export function countBy(
  rows: readonly AnalyticsRow[],
  keyOf: KeyOf,
  labelOf: (key: string) => string = (k) => k,
  includeUnknown = true,
): CountRow[] {
  const groups = new Map<string, AnalyticsRow[]>();
  for (const r of rows) {
    const raw = keyOf(r);
    const keys = raw === null ? [] : typeof raw === "string" ? [raw] : raw;
    if (!keys.length) {
      if (!includeUnknown) continue;
      const list = groups.get(UNKNOWN_KEY) ?? [];
      list.push(r);
      groups.set(UNKNOWN_KEY, list);
      continue;
    }
    for (const key of new Set(keys)) {
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
  }
  const total = rows.length || 1;
  return [...groups.entries()]
    .map(([key, list]) => ({
      key,
      label: key === UNKNOWN_KEY ? "Unknown" : labelOf(key),
      count: list.length,
      share: list.length / total,
      people: peopleCount(list),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export const countryLabel = (key: string) =>
  key === UNKNOWN_KEY ? "No country" : countryName(key);

export function countByCountry(rows: readonly AnalyticsRow[]): CountRow[] {
  return countBy(rows, (r) => r.country, countryLabel).map((c) =>
    c.key === UNKNOWN_KEY ? { ...c, label: "No country" } : c,
  );
}

export function countByRegion(rows: readonly AnalyticsRow[]): CountRow[] {
  return countBy(rows, (r) => (r.country ? countryRegion(r.country) : null));
}

export function countByTopic(rows: readonly AnalyticsRow[]): CountRow[] {
  return countBy(rows, (r) => r.topics, topicLabel, false);
}

export function countByCategory(rows: readonly AnalyticsRow[], column: string): CountRow[] {
  return countBy(rows, (r) => r.categories[column] ?? null);
}

/** Positive, neutral, negative — always all three, in that order, so colours never move. */
export function sentimentSplit(rows: readonly AnalyticsRow[]): Record<Sentiment, number> {
  const split: Record<Sentiment, number> = { positive: 0, neutral: 0, negative: 0 };
  for (const r of rows) split[r.sentiment]++;
  return split;
}

/** Stable colour slots for the keys of a dimension, by their count in ALL rows (not filtered). */
export function colorSlots(counts: readonly CountRow[], slots = 8): Map<string, number> {
  const map = new Map<string, number>();
  counts
    .filter((c) => c.key !== UNKNOWN_KEY)
    .slice(0, slots)
    .forEach((c, i) => map.set(c.key, i));
  return map;
}

/** Earliest and latest time among rows, or null when none is dated. */
export function timeExtent(rows: readonly AnalyticsRow[]): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    if (r.time === null) continue;
    if (r.time < min) min = r.time;
    if (r.time > max) max = r.time;
  }
  return Number.isFinite(min) ? [min, max] : null;
}

export type SeriesMetric = "records" | "people" | "share";

export interface SeriesSpec {
  key: string;
  label: string;
  colorIndex: number;
  /** Which rows belong to this line. */
  includes: (row: AnalyticsRow) => boolean;
  /** For metric "share": the rows counted in the numerator (e.g. mentions a phrase). */
  counts?: (row: AnalyticsRow) => boolean;
}

/**
 * One line per spec over contiguous time buckets (empty buckets are 0). Metrics: records, people,
 * or share = rows matching `counts` ÷ rows of the line in that bucket (0 when the bucket is empty).
 */
export function timeSeries(
  rows: readonly AnalyticsRow[],
  granularity: Granularity,
  specs: readonly SeriesSpec[],
  metric: SeriesMetric = "records",
): Series[] {
  const extent = timeExtent(rows);
  if (!extent) return [];
  const buckets = bucketRange(extent[0], extent[1], granularity);
  const index = new Map(buckets.map((t, i) => [t, i]));
  return specs.map((spec) => {
    const denominators = buckets.map(() => [] as AnalyticsRow[]);
    for (const r of rows) {
      if (r.time === null || !spec.includes(r)) continue;
      const i = index.get(bucketStart(r.time, granularity));
      if (i !== undefined) denominators[i]!.push(r);
    }
    return {
      key: spec.key,
      label: spec.label,
      colorIndex: spec.colorIndex,
      points: buckets.map((t, i) => {
        const list = denominators[i]!;
        const value =
          metric === "records"
            ? list.length
            : metric === "people"
              ? peopleCount(list)
              : list.length
                ? list.filter((r) => (spec.counts ? spec.counts(r) : true)).length / list.length
                : 0;
        return { t, label: bucketLabel(t, granularity), value };
      }),
    };
  });
}

/** Share of each row group's records per column key, for heatmaps (row = country, column = topic). */
export function crossTab(
  rows: readonly AnalyticsRow[],
  rowKeyOf: KeyOf,
  colKeyOf: KeyOf,
): {
  values: Record<string, Record<string, number>>;
  counts: Record<string, Record<string, number>>;
} {
  const totals = new Map<string, number>();
  const counts: Record<string, Record<string, number>> = {};
  const keysOf = (f: KeyOf, r: AnalyticsRow) => {
    const raw = f(r);
    return raw === null ? [] : typeof raw === "string" ? [raw] : [...new Set(raw)];
  };
  for (const r of rows) {
    for (const rk of keysOf(rowKeyOf, r)) {
      totals.set(rk, (totals.get(rk) ?? 0) + 1);
      const row = (counts[rk] ??= {});
      for (const ck of keysOf(colKeyOf, r)) row[ck] = (row[ck] ?? 0) + 1;
    }
  }
  const values: Record<string, Record<string, number>> = {};
  for (const [rk, row] of Object.entries(counts)) {
    const total = totals.get(rk) || 1;
    values[rk] = Object.fromEntries(Object.entries(row).map(([ck, n]) => [ck, n / total]));
  }
  return { values, counts };
}

/** What a phrase query found. */
export interface PhraseStats {
  query: PhraseQuery;
  matches: AnalyticsRow[];
  count: number;
  share: number; // of the rows searched
  people: number;
  peopleShare: number; // of the people among the rows searched
}

export function phraseStats(rows: readonly AnalyticsRow[], raw: string): PhraseStats | null {
  const query = parsePhrase(raw);
  if (!query) return null;
  const matches = rows.filter((r) => matchesPhrase(r.text, query));
  const people = peopleCount(matches);
  const allPeople = peopleCount(rows);
  return {
    query,
    matches,
    count: matches.length,
    share: rows.length ? matches.length / rows.length : 0,
    people,
    peopleShare: allPeople ? people / allPeople : 0,
  };
}

/** Standard normal cumulative distribution (Abramowitz–Stegun 7.1.26, error < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * Two-proportion z-test (pooled): is share x1/n1 different from x2/n2? Returns the two-sided p
 * value; `significant` at p < 0.05 and only with at least 5 expected hits and misses per group
 * (below that the normal approximation isn't trustworthy, and we say "too few" instead).
 */
export function compareShares(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): { delta: number; z: number; p: number; significant: boolean; enoughData: boolean } {
  const p1 = n1 ? x1 / n1 : 0;
  const p2 = n2 ? x2 / n2 : 0;
  const pooled = n1 + n2 ? (x1 + x2) / (n1 + n2) : 0;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / (n1 || 1) + 1 / (n2 || 1)));
  const z = se > 0 ? (p1 - p2) / se : 0;
  const p = se > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;
  const enoughData =
    n1 > 0 &&
    n2 > 0 &&
    Math.min(pooled * n1, (1 - pooled) * n1, pooled * n2, (1 - pooled) * n2) >= 5;
  return { delta: p1 - p2, z, p, significant: enoughData && p < 0.05, enoughData };
}

/** A group of rows to compare (an input, a source, a country, a category value). */
export interface Segment {
  key: string;
  label: string;
  colorIndex: number;
  rows: AnalyticsRow[];
}

export type CompareBy = "input" | "source" | "country" | `category:${string}`;

/** Splits rows into comparison segments; colours stay fixed per entity across filters. */
export function segmentsOf(
  dataset: AnalyticsDataset,
  rows: readonly AnalyticsRow[],
  by: CompareBy,
): Segment[] {
  if (by === "input") {
    return dataset.inputs.map((i) => ({
      key: String(i.index),
      label: i.label,
      colorIndex: i.index,
      rows: rows.filter((r) => r.input === i.index),
    }));
  }
  const keyOf: KeyOf =
    by === "source"
      ? (r) => r.sourceId
      : by === "country"
        ? (r) => r.country
        : (r) => r.categories[by.slice("category:".length)] ?? null;
  const all = countBy(dataset.rows, keyOf, (k) => k, false);
  const slots = colorSlots(all);
  const titles = new Map(dataset.rows.map((r) => [r.sourceId, r.sourceTitle]));
  return all.map((c) => ({
    key: c.key,
    label:
      by === "source"
        ? (titles.get(c.key) ?? c.key)
        : by === "country"
          ? countryLabel(c.key)
          : c.key,
    colorIndex: slots.get(c.key) ?? 8,
    rows: rows.filter((r) => {
      const k = keyOf(r);
      return k === null ? false : typeof k === "string" ? k === c.key : k.includes(c.key);
    }),
  }));
}

/** A yes/no property of a row that segments can be compared on (mentions a topic, is negative, …). */
export interface Feature {
  key: string;
  label: string;
  test: (row: AnalyticsRow) => boolean;
}

export interface FeatureComparison {
  feature: Feature;
  cells: {
    segment: string;
    count: number;
    share: number;
    /** Against all other segments together. */
    vsRest: ReturnType<typeof compareShares>;
  }[];
  /** Largest minus smallest share among segments with rows. */
  spread: number;
}

export function compareFeatures(
  segments: readonly Segment[],
  features: readonly Feature[],
): FeatureComparison[] {
  const totalRows = segments.reduce((n, s) => n + s.rows.length, 0);
  return features.map((feature) => {
    const hits = segments.map((s) => s.rows.filter(feature.test).length);
    const totalHits = hits.reduce((a, b) => a + b, 0);
    const cells = segments.map((s, i) => ({
      segment: s.key,
      count: hits[i]!,
      share: s.rows.length ? hits[i]! / s.rows.length : 0,
      vsRest: compareShares(
        hits[i]!,
        s.rows.length,
        totalHits - hits[i]!,
        totalRows - s.rows.length,
      ),
    }));
    const shares = cells.filter((_, i) => segments[i]!.rows.length > 0).map((c) => c.share);
    return {
      feature,
      cells,
      spread: shares.length ? Math.max(...shares) - Math.min(...shares) : 0,
    };
  });
}

/** One stage of a flow chart: what a row is at this step (Input → Country → Sentiment). */
export interface FlowStage {
  label: string;
  keyOf: (row: AnalyticsRow) => string | null;
  labelOf: (key: string) => string;
  colorOf: (key: string) => string;
}

/**
 * Nodes and links of a Sankey: every row walks through the stages; per stage only the `top` most
 * common keys get their own node, the rest join "Other", and rows without a key "Unknown".
 */
export function flowData(
  rows: readonly AnalyticsRow[],
  stages: readonly FlowStage[],
  top = 8,
): {
  nodes: { id: string; stage: number; label: string; color: string }[];
  links: { source: string; target: string; value: number }[];
} {
  const keep = stages.map((stage) => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = stage.keyOf(r) ?? UNKNOWN_KEY;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const ranked = [...counts.entries()]
      .filter(([k]) => k !== UNKNOWN_KEY)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { order: ranked.slice(0, top).map(([k]) => k), counts };
  });
  const nodeKey = (s: number, r: AnalyticsRow) => {
    const k = stages[s]!.keyOf(r) ?? UNKNOWN_KEY;
    if (k === UNKNOWN_KEY) return UNKNOWN_KEY;
    return keep[s]!.order.includes(k) ? k : "__other__";
  };
  const id = (s: number, k: string) => `${s}:${k}`;
  const links = new Map<string, { source: string; target: string; value: number }>();
  const used = stages.map(() => new Set<string>());
  for (const r of rows) {
    for (let s = 0; s < stages.length - 1; s++) {
      const a = nodeKey(s, r);
      const b = nodeKey(s + 1, r);
      used[s]!.add(a);
      used[s + 1]!.add(b);
      const key = `${id(s, a)}→${id(s + 1, b)}`;
      const link = links.get(key) ?? { source: id(s, a), target: id(s + 1, b), value: 0 };
      link.value++;
      links.set(key, link);
    }
  }
  const nodes = stages.flatMap((stage, s) =>
    [...keep[s]!.order, "__other__", UNKNOWN_KEY]
      .filter((k) => used[s]!.has(k))
      .map((k) => ({
        id: id(s, k),
        stage: s,
        label:
          k === "__other__"
            ? `Other (${keep[s]!.counts.size - keep[s]!.order.length - (keep[s]!.counts.has(UNKNOWN_KEY) ? 1 : 0)})`
            : k === UNKNOWN_KEY
              ? "Unknown"
              : stage.labelOf(k),
        color: k === "__other__" || k === UNKNOWN_KEY ? "var(--color-viz-other)" : stage.colorOf(k),
      })),
  );
  return { nodes, links: [...links.values()] };
}

/** Rows whose time is set, for the "dated" share in data quality. */
export function coverage(rows: readonly AnalyticsRow[]) {
  const n = rows.length || 1;
  const texts = new Map<string, number>();
  for (const r of rows) {
    const t = r.text.trim().toLowerCase();
    if (t) texts.set(t, (texts.get(t) ?? 0) + 1);
  }
  const duplicates = [...texts.values()].filter((c) => c > 1).reduce((a, c) => a + c - 1, 0);
  return {
    country: rows.filter((r) => r.country !== null).length / n,
    time: rows.filter((r) => r.time !== null).length / n,
    person: rows.filter((r) => r.person !== null).length / n,
    text: rows.filter((r) => r.words > 0).length / n,
    topic: rows.filter((r) => r.topics.length > 0).length / n,
    duplicates,
    avgWords: rows.reduce((a, r) => a + r.words, 0) / n,
    languages: countBy(rows, (r) => r.language),
  };
}

export { SENTIMENTS };
