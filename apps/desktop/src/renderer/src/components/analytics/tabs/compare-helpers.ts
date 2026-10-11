import {
  compareFeatures,
  countByTopic,
  peopleCount,
  type Feature,
  type Segment,
} from "../engine/aggregate";
import { matchesPhrase, parsePhrase } from "../engine/text";
import { topicLabel } from "../engine/topics";
import type { AnalyticsRow } from "../engine/types";

/**
 * What the Compare tab compares: every topic, each sentiment and every tracked phrase is a yes/no
 * property of a record, compared as shares between segments (inputs, sources, countries, …).
 */
export function comparisonFeatures(
  rows: readonly AnalyticsRow[],
  phrases: readonly string[],
  textual: boolean,
): Feature[] {
  if (!textual) return [];
  const features: Feature[] = [
    { key: "sentiment:negative", label: "Negative", test: (r) => r.sentiment === "negative" },
    { key: "sentiment:positive", label: "Positive", test: (r) => r.sentiment === "positive" },
  ];
  for (const t of countByTopic(rows)) {
    features.push({
      key: `topic:${t.key}`,
      label: topicLabel(t.key),
      test: (r) => r.topics.includes(t.key),
    });
  }
  for (const phrase of phrases) {
    const query = parsePhrase(phrase);
    if (query) {
      features.push({
        key: `phrase:${phrase}`,
        label: `"${phrase}"`,
        test: (r) => matchesPhrase(r.text, query),
      });
    }
  }
  return features;
}

/**
 * The comparisons with the largest spread between segments first. A difference counts only when
 * at least one segment differs significantly from the rest (two-proportion z-test, p < 0.05, with
 * enough records); the others are listed after it, marked as not significant.
 */
export function biggestDifferences(segments: readonly Segment[], features: readonly Feature[]) {
  return compareFeatures(segments, features)
    .filter((c) => c.cells.some((cell) => cell.count > 0))
    .map((c) => ({ ...c, significant: c.cells.some((cell) => cell.vsRest.significant) }))
    .sort(
      (a, b) =>
        Number(b.significant) - Number(a.significant) ||
        b.spread - a.spread ||
        a.feature.label.localeCompare(b.feature.label),
    );
}

/** Headline numbers per segment for the side-by-side table. */
export function segmentSummary(segment: Segment) {
  const rows = segment.rows;
  const n = rows.length || 1;
  const countries = new Set(rows.map((r) => r.country).filter(Boolean)).size;
  const topTopic = countByTopic(rows)[0];
  const dated = rows.filter((r) => r.time !== null).length;
  return {
    records: rows.length,
    people: peopleCount(rows),
    countries,
    avgWords: rows.reduce((a, r) => a + r.words, 0) / n,
    negative: rows.filter((r) => r.sentiment === "negative").length / n,
    positive: rows.filter((r) => r.sentiment === "positive").length / n,
    topTopic: topTopic ? `${topicLabel(topTopic.key)} (${Math.round(topTopic.share * 100)}%)` : "–",
    dated: dated / n,
  };
}
