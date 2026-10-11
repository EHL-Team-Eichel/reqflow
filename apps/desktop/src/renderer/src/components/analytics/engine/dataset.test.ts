import { describe, expect, it } from "vitest";
import { buildDataset, yearOfHeader } from "./dataset";
import { feedbackData, readyInput, salesData, SAMPLE_ROWS } from "./fixtures";
import type { AnalyticsInput } from "./types";

const NOW = Date.UTC(2026, 9, 11);

describe("buildDataset", () => {
  const dataset = buildDataset([readyInput(0, "F70", feedbackData(SAMPLE_ROWS))], { now: NOW });

  it("detects country, time, person and sentiment columns and says so", () => {
    expect(dataset.countryColumn).toBe("Country");
    expect(dataset.timeColumn).toBe("Date");
    expect(dataset.idColumn).toBe("ID");
    expect(dataset.sentimentColumn).toBe("Feedback Type");
    expect(dataset.textual).toBe(true);
    expect(dataset.notes.join(" ")).toMatch(/Country from the column "Country"/);
    expect(dataset.notes.join(" ")).toMatch(
      /Time from the column "Date" \(12 of 12 records dated\)/,
    );
    const roles = Object.fromEntries(dataset.columns.map((c) => [c.name, c.role]));
    expect(roles["Customer Feedback"]).toBe("text");
    expect(roles.Brand).toBe("other"); // one value only: not a dimension
    expect(dataset.categoryColumns[0]).toBe("Feedback Type");
    expect(dataset.categoryColumns).toContain("Engine Type");
  });

  it("normalises countries and keeps records without one as unknown", () => {
    const codes = dataset.rows.map((r) => r.country);
    expect(codes.filter((c) => c === "DE")).toHaveLength(6); // "Germany" became DE
    expect(codes).toContain(null);
  });

  it("parses times in UTC and counts people by ID", () => {
    expect(dataset.rows[0]!.time).toBe(Date.UTC(2025, 0, 10));
    const people = new Set(dataset.rows.map((r) => r.person));
    expect(people.size).toBe(11); // A1 wrote twice
  });

  it("takes sentiment from the classification column, majority wins, a tie is neutral", () => {
    expect(dataset.rows[0]!.sentiment).toBe("negative");
    expect(dataset.rows[0]!.sentimentFrom).toBe("column");
    expect(dataset.rows[1]!.sentiment).toBe("positive");
    expect(dataset.rows[3]!.sentiment).toBe("neutral"); // Suggestion
    expect(dataset.rows[11]!.sentiment).toBe("neutral"); // Complaint + Praise
  });

  it("tags topics by the rule lexicon", () => {
    expect(dataset.rows[0]!.topics).toContain("seats");
    expect(dataset.rows[2]!.topics).toContain("noise");
  });

  it("uses the user's column names when given, and notes unknown ones", () => {
    const custom = buildDataset([readyInput(0, "F70", feedbackData(SAMPLE_ROWS))], {
      countryColumn: "engine type",
      timeColumn: "Nope",
      now: NOW,
    });
    expect(custom.countryColumn).toBe("Engine Type");
    expect(custom.timeColumn).toBe("Date");
    expect(custom.notes.join(" ")).toMatch(/no column "Nope"/);
  });

  it("works without a time column and says the timeline will fill in later", () => {
    const undated = buildDataset(
      [readyInput(0, "F70", feedbackData(SAMPLE_ROWS.map(({ date: _d, ...r }) => r)))],
      { now: NOW },
    );
    expect(undated.timeColumn).toBeNull();
    expect(undated.rows.every((r) => r.time === null)).toBe(true);
    expect(undated.notes.join(" ")).toMatch(/No time column yet/);
  });

  it("finds a date column by its values even with an unusual name", () => {
    const odd = buildDataset(
      [readyInput(0, "F70", feedbackData(SAMPLE_ROWS, { dateHeader: "Eingang" }))],
      { now: NOW },
    );
    expect(odd.timeColumn).toBe("Eingang");
  });

  it("reads year columns of a sales table as a time series with plans", () => {
    const sales = buildDataset([readyInput(0, "Sales", salesData())], { now: NOW });
    expect(sales.textual).toBe(false);
    expect(sales.countryColumn).toBe("market_code");
    expect(sales.yearSeries).toHaveLength(9);
    const de2030 = sales.yearSeries.find((p) => p.country === "DE" && p.year === 2030)!;
    expect(de2030).toMatchObject({ value: 150, planned: true });
    expect(sales.yearSeries.find((p) => p.year === 2025)!.planned).toBe(false);
    expect(sales.rows.every((r) => r.topics.length === 0 && r.sentiment === "neutral")).toBe(true);
  });

  it("keeps inputs apart and skips the ones that aren't ready", () => {
    const inputs: AnalyticsInput[] = [
      readyInput(0, "A", feedbackData(SAMPLE_ROWS.slice(0, 4), { source: "a" })),
      { index: 1, port: "in-1", label: "B", status: "needs_run", data: null, message: "run" },
      readyInput(2, "C", feedbackData(SAMPLE_ROWS.slice(4, 6), { source: "c" })),
    ];
    const ds = buildDataset(inputs, { now: NOW });
    expect(ds.inputs.map((i) => [i.label, i.records])).toEqual([
      ["A", 4],
      ["B", 0],
      ["C", 2],
    ]);
    expect(ds.rows.filter((r) => r.input === 2)).toHaveLength(2);
  });

  it("returns an empty dataset without notes when nothing arrived", () => {
    const empty = buildDataset([], { now: NOW });
    expect(empty.rows).toEqual([]);
    expect(empty.notes).toEqual([]);
  });

  it("reads years from headers", () => {
    expect(yearOfHeader("volume_2024")).toBe(2024);
    expect(yearOfHeader("Sales 2030")).toBe(2030);
    expect(yearOfHeader("ID")).toBeNull();
    expect(yearOfHeader("code12345")).toBeNull();
  });
});
