import { DEFAULT_SETTINGS, type Finding, type Source, type SourceRecord } from "@reqflow/core";
import { fixtureFindings, fixtureRecords, fixtureSources } from "@reqflow/core/fixtures";
import { describe, expect, it } from "vitest";
import {
  deterministicFactors,
  explainPriority,
  neutralJudgement,
  PRIORITIZATION_METHOD,
  scoreItem,
  type ScoringEvidence,
} from "./index";

function makeSource(
  id: string,
  kind: Source["kind"] = "customer_feedback",
  rel?: Source["reliability"],
): Source {
  return {
    id: id.startsWith("src_") ? (id as `src_${string}`) : (`src_${id}` as `src_${string}`),
    kind,
    origin: "bmw_internal",
    title: `Source ${id}`,
    retrievedAt: new Date().toISOString(),
    reliability: rel,
  };
}

function makeFinding(
  id: string,
  kind: Finding["kind"],
  mentions: number,
  sentiment: number,
  sourceIds: string[],
): Finding {
  return {
    id: `fnd_${id}`,
    kind,
    statement: `Finding ${id} statement`,
    category: "comfort",
    evidence: sourceIds.map((srcId) => ({
      sourceId: srcId.startsWith("src_")
        ? (srcId as `src_${string}`)
        : (`src_${srcId}` as `src_${string}`),
      excerpt: `Excerpt for ${id}`,
    })),
    mentions,
    sentiment,
    markets: ["EU"],
    confidence: 0.8,
    inScope: true,
  };
}

function makeRecord(id: string, sourceId: string): SourceRecord {
  return {
    id: `rec_${id}`,
    sourceId: sourceId.startsWith("src_")
      ? (sourceId as `src_${string}`)
      : (`src_${sourceId}` as `src_${string}`),
    text: `Record ${id} text`,
  };
}

describe("deterministicFactors", () => {
  it("handles empty evidence returning all zeros with clear notes", () => {
    const empty: ScoringEvidence = {
      findings: [],
      records: [],
      sources: [],
    };
    const res = deterministicFactors(empty);
    expect(res.customer_impact.value).toBe(0);
    expect(res.customer_impact.note).toContain("No customer mentions");
    expect(res.evidence_strength.value).toBe(0);
    expect(res.evidence_strength.note).toContain("No sources");
    expect(res.competitive_gap.value).toBe(0);
    expect(res.competitive_gap.note).toContain("No competitor advantage");
    expect(res.trend_momentum.value).toBe(0);
    expect(res.trend_momentum.note).toContain("No market trend");
  });

  describe("customer_impact boundaries and bonuses", () => {
    const src = makeSource("1");

    it.each([
      [0, 0],
      [1, 1],
      [4, 2],
      [5, 3],
      [9, 3],
      [10, 4],
      [24, 4],
      [25, 5],
      [50, 5],
    ])("scales mentions %i to base value %i", (mentions, expected) => {
      const findings = mentions > 0 ? [makeFinding("1", "praise", mentions, 0.5, ["src_1"])] : [];
      const res = deterministicFactors({ findings, records: [], sources: [src] });
      expect(res.customer_impact.value).toBe(expected);
    });

    it("uses records count when no findings exist", () => {
      const records = [
        makeRecord("1", "src_1"),
        makeRecord("2", "src_1"),
        makeRecord("3", "src_1"),
      ];
      const res = deterministicFactors({ findings: [], records, sources: [src] });
      expect(res.customer_impact.value).toBe(2);
      expect(res.customer_impact.note).toContain("3 customer mentions across 3 records");
    });

    it("adds pain bonus when weighted mean sentiment <= -0.3", () => {
      // 5 mentions, sentiment -0.4: base 3 + pain bonus 1 = 4
      const findings = [makeFinding("1", "praise", 5, -0.4, ["src_1"])];
      const res = deterministicFactors({ findings, records: [], sources: [src] });
      expect(res.customer_impact.value).toBe(4);
      expect(res.customer_impact.note).toContain("clearly negative (mean sentiment -0.4)");
      expect(res.customer_impact.note).not.toContain("complaints");
    });

    it("adds pain bonus when >50% mentions are complaint or unmet_need", () => {
      // 6 mentions: 4 complaint, 2 praise. Sentiment 0.0. base 3 + 1 = 4
      const findings = [
        makeFinding("1", "complaint", 4, 0.0, ["src_1"]),
        makeFinding("2", "praise", 2, 0.0, ["src_1"]),
      ];
      const res = deterministicFactors({ findings, records: [], sources: [src] });
      expect(res.customer_impact.value).toBe(4);
      expect(res.customer_impact.note).toContain("mostly complaints or unmet needs");
    });

    it("adds quantitative bonus when usage_pattern cites BMW quantitative data", () => {
      const quantSrc = makeSource("quant", "sales_volume");
      const findings = [makeFinding("1", "usage_pattern", 5, 0.0, ["src_quant"])];
      // base 3 + quant bonus 0.5 = 3.5
      const res = deterministicFactors({ findings, records: [], sources: [quantSrc] });
      expect(res.customer_impact.value).toBe(3.5);
      expect(res.customer_impact.note).toContain("quantitative BMW data backs it");
    });

    it("caps customer_impact at 5 with both bonuses", () => {
      const quantSrc = makeSource("quant", "equipment_data");
      const findings = [makeFinding("1", "usage_pattern", 25, -0.8, ["src_quant"])];
      const res = deterministicFactors({ findings, records: [], sources: [quantSrc] });
      expect(res.customer_impact.value).toBe(5);
    });
  });

  describe("evidence_strength reliability and penalties", () => {
    it("sums reliability weights: high (1.5), med (1), low (0.5), missing (0.75)", () => {
      const sHigh = makeSource("1", "customer_feedback", "high");
      const sMed = makeSource("2", "customer_feedback", "medium");
      const sLow = makeSource("3", "customer_feedback", "low");
      const sNone = makeSource("4", "customer_feedback", undefined);

      const findings = [
        makeFinding("1", "complaint", 5, -0.5, ["src_1", "src_2", "src_3", "src_4"]),
      ];
      // 1.5 + 1.0 + 0.5 + 0.75 = 3.75 -> rounded to 3.8
      const res = deterministicFactors({
        findings,
        records: [],
        sources: [sHigh, sMed, sLow, sNone],
      });
      expect(res.evidence_strength.value).toBe(3.8);
      expect(res.evidence_strength.note).toContain("4 independent sources");
    });

    it("adds +1 for quantitative BMW data and caps at 5", () => {
      const s1 = makeSource("1", "sales_volume", "high"); // 1.5 + 1.0 (quant) = 2.5
      const findings = [makeFinding("1", "complaint", 5, -0.5, ["src_1"])];
      const res = deterministicFactors({ findings, records: [], sources: [s1] });
      expect(res.evidence_strength.value).toBe(2.5);
      expect(res.evidence_strength.note).toContain("incl. quantitative BMW data");
    });

    it("applies -1 penalty when conflicting mentions >= half supporting mentions", () => {
      const s1 = makeSource("1", "customer_feedback", "high"); // 1.5
      const s2 = makeSource("2", "customer_feedback", "high"); // 1.5 -> total 3.0
      const support = [makeFinding("1", "complaint", 10, -0.5, ["src_1", "src_2"])];
      const conflict = [makeFinding("2", "praise", 5, 0.5, ["src_1"])]; // 5 >= 10/2

      const res = deterministicFactors({
        findings: support,
        conflicting: conflict,
        records: [],
        sources: [s1, s2],
      });
      expect(res.evidence_strength.value).toBe(2.0); // 3.0 - 1.0
      expect(res.evidence_strength.note).toContain("1 conflicting finding");
    });
  });

  describe("competitive_gap scale", () => {
    it.each([
      [0, 0],
      [1, 2],
      [2, 3],
      [4, 3],
      [5, 4],
      [9, 4],
      [10, 5],
      [20, 5],
    ])("scales mentions %i to value %i", (mentions, expected) => {
      const findings =
        mentions > 0 ? [makeFinding("1", "competitor_advantage", mentions, 0, ["src_1"])] : [];
      const res = deterministicFactors({ findings, records: [], sources: [makeSource("1")] });
      expect(res.competitive_gap.value).toBe(expected);
    });
  });

  describe("trend_momentum scale and multi-source bonus", () => {
    it.each([
      [0, 0],
      [1, 2],
      [3, 3],
      [6, 4],
      [12, 5],
    ])("scales single-source mentions %i to value %i", (mentions, expected) => {
      const findings =
        mentions > 0 ? [makeFinding("1", "market_trend", mentions, 0, ["src_1"])] : [];
      const res = deterministicFactors({ findings, records: [], sources: [makeSource("1")] });
      expect(res.trend_momentum.value).toBe(expected);
    });

    it("adds +1 (cap 5) when market trend findings cite >= 2 distinct sources", () => {
      const findings = [
        makeFinding("1", "market_trend", 2, 0, ["src_1"]),
        makeFinding("2", "market_trend", 2, 0, ["src_2"]),
      ];
      // t = 4 -> base 3 + 1 bonus = 4
      const res = deterministicFactors({
        findings,
        records: [],
        sources: [makeSource("1"), makeSource("2")],
      });
      expect(res.trend_momentum.value).toBe(4);
    });
  });
});

describe("scoreItem and explainPriority", () => {
  const defaultScoring = DEFAULT_SETTINGS.scoring;
  const judged = neutralJudgement("offline test");
  const now = "2026-10-11T00:00:00Z";

  it("is reproducible: same input produces identical breakdown", () => {
    const evidence: ScoringEvidence = {
      findings: [makeFinding("1", "complaint", 8, -0.6, ["src_1"])],
      records: [],
      sources: [makeSource("1", "customer_feedback", "high")],
    };
    const input = { evidence, judged, scoring: defaultScoring, now };
    const a = scoreItem(input);
    const b = scoreItem(input);
    expect(a).toEqual(b);
    expect(a.method).toBe(PRIORITIZATION_METHOD);
  });

  it("weights change the ranking of two items", () => {
    // Item A: High customer impact (15 mentions, complaint), 0 competitor gap
    const evidenceA: ScoringEvidence = {
      findings: [makeFinding("1", "complaint", 15, -0.7, ["src_1"])],
      records: [],
      sources: [makeSource("1", "customer_feedback", "high")],
    };
    // Item B: Low customer impact (1 mention, praise), strong competitor gap (12 mentions)
    const evidenceB: ScoringEvidence = {
      findings: [
        makeFinding("2", "praise", 1, 0.2, ["src_1"]),
        makeFinding("3", "competitor_advantage", 12, 0, ["src_1"]),
      ],
      records: [],
      sources: [makeSource("1", "customer_feedback", "high")],
    };

    // Default weights: customer_impact = 3, competitive_gap = 1
    const scoreA_def = scoreItem({ evidence: evidenceA, judged, scoring: defaultScoring, now });
    const scoreB_def = scoreItem({ evidence: evidenceB, judged, scoring: defaultScoring, now });
    expect(scoreA_def.total).toBeGreaterThan(scoreB_def.total);

    // Reversed weights: competitive_gap = 10, customer_impact = 0
    const reversedScoring = {
      ...defaultScoring,
      weights: {
        ...defaultScoring.weights,
        customer_impact: 0,
        competitive_gap: 10,
      },
    };
    const scoreA_rev = scoreItem({ evidence: evidenceA, judged, scoring: reversedScoring, now });
    const scoreB_rev = scoreItem({ evidence: evidenceB, judged, scoring: reversedScoring, now });
    expect(scoreB_rev.total).toBeGreaterThan(scoreA_rev.total);
  });

  it("sets high_score_weak_evidence flag on C evidence when score >= should threshold, but not on A", () => {
    const highEvidence: ScoringEvidence = {
      findings: [
        makeFinding("1", "complaint", 30, -0.8, ["src_1"]),
        makeFinding("2", "competitor_advantage", 5, 0, ["src_1"]),
      ],
      records: [],
      sources: [makeSource("1", "customer_feedback", "high")],
    };
    const scoreC = scoreItem({
      evidence: highEvidence,
      judged,
      evidenceLevel: "C",
      scoring: defaultScoring,
      now,
    });
    expect(scoreC.flags).toContain("high_score_weak_evidence");

    const explanationC = explainPriority(scoreC, "C");
    expect(explanationC).toContain("Its evidence is weak (level C), so check it before approving.");

    const scoreA = scoreItem({
      evidence: highEvidence,
      judged,
      evidenceLevel: "A",
      scoring: defaultScoring,
      now,
    });
    expect(scoreA.flags).toBeUndefined();
    const explanationA = explainPriority(scoreA, "A");
    expect(explanationA).not.toContain("Its evidence is weak");
  });

  it("works with realistic core fixtures", () => {
    const realistic: ScoringEvidence = {
      findings: fixtureFindings.slice(0, 3),
      records: fixtureRecords.slice(0, 5),
      sources: fixtureSources.slice(0, 3),
    };
    const score = scoreItem({
      evidence: realistic,
      judged,
      evidenceLevel: "B",
      scoring: defaultScoring,
      now,
    });
    expect(score.total).toBeGreaterThan(0);
    expect(score.suggestedPriority).toBeDefined();
    expect(score.factors.customer_impact.by).toBe("deterministic");
    expect(score.factors.brand_fit.by).toBe("deterministic");
  });
});
