import { describe, expect, it } from "vitest";
import { ALLOWED_DECISIONS, RequirementDecision, RequirementEdit, decisionProblem } from "./api";
import { fixtureRequirements } from "./fixtures";
import { DecisionStatus, aiProposalProblem, type Requirement } from "./requirement";
import { inMarket, vehicleCodeFor } from "./scope";
import {
  ScoreFactor,
  describeDrivers,
  rescoreBreakdown,
  scoreFlags,
  topDrivers,
  type ScoreBreakdown,
} from "./scoring";
import { DEFAULT_SETTINGS } from "./settings";

const { thresholds, weights } = DEFAULT_SETTINGS.scoring;

function breakdown(values: Record<ScoreFactor, number>): ScoreBreakdown {
  return {
    factors: Object.fromEntries(
      ScoreFactor.options.map((f) => [f, { value: values[f], weight: weights[f], note: "n" }]),
    ) as ScoreBreakdown["factors"],
    total: 0,
    suggestedPriority: "wont",
    method: "test@1",
    scoredAt: "2026-10-11T00:00:00.000Z",
  };
}
const values = {
  customer_impact: 5,
  evidence_strength: 4,
  competitive_gap: 0,
  trend_momentum: 1,
  brand_fit: 3,
  ease: 2,
};

describe("score flags and drivers", () => {
  it("flags a must/should score on C or D evidence, not on A/B or a low score", () => {
    expect(scoreFlags(thresholds.should, "C", thresholds)).toEqual(["high_score_weak_evidence"]);
    expect(scoreFlags(90, "D", thresholds)).toEqual(["high_score_weak_evidence"]);
    expect(scoreFlags(90, "B", thresholds)).toEqual([]);
    expect(scoreFlags(thresholds.should - 0.1, "D", thresholds)).toEqual([]);
    expect(scoreFlags(90, undefined, thresholds)).toEqual([]);
  });

  it("names the factors that add most (weight × value) and skips zero contributions", () => {
    const s = breakdown(values);
    expect(topDrivers(s)).toEqual(["customer_impact", "evidence_strength"]);
    expect(topDrivers(s, 10)).not.toContain("competitive_gap");
    expect(describeDrivers(s)).toBe(
      "customer impact 5/5 (weight 3) and evidence strength 4/5 (weight 2)",
    );
    expect(describeDrivers(breakdown({ ...values, ...zero() }))).toBe(
      "no factor adds to the score",
    );
  });

  it("rescoring keeps values and notes and applies new weights, band and flags", () => {
    const s = breakdown(values);
    const heavyGap = { ...weights, customer_impact: 0, evidence_strength: 0, competitive_gap: 10 };
    const a = rescoreBreakdown(s, { weights, thresholds }, "C", "2026-10-12T00:00:00.000Z");
    const b = rescoreBreakdown(
      s,
      { weights: heavyGap, thresholds },
      "C",
      "2026-10-12T00:00:00.000Z",
    );
    expect(a.factors.customer_impact).toEqual({ value: 5, weight: 3, note: "n" });
    expect(b.factors.competitive_gap.weight).toBe(10);
    expect(b.total).toBeLessThan(a.total);
    expect(a.suggestedPriority).toBe("should");
    expect(a.flags).toEqual(["high_score_weak_evidence"]);
    expect(b.flags).toEqual([]);
    expect(b.scoredAt).toBe("2026-10-12T00:00:00.000Z");
  });
});

function zero() {
  return Object.fromEntries(ScoreFactor.options.map((f) => [f, 0])) as Record<ScoreFactor, number>;
}

describe("human decisions", () => {
  it("decided requirements must be reopened first; every status allows something", () => {
    expect(decisionProblem("proposed", "approve")).toBeNull();
    expect(decisionProblem("approved", "reject")).toMatch(/allowed: reopen/);
    expect(decisionProblem("rejected", "approve")).not.toBeNull();
    expect(decisionProblem("approved", "reopen")).toBeNull();
    for (const status of DecisionStatus.options)
      expect(ALLOWED_DECISIONS[status].length).toBeGreaterThan(0);
  });

  it("a priority override only comes with an approval", () => {
    expect(
      RequirementDecision.safeParse({ decision: "approve", rationale: "ok!", priority: "must" })
        .success,
    ).toBe(true);
    expect(
      RequirementDecision.safeParse({ decision: "reject", rationale: "no!", priority: "must" })
        .success,
    ).toBe(false);
  });

  it("an edit can't remove the last measurable target", () => {
    expect(RequirementEdit.safeParse({ targets: [], rationale: "drop all" }).success).toBe(false);
    expect(
      RequirementEdit.safeParse({
        targets: [{ metric: "m", target: "t", acceptance: "a" }],
        rationale: "tighten",
      }).success,
    ).toBe(true);
  });
});

describe("AI proposals", () => {
  const base = {
    ...fixtureRequirements[0]!,
    version: 1,
    status: "proposed",
    createdBy: { type: "ai", component: "add_to_car", model: "mock" },
  } as Requirement;
  it("accepts a new proposed requirement with a target", () => {
    expect(base.targets.length).toBeGreaterThan(0);
    expect(aiProposalProblem(base)).toBeNull();
  });
  it("refuses decided statuses, later versions, human authors and missing targets", () => {
    expect(aiProposalProblem({ ...base, status: "approved" })).toMatch(/only propose/);
    expect(aiProposalProblem({ ...base, version: 2 })).toMatch(/version 1/);
    expect(
      aiProposalProblem({ ...base, createdBy: { type: "human", userId: "u", name: "PM" } }),
    ).toMatch(/human/);
    expect(aiProposalProblem({ ...base, targets: [] })).toMatch(/target/);
  });
});

describe("markets", () => {
  it("places countries in briefing markets and keeps unknown codes unknown", () => {
    expect(inMarket("DE", "EU")).toBe(true);
    expect(inMarket("uk", "EU")).toBe(true);
    expect(inMarket("EU", "EU")).toBe(true);
    expect(inMarket("US", "EU")).toBe(false);
    expect(inMarket("CN", "EU")).toBe(false);
    expect(inMarket("HK", "CN")).toBe(true);
    expect(inMarket("ZZ", "EU")).toBeUndefined();
    expect(inMarket("", "EU")).toBeUndefined();
    expect(inMarket(undefined, "EU")).toBeUndefined();
  });
  it("maps briefing vehicle lines to requirement-id codes, per market", () => {
    expect(vehicleCodeFor("1 Series", "EU")).toBe("F70");
    expect(vehicleCodeFor("5 Series", "EU")).toBe("G60");
    expect(vehicleCodeFor("5 Series", "CN")).toBe("G68");
    expect(vehicleCodeFor("7 Series", "US")).toBe("G70");
    expect(vehicleCodeFor("3 Series", "EU")).toBeUndefined();
  });
});
