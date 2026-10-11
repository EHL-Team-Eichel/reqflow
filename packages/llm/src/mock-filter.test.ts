import { defaultBlockParams } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { mockObject } from "./mock";

function prompt(texts: string[], changes = {}) {
  return JSON.stringify({
    contract: "reqflow.ai-filter.selection@1",
    configuration: { ...defaultBlockParams("ai_filter"), fields: [], ...changes },
    items: texts.map((text, i) => {
      const record = { id: `rec_${i}`, sourceId: "src_test", text };
      return {
        id: record.id,
        layer: "records",
        item: record,
        assessed: record,
        missingFields: false,
        context: { records: [record] },
      };
    }),
  });
}
describe("offline AI Filter protocol", () => {
  it("keeps mixed, positive, negative, conflicting and minority customer vocabulary with exact quotes", () => {
    const texts = [
      "Pricing is high but seats are great.",
      "Screen is poor.",
      "Most like seats, a minority dislike seats.",
    ];
    const result = mockObject(prompt(texts)) as any;
    expect(result.contract).toBe("reqflow.ai-filter.selection@1");
    expect(result.decisions.map((d: any) => d.decision)).toEqual(["keep", "keep", "keep"]);
    for (const [i, decision] of result.decisions.entries()) {
      expect(texts[i]!.includes(decision.quotes[0].excerpt)).toBe(true);
      expect(decision.reason).toContain("OFFLINE MOCK");
      expect(decision.item).toBeUndefined();
    }
  });
  it("excludes explicit unrelated topics, reviews unknowns and never guesses from IDs", () => {
    const result = mockObject(
      prompt(["Pricing and tax.", "Unknown synthetic topic.", "Unknown synthetic topic.", ""]),
    ) as any;
    expect(result.decisions.map((d: any) => d.decision)).toEqual([
      "exclude",
      "review",
      "review",
      "review",
    ]);
    expect(result.decisions[1].confidence).toBe(0);
    expect(result.decisions[3].quotes).toEqual([]);
  });
  it("does not exclude mixed driving experience or structured-only relevance", () => {
    expect(
      (mockObject(prompt(["Acceleration is excellent, but the price is high"])) as any).decisions[0]
        .decision,
    ).toBe("keep");
    const raw = JSON.parse(prompt(["Pricing is high"]));
    raw.items[0].item.fields = { feature: "seat comfort" };
    raw.items[0].context.records[0].fields = { feature: "seat comfort" };
    expect((mockObject(JSON.stringify(raw)) as any).decisions[0].decision).toBe("keep");
    expect(
      (mockObject(prompt(["The price of a potentially relevant unfamiliar aspect is high"])) as any)
        .decisions[0].decision,
    ).toBe("review");
  });
  it.each([
    { criterion: "Only blue vehicles" },
    { include: "quiet seats" },
    { exclude: "bad seats" },
    { examples: "Keep only quiet seats" },
  ])("reviews unsupported semantic configuration %j", (change) => {
    expect((mockObject(prompt(["Seats are great."], change)) as any).decisions[0].decision).toBe(
      "review",
    );
  });
  it("rejects missing/duplicate/oversized contract rather than silently truncating", () => {
    expect(() => mockObject(prompt(Array(21).fill("Seats.")))).toThrow("contract");
    expect(() => mockObject(prompt(["x".repeat(48000)]))).toThrow("oversized");
    const raw = JSON.parse(prompt(["Seats.", "Screen."]));
    raw.items[1] = raw.items[0];
    expect(() => mockObject(JSON.stringify(raw))).toThrow("duplicate");
    expect(() => mockObject(JSON.stringify({ contract: "reqflow.ai-filter.selection@1" }))).toThrow(
      "contract",
    );
  });
});
