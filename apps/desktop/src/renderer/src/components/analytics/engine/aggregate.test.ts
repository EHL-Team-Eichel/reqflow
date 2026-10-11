import { describe, expect, it } from "vitest";
import {
  applyFilters,
  compareFeatures,
  compareShares,
  countByCountry,
  countByTopic,
  crossTab,
  flowData,
  normalCdf,
  peopleCount,
  phraseStats,
  segmentsOf,
  sentimentSplit,
  timeSeries,
} from "./aggregate";
import { buildDataset } from "./dataset";
import { feedbackData, readyInput, SAMPLE_ROWS } from "./fixtures";
import { UNKNOWN_KEY } from "./types";

const NOW = Date.UTC(2026, 9, 11);
const dataset = buildDataset(
  [
    readyInput(0, "A", feedbackData(SAMPLE_ROWS.slice(0, 8), { source: "a" })),
    readyInput(1, "B", feedbackData(SAMPLE_ROWS.slice(8), { source: "b" })),
  ],
  { now: NOW },
);
const rows = dataset.rows;

describe("analytics counting", () => {
  it("counts people once per ID", () => {
    expect(rows).toHaveLength(12);
    expect(peopleCount(rows)).toBe(11);
  });

  it("counts countries with shares and an explicit unknown", () => {
    const counts = countByCountry(rows);
    expect(counts[0]).toMatchObject({ key: "DE", label: "Germany", count: 6, people: 5 });
    expect(counts[0]!.share).toBeCloseTo(0.5);
    expect(counts.find((c) => c.key === UNKNOWN_KEY)).toMatchObject({
      label: "No country",
      count: 1,
    });
  });

  it("counts a record once per topic it mentions", () => {
    const topics = countByTopic(rows);
    const seats = topics.find((t) => t.key === "seats")!;
    expect(seats.count).toBe(4);
    expect(topics.some((t) => t.key === UNKNOWN_KEY)).toBe(false);
  });

  it("filters by input, country, sentiment, time and phrase", () => {
    expect(applyFilters(rows, { inputs: [1] })).toHaveLength(4);
    expect(applyFilters(rows, { countries: ["GB"] })).toHaveLength(3);
    expect(applyFilters(rows, { countries: [UNKNOWN_KEY] })).toHaveLength(1);
    expect(applyFilters(rows, { sentiments: ["positive"] })).toHaveLength(3);
    expect(
      applyFilters(rows, { from: Date.UTC(2025, 2, 1), to: Date.UTC(2025, 3, 1) }),
    ).toHaveLength(7);
    expect(applyFilters(rows, { search: "seat | trunk" })).toHaveLength(5);
    expect(applyFilters(rows, { topics: ["noise"] }).length).toBeGreaterThanOrEqual(3);
  });

  it("splits sentiment in a fixed order", () => {
    expect(Object.keys(sentimentSplit(rows))).toEqual(["positive", "neutral", "negative"]);
    const split = sentimentSplit(rows);
    expect(split.positive + split.neutral + split.negative).toBe(12);
  });

  it("builds contiguous monthly series, records and shares", () => {
    const [all] = timeSeries(rows, "month", [
      { key: "all", label: "All", colorIndex: 0, includes: () => true },
    ]);
    expect(all!.points.map((p) => [p.label, p.value])).toEqual([
      ["Jan 2025", 2],
      ["Feb 2025", 3],
      ["Mar 2025", 7],
    ]);
    const [noise] = timeSeries(
      rows,
      "month",
      [
        {
          key: "noise",
          label: "Noise",
          colorIndex: 0,
          includes: () => true,
          counts: (r) => r.topics.includes("noise"),
        },
      ],
      "share",
    );
    expect(noise!.points[0]!.value).toBe(0);
    expect(noise!.points[1]!.value).toBeCloseTo(1 / 3);
  });

  it("cross-tabulates shares per row group", () => {
    const { values, counts } = crossTab(
      rows,
      (r) => r.country,
      (r) => r.topics,
    );
    expect(counts.GB!.noise).toBe(2);
    expect(values.GB!.noise).toBeCloseTo(2 / 3);
  });

  it("finds what people say with record and people shares", () => {
    const stats = phraseStats(rows, "seat*")!;
    expect(stats.count).toBe(4);
    expect(stats.share).toBeCloseTo(4 / 12);
    expect(stats.people).toBe(4);
    expect(phraseStats(rows, "   ")).toBeNull();
  });

  it("compares shares with a two-proportion z-test and refuses tiny samples", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    const big = compareShares(60, 100, 40, 100);
    expect(big.delta).toBeCloseTo(0.2);
    expect(big.p).toBeLessThan(0.01);
    expect(big.significant).toBe(true);
    const tiny = compareShares(2, 3, 0, 3);
    expect(tiny.enoughData).toBe(false);
    expect(tiny.significant).toBe(false);
  });

  it("segments by input with fixed colours and compares features against the rest", () => {
    const segments = segmentsOf(dataset, rows, "input");
    expect(segments.map((s) => [s.label, s.colorIndex, s.rows.length])).toEqual([
      ["A", 0, 8],
      ["B", 1, 4],
    ]);
    const [negative] = compareFeatures(segments, [
      { key: "neg", label: "Negative", test: (r) => r.sentiment === "negative" },
    ]);
    expect(negative!.cells.map((c) => c.count)).toEqual([4, 2]);
    expect(negative!.spread).toBeCloseTo(0);
    const byCountry = segmentsOf(dataset, rows, "country");
    expect(byCountry[0]!.key).toBe("DE");
    expect(segmentsOf(dataset, rows, "category:Feedback Type").map((s) => s.key)).toContain(
      "Complaint",
    );
  });

  it("builds flow-chart nodes and links that conserve records", () => {
    const flow = flowData(
      rows,
      [
        { label: "Input", keyOf: (r) => String(r.input), labelOf: (k) => k, colorOf: () => "red" },
        { label: "Country", keyOf: (r) => r.country, labelOf: (k) => k, colorOf: () => "blue" },
        { label: "Sentiment", keyOf: (r) => r.sentiment, labelOf: (k) => k, colorOf: () => "grey" },
      ],
      2,
    );
    const out = (stage: number) =>
      flow.links.filter((l) => l.source.startsWith(`${stage}:`)).reduce((a, l) => a + l.value, 0);
    expect(out(0)).toBe(12);
    expect(out(1)).toBe(12);
    const countryNodes = flow.nodes.filter((n) => n.stage === 1).map((n) => n.label);
    expect(countryNodes).toEqual(["DE", "GB", "Other (1)", "Unknown"]);
  });
});
