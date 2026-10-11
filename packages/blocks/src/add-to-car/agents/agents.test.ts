import type { DecisionAnswer } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { context, dataset } from "../test-helpers";
import {
  combineConfidence,
  evidenceLevel,
  priorityForRank,
  type EvidenceFacts,
} from "./confidence";
import { contextProfile, salesDigest } from "./context";
import { findVerbatim, openingExcerpt, prepareEvidence, sampleEvenly } from "./evidence";
import { batchRecords, toFinding } from "./pipeline";

describe("verbatim quotes", () => {
  const text = "The rear seats are  too cramped — my kids’ knees touch the seat.";
  it("finds what models change when quoting and returns the original characters", () => {
    expect(findVerbatim(text, "rear seats are  too cramped")).toBe("rear seats are  too cramped");
    expect(findVerbatim(text, "“THE REAR SEATS ARE TOO CRAMPED”")).toBe(
      "The rear seats are  too cramped",
    );
    expect(findVerbatim(text, "my kids' knees touch")).toBe("my kids’ knees touch");
    expect(findVerbatim(text, "…too cramped - my kids")).toBe("too cramped — my kids");
  });
  it("refuses quotes that aren't in the text", () => {
    expect(findVerbatim(text, "the seats feel like a prison")).toBeNull();
    expect(findVerbatim(text, "ab")).toBeNull();
  });
  it("falls back to the opening words, cut at a word boundary", () => {
    expect(openingExcerpt("Short text.")).toBe("Short text.");
    const long = `${"word ".repeat(100)}end`;
    const cut = openingExcerpt(long, 50);
    expect(long.startsWith(cut)).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(50);
    expect(cut.endsWith(" ")).toBe(false);
  });
});

describe("preparing the evidence", () => {
  const rows = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({
      text: `${prefix} comment number ${i + 1} about the seats.`,
      fields: {
        ID: `X${i}`,
        Country: i % 2 ? "DE" : "FR",
        "Feedback Type": `Topic ${i % 3}`,
        Comment: `${prefix} comment number ${i + 1} about the seats.`,
      },
    }));
  it("counts an item once, on its most important input, and keeps hint columns only", () => {
    const a = dataset("a", "customer_feedback", rows(6, "A"));
    const prepared = prepareEvidence([
      { port: "in-1", rank: 2, label: "2. Priority", data: a },
      { port: "in-0", rank: 1, label: "1. Priority", data: a },
    ]);
    expect(prepared.records).toHaveLength(6);
    expect(prepared.records.every((r) => r.rank === 1)).toBe(true);
    expect(prepared.notes.join(" ")).toMatch(/6 item\(s\) arrived on more than one input/);
    const keys = prepared.records[0]!.hints.map(([k]) => k);
    expect(keys).toContain("Country");
    expect(keys).toContain("Feedback Type");
    expect(keys).not.toContain("ID"); // unique per row
    expect(keys).not.toContain("Comment"); // the text itself
  });
  it("doesn't read records an upstream finding already covers", () => {
    const a = dataset("a", "customer_feedback", rows(3, "A"));
    a.findings.push({
      id: "fnd_up",
      kind: "complaint",
      statement: "Seats are hard.",
      category: "comfort",
      evidence: [{ sourceId: "src_a", recordId: "rec_a_1", excerpt: "A comment" }],
      mentions: 1,
      markets: [],
      confidence: 0.9,
      inScope: true,
    });
    const prepared = prepareEvidence([{ port: "in-0", rank: 1, label: "1. Priority", data: a }]);
    expect(prepared.records.map((r) => r.record.id)).toEqual(["rec_a_2", "rec_a_3"]);
    expect(prepared.upstream.map((u) => u.finding.id)).toEqual(["fnd_up"]);
  });
  it("samples evenly and batches without mixing inputs", () => {
    expect(sampleEvenly([1, 2, 3, 4, 5, 6, 7, 8], 4)).toEqual([1, 3, 5, 7]);
    const prepared = prepareEvidence([
      {
        port: "in-0",
        rank: 1,
        label: "1. Priority",
        data: dataset("a", "customer_feedback", rows(60, "A")),
      },
      {
        port: "in-1",
        rank: 2,
        label: "2. Priority",
        data: dataset("b", "customer_feedback", rows(3, "B")),
      },
    ]);
    const batches = batchRecords(prepared.records);
    expect(batches.map((b) => b.length)).toEqual([50, 10, 3]);
    for (const b of batches) expect(new Set(b.map((r) => r.rank)).size).toBe(1);
  });
});

describe("context inputs", () => {
  it("summarizes wide sales volumes with exact totals, shares and planned change", () => {
    const sales = dataset("sales", "sales_volume", [
      {
        text: "Germany",
        fields: {
          market: "Germany",
          market_code: "DE",
          volume_2024: "1.000",
          volume_2025: 900,
          volume_2030: 1200,
        },
      },
      {
        text: "France",
        fields: {
          market: "France",
          market_code: "FR",
          volume_2024: 500,
          volume_2025: 600,
          volume_2030: 600,
        },
      },
    ]);
    const digest = salesDigest(sales)!;
    expect(digest.sheets).toBe(1);
    const text = digest.facts.join("\n");
    expect(text).toContain(
      "total 2024 1,500 · 2025 1,500 (±0 % vs 2024) · 2030 plan 1,800 (+20 % vs 2025)",
    );
    expect(text).toContain("share of 2025 volume — Germany (DE) 60 %, France (FR) 40 %");
    expect(text).toContain("change 2024→2025 — Germany (DE) −10 %, France (FR) +20 %");
    expect(text).toMatch(
      /plan 2025→2030 — Germany \(DE\) \+33 %, France \(FR\) ±0 % \(2030 is a plan figure/,
    );
  });
  it("reads long-format volumes and refuses data that isn't volumes per period", () => {
    const long = dataset("long", "sales_volume", [
      { text: "a", fields: { Year: 2023, Market: "US", Units: 10 } },
      { text: "b", fields: { Year: 2024, Market: "US", Units: 15 } },
    ]);
    expect(salesDigest(long)!.facts[0]).toContain("total 2023 10 · 2024 15 (+50 % vs 2023)");
    const notSales = dataset("fb", "customer_feedback", [
      { text: "Nice car", fields: { Comment: "Nice car" } },
    ]);
    expect(salesDigest(notSales)).toBeNull();
  });
  it("profiles unknown context with columns and citable samples", () => {
    const study = dataset("study", "customer_study", [
      { text: "Seats: 4.1", fields: { Attribute: "Seats", Score: 4.1 } },
      { text: "Boot: 3.2", fields: { Attribute: "Boot", Score: 3.2 } },
    ]);
    const { profile, samples } = contextProfile(study);
    expect(profile).toContain('column "Score": numbers 3–4, mean 4');
    expect(profile).toContain('column "Attribute": 2 distinct values');
    expect(samples.map((s) => s.handle)).toEqual(["k1", "k2"]);
  });
});

describe("priority, evidence level and confidence", () => {
  it("maps the input rank onto must / should / could, never won't", () => {
    expect([1, 2, 3].map((r) => priorityForRank(r, 3))).toEqual(["must", "should", "could"]);
    expect([1, 2, 3, 4, 5].map((r) => priorityForRank(r, 5))).toEqual([
      "must",
      "must",
      "should",
      "should",
      "could",
    ]);
    expect(priorityForRank(1, 1)).toBe("must");
    expect(priorityForRank(10, 10)).toBe("could");
    expect([1, 2].map((r) => priorityForRank(r, 2))).toEqual(["must", "should"]);
  });

  const facts = (patch: Partial<EvidenceFacts> = {}): EvidenceFacts => ({
    mentions: 12,
    sources: 1,
    quantitative: false,
    forwardOnly: false,
    conflictingMentions: 0,
    ...patch,
  });
  it("derives the evidence level from the evidence, not from the model", () => {
    expect(evidenceLevel(facts({ sources: 2, quantitative: true }))).toBe("A");
    expect(evidenceLevel(facts({ sources: 2 }))).toBe("B");
    expect(evidenceLevel(facts({ mentions: 12 }))).toBe("B");
    expect(evidenceLevel(facts({ mentions: 3 }))).toBe("C");
    expect(evidenceLevel(facts({ forwardOnly: true, sources: 3, quantitative: true }))).toBe("D");
  });

  const judged = (support: number): Record<string, DecisionAnswer> => ({
    support: { type: "noul", value: support },
    scope: { type: "noul", value: 0.95 },
    durability: { type: "score", score: 3, probabilities: [0, 0, 0, 1, 0], confidence: 1 },
    clarity: { type: "score", score: 2, probabilities: [0, 0, 1, 0], confidence: 1 },
  });
  it("lets one weak ingredient pull the whole confidence down", () => {
    const strong = combineConfidence({
      answers: judged(0.95),
      judgeModel: "jev",
      evidence: facts(),
      outcome: "accepted",
    });
    const unsupported = combineConfidence({
      answers: judged(0.1),
      judgeModel: "jev",
      evidence: facts(),
      outcome: "accepted",
    });
    expect(strong.level).toBe("high");
    expect(unsupported.level).toBe("low");
    expect(unsupported.value).toBeLessThan(strong.value - 0.3);
    const flagged = combineConfidence({
      answers: judged(0.95),
      judgeModel: "jev",
      evidence: facts(),
      outcome: "flagged",
    });
    expect(flagged.value).toBeLessThan(strong.value);
  });
  it("says so when the judge couldn't answer", () => {
    const c = combineConfidence({
      answers: null,
      judgeModel: "jev",
      evidence: facts(),
      outcome: "accepted",
    });
    expect(c.signals.map((s) => s.key)).toEqual(["breadth", "agreement", "conflicts", "judge"]);
    expect(c.value).toBeGreaterThan(0);
    expect(c.value).toBeLessThan(1);
  });
});

describe("toFinding (quote handling WS8)", () => {
  const c = context({} as any);
  const makeItem = (id: string, text: string) => ({
    record: { id: `rec_${id}`, sourceId: "src_1", text, locator: "row 1" },
    sourceKind: "customer_feedback" as const,
    rank: 1,
    hints: [] as [string, string][],
    group: "g",
  });

  it("cites verbatim quote exactly as in record", () => {
    const item = makeItem("r1", "The steering feels sporty and direct.");
    const handles = new Map([["r1", item]]);
    const signal = {
      kind: "praise" as const,
      statement: "Sporty steering.",
      category: "driving_experience" as const,
      inScope: true,
      outOfScopeReason: "",
      refs: ["r1"],
      quotes: [{ ref: "r1", quote: "steering feels sporty and direct" }],
      sentiment: 0.8,
    };
    const res = toFinding(c.ctx, signal, handles);
    expect(res.finding).not.toBeNull();
    expect(res.citedInFull).toBe(0);
    expect(res.unverifiedDropped).toBe(0);
    expect(res.finding!.evidence[0]!.excerpt).toBe("steering feels sporty and direct");
    expect(res.finding!.confidence).toBe(0.8);
  });

  it("cites short record in full when quote is not verbatim", () => {
    const text = "Cup holders are too small.";
    const item = makeItem("r1", text);
    const handles = new Map([["r1", item]]);
    const signal = {
      kind: "complaint" as const,
      statement: "Small cup holders.",
      category: "space_practicality" as const,
      inScope: true,
      outOfScopeReason: "",
      refs: ["r1"],
      quotes: [{ ref: "r1", quote: "invented words not in text" }],
      sentiment: -0.6,
    };
    const res = toFinding(c.ctx, signal, handles);
    expect(res.finding).not.toBeNull();
    expect(res.citedInFull).toBe(1);
    expect(res.unverifiedDropped).toBe(0);
    expect(res.finding!.evidence[0]!.excerpt).toBe(text);
    expect(res.finding!.confidence).toBe(0.6);
  });

  it("drops citation when quote is not verbatim and record text exceeds MAX_EXCERPT_CHARS", () => {
    const longText = "Very long comment about hard seats. ".repeat(40); // > 1000 chars
    const item = makeItem("r1", longText);
    const handles = new Map([["r1", item]]);
    const signal = {
      kind: "complaint" as const,
      statement: "Hard seats.",
      category: "comfort" as const,
      inScope: true,
      outOfScopeReason: "",
      refs: ["r1"],
      quotes: [{ ref: "r1", quote: "invented words not in text" }],
      sentiment: -0.6,
    };
    const res = toFinding(c.ctx, signal, handles);
    expect(res.finding).toBeNull(); // No evidence left -> finding dropped
    expect(res.citedInFull).toBe(0);
    expect(res.unverifiedDropped).toBe(1);
  });

  it("cites unquoted refs in full if short, and drops them if too long", () => {
    const shortText = "Great head-up display.";
    const longText = "Very long text about display. ".repeat(40);
    const handles = new Map([
      ["r1", makeItem("r1", shortText)],
      ["r2", makeItem("r2", longText)],
    ]);
    const signal = {
      kind: "praise" as const,
      statement: "Head up display feedback.",
      category: "infotainment_digital" as const,
      inScope: true,
      outOfScopeReason: "",
      refs: ["r1", "r2"],
      quotes: [], // unquoted refs
      sentiment: 0.5,
    };
    const res = toFinding(c.ctx, signal, handles);
    expect(res.finding).not.toBeNull();
    expect(res.citedInFull).toBe(1);
    expect(res.unverifiedDropped).toBe(1);
    expect(res.finding!.evidence).toHaveLength(1);
    expect(res.finding!.evidence[0]!.excerpt).toBe(shortText);
  });
});
