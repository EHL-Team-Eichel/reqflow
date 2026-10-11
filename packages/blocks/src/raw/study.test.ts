import { DEFAULT_SETTINGS } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { tableToRecords } from "./records";
import { customerStudyFindings } from "./study";
import { toTable } from "./table";

const scope = DEFAULT_SETTINGS.defaultScope; // 1 Series F70, EU

/** A synthetic report sheet: market labels over the vehicle columns, one section per figure row. */
function compare(figures: [string, number, number, number][], sheet = "CN_EU_2025") {
  const table = toTable([
    [null, "Synthetic study"],
    [null, "China", "EU", null, null],
    [
      figures[0]![0],
      "BMW 5 Series G68",
      "BMW 1 Series F70",
      "BMW 5 Series G60",
      "BMW 7 Series G70",
    ],
    ...figures.flatMap(([section, f70, g60, g70], i) => [
      ...(i === 0 ? [] : [[section]]),
      ["Share", 50, f70, g60, g70],
    ]),
  ]);
  const ingested = tableToRecords(table, {
    key: "synthetic-study",
    title: "Synthetic study",
    sheet,
    dataset: "customer_study",
    scope,
    retrievedAt: "2026-10-11T00:00:00.000Z",
    marketFilter: "all",
  });
  return { ...customerStudyFindings(table, ingested, scope, sheet), ingested };
}

describe("customer study comparisons", () => {
  it("reports gaps of ten points or more against the same market's models, with the right direction", () => {
    const { findings, notes } = compare([
      ["Rear space", 40, 60, 62],
      ["Display", 80, 66, 68],
      ["Seats", 55, 58, 60],
    ]);
    expect(findings.map((f) => f.statement)).toEqual([
      'Customer study: F70 is 21 points below G60 and G70 on "Rear space – Share" in EU (40 vs 61).',
      'Customer study: F70 is 13 points above G60 and G70 on "Display – Share" in EU (80 vs 67).',
    ]);
    expect(notes.join("\n")).toContain("on 3 figures; 2 differ by ≥ 10 points.");
    expect(findings.every((f) => f.sentiment === undefined)).toBe(true);
  });

  it("compares a 1–10 rating relative to the other models, not in points", () => {
    const { findings, notes } = compare([
      ["Comfort", 6.1, 7.4, 7.6],
      ["Quietness", 7.2, 7.3, 7.5],
      ["Handling", 8.1, 8, 8.2],
    ]);
    expect(findings.map((f) => f.statement)).toEqual([
      'Customer study: F70 is 19 % below G60 and G70 on "Comfort – Share" in EU (6.1 vs 7.5).',
    ]);
    expect(notes.join("\n")).toContain("1 differs by ≥ 10 %.");
  });

  it("cites the target cell verbatim from its record", () => {
    const { findings, ingested } = compare([["Rear space", 40, 60, 62]]);
    const [evidence] = findings[0]!.evidence;
    const record = ingested.records.find((r) => r.id === evidence!.recordId)!;
    expect(record.text).toContain(evidence!.excerpt);
    expect(evidence!.excerpt).toContain("F70");
  });
});
