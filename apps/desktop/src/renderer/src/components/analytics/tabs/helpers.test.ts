import { describe, expect, it } from "vitest";
import { segmentsOf, timeSeries } from "../engine/aggregate";
import { buildDataset } from "../engine/dataset";
import { feedbackData, readyInput, SAMPLE_ROWS } from "../engine/fixtures";
import { biggestDifferences, comparisonFeatures, segmentSummary } from "./compare-helpers";
import { busiest, timelineSpecs } from "./timeline-helpers";

const dataset = buildDataset(
  [
    readyInput(0, "A", feedbackData(SAMPLE_ROWS.slice(0, 8), { source: "a" })),
    readyInput(1, "B", feedbackData(SAMPLE_ROWS.slice(8), { source: "b" })),
  ],
  { now: Date.UTC(2026, 9, 11) },
);
const rows = dataset.rows;

describe("compare helpers", () => {
  it("compares sentiment, every topic and tracked phrases", () => {
    const features = comparisonFeatures(rows, ["seat*", "  "], true);
    const keys = features.map((f) => f.key);
    expect(keys.slice(0, 2)).toEqual(["sentiment:negative", "sentiment:positive"]);
    expect(keys).toContain("topic:seats");
    expect(keys).toContain("phrase:seat*");
    expect(keys).not.toContain("phrase:  ");
    expect(comparisonFeatures(rows, ["seat"], false)).toEqual([]);
  });

  it("orders differences: significant first, then by spread", () => {
    const segments = segmentsOf(dataset, rows, "input");
    const diffs = biggestDifferences(segments, comparisonFeatures(rows, [], true));
    for (let i = 1; i < diffs.length; i++) {
      const [a, b] = [diffs[i - 1]!, diffs[i]!];
      expect(Number(a.significant) >= Number(b.significant)).toBe(true);
      if (a.significant === b.significant) expect(a.spread).toBeGreaterThanOrEqual(b.spread);
    }
    // Twelve records are too few for the test: nothing may be called significant.
    expect(diffs.some((d) => d.significant)).toBe(false);
  });

  it("summarises a segment", () => {
    const [a] = segmentsOf(dataset, rows, "input");
    expect(segmentSummary(a!)).toMatchObject({ records: 8, people: 8, countries: 3 });
  });
});

describe("timeline helpers", () => {
  const ctx = { allRows: rows, inputs: dataset.inputs };

  it("splits by input with the inputs' colour slots", () => {
    const specs = timelineSpecs("inputs", "records", ctx);
    expect(specs.map((s) => [s.label, s.colorIndex])).toEqual([
      ["A", 0],
      ["B", 1],
    ]);
  });

  it("splits by the top countries plus the rest", () => {
    const specs = timelineSpecs("countries", "records", ctx);
    expect(specs.map((s) => s.label)).toEqual(["Germany", "United Kingdom", "France"]);
  });

  it("maps sentiment lines onto the matching hues and counts shares for share metrics", () => {
    const sentiment = timelineSpecs("sentiment", "records", ctx);
    expect(sentiment.map((s) => [s.key, s.colorIndex])).toEqual([
      ["positive", 0],
      ["negative", 1],
      ["neutral", 8],
    ]);
    const [total] = timelineSpecs("total", "negative", ctx);
    const [series] = timeSeries(rows, "month", [total!], "share");
    expect(series!.points[0]!.value).toBeCloseTo(0.5); // January: one complaint of two
  });

  it("finds the busiest bucket", () => {
    const [series] = timeSeries(rows, "month", timelineSpecs("total", "records", ctx));
    expect(busiest([series!])).toEqual({ label: "Mar 2025", value: 7 });
    expect(busiest([])).toBeNull();
  });
});
