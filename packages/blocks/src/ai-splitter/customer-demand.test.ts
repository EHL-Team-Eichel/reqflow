import type { SplitterSignal } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { calculateGroups, demandBand, stanceCounts, summarizeUnits } from "./customer-demand";
import type { PlannedGroup } from "./raw-protocol";

function signal(
  groupId: string,
  unitId: string,
  recordId: string,
  impact: number | null,
  stance: SplitterSignal["stance"] = "support",
): SplitterSignal & { needId: string } {
  return {
    groupId,
    needId: groupId,
    unitId,
    stance,
    impact,
    confidence: 0.9,
    evidence: { recordId, sourceId: "src_synthetic", excerpt: "synthetic" },
    reason: "Synthetic judgement",
  };
}
const plan: PlannedGroup[] = ["a", "b", "c"].map((id) => ({
  id,
  label: id,
  description: id,
  needIds: [id],
  reason: "Synthetic global plan",
}));

describe("code-only customer demand", () => {
  it.each([3, 5, 10])("uses inclusive equal-band boundaries for %i bands", (count) => {
    for (let i = 0; i < count; i++) {
      const min = (100 * (count - i - 1)) / count;
      expect(demandBand(min, count)).toBe(i);
      if (min > 0) expect(demandBand(min - 0.00001, count)).toBe(i + 1);
    }
    expect(demandBand(100, count)).toBe(0);
    expect(demandBand(0, count)).toBe(count - 1);
    expect(demandBand(null, count)).toBe(count - 1);
  });

  it("averages available supporting impact by unit, not by duplicated mentions; confidence never scales scores", () => {
    const signals = [
      signal("a", "u1", "rec_1", 100),
      signal("a", "u1", "rec_1copy", 100),
      signal("a", "u2", "rec_2", 50),
      signal("a", "u3", "rec_3", null),
      { ...signal("b", "u4", "rec_4", 0), confidence: 0.01 },
    ];
    const groups = calculateGroups(
      plan,
      signals,
      new Set(signals.map((s) => s.evidence.recordId)),
      5,
      true,
    );
    expect(groups[0]).toMatchObject({
      support: 3,
      frequency: 100,
      frequencyContribution: 70,
      impact: 75,
      impactContribution: 22.5,
      score: 92.5,
    });
    expect(groups[0]!.assumptions.join(" ")).toMatch(/1 supporting.*no expressed impact/);
    expect(groups[1]!.frequency).toBeCloseTo(100 / 3);
    expect(groups[1]!.score).toBeCloseTo(70 / 3);
    expect(groups[1]!.impact).toBe(0); // Explicitly neutral is not absent.
    expect(groups[2]).toMatchObject({ support: 0, frequency: 0, impact: null, score: null });
  });

  it("counts mixed stances in one feedback unit as unclear; context contributes neither counts nor impacts", () => {
    const signals = [
      signal("a", "same", "rec_s", 100),
      signal("a", "same", "rec_o", null, "opposition"),
      signal("a", "context", "rec_context", 100),
    ];
    const units = summarizeUnits(signals, new Set(["rec_s", "rec_o"]));
    expect(stanceCounts(units)).toEqual({ support: 0, opposition: 0, unclear: 1 });
    expect(calculateGroups(plan, signals, new Set(["rec_s", "rec_o"]), 3, true)[0]).toMatchObject({
      impact: null,
      frequency: null,
      score: null,
      scoreOrigin: "not_computed",
    });
  });

  it("keeps impact, score and routing unchanged after an exact reimport within a feedback unit", () => {
    const high = {
      ...signal("a", "original_provider_unit", "rec_high", 100),
      evidence: { sourceId: "src_original", recordId: "rec_high", excerpt: "Explicit inability" },
    };
    const neutral = {
      ...signal("a", "original_provider_unit", "rec_neutral", 0),
      evidence: {
        sourceId: "src_original",
        recordId: "rec_neutral",
        excerpt: "Explicitly neutral impact",
      },
    };
    const copy = {
      ...high,
      evidence: { ...high.evidence, sourceId: "src_reimport", recordId: "rec_high_copy" },
    };
    const summarize = (signals: (typeof high)[]) =>
      calculateGroups(
        plan,
        signals,
        new Set(signals.map((s) => s.evidence.recordId)),
        10,
        true,
      )[0]!;
    const before = summarize([high, neutral]);
    const after = summarize([high, neutral, copy]);
    expect(before).toMatchObject({ support: 1, impact: 50, score: 85, outputPortId: "out-1" });
    expect(after).toEqual(before);
  });

  it("keeps distinct canonical needs and distinct excerpts as independent observations within a unit", () => {
    const high = { ...signal("a", "same_unit", "rec_high", 100), needId: "need_a" };
    const neutral = { ...signal("a", "same_unit", "rec_neutral", 0), needId: "need_b" };
    const copy = { ...high, evidence: { ...high.evidence, recordId: "rec_copy" } };
    const additional = {
      ...high,
      evidence: {
        ...high.evidence,
        recordId: "rec_distinct_excerpt",
        excerpt: "Another explicitly expressed impact",
      },
    };
    const summarize = (signals: (typeof high)[]) =>
      calculateGroups(
        plan,
        signals,
        new Set(signals.map((s) => s.evidence.recordId)),
        10,
        true,
      )[0]!;
    expect(summarize([high, neutral, copy])).toMatchObject({ support: 1, impact: 50, score: 85 });
    expect(summarize([high, neutral, copy, additional]).impact).toBeCloseTo(200 / 3);
    expect(summarize([high, neutral, copy, additional]).score).toBe(90);
  });
});
