import { z } from "zod";

/**
 * Explainable prioritization: every factor is 0–5 where HIGHER always means "more worth doing".
 * total = 100 × Σ(weight × value) / (5 × Σ weight)   →   0–100
 * Weights and priority thresholds live in Settings.scoring and are recorded with each score.
 */
export const ScoreFactor = z.enum([
  "customer_impact", // how strongly and how many customers are affected
  "evidence_strength", // number, independence and reliability of supporting sources
  "competitive_gap", // competitors offer it / do it better
  "trend_momentum", // expected relevance when the successor launches (3–5 years)
  "brand_fit", // fit with BMW brand promise (premium, driving pleasure, …)
  "ease", // inverse of rough effort/cost — the only business factor allowed by the briefing
]);
export type ScoreFactor = z.infer<typeof ScoreFactor>;

export const SCORE_FACTOR_LABELS: Record<ScoreFactor, string> = {
  customer_impact: "Customer impact",
  evidence_strength: "Evidence strength",
  competitive_gap: "Competitive gap",
  trend_momentum: "Trend momentum",
  brand_fit: "Brand fit",
  ease: "Ease of delivery (inverse effort)",
};

/** MoSCoW priority bands. */
export const Priority = z.enum(["must", "should", "could", "wont"]);
export type Priority = z.infer<typeof Priority>;

export const ScoreWeights = z.record(ScoreFactor, z.number().min(0).max(10));
export type ScoreWeights = z.infer<typeof ScoreWeights>;

/** Minimum total score for each band; below `could` → "wont". */
export const PriorityThresholds = z
  .object({
    must: z.number().min(0).max(100),
    should: z.number().min(0).max(100),
    could: z.number().min(0).max(100),
  })
  .refine((t) => t.must > t.should && t.should > t.could, {
    message: "Thresholds must satisfy must > should > could",
  });
export type PriorityThresholds = z.infer<typeof PriorityThresholds>;

export const FactorScore = z.object({
  value: z.number().min(0).max(5),
  weight: z.number().min(0).max(10), // weight at scoring time (snapshot of Settings)
  note: z.string().min(1), // one-line justification, shown to the PM
  by: z.string().min(1).optional(), // "deterministic" (a rule on the evidence) or the judging model id
});
export type FactorScore = z.infer<typeof FactorScore>;

/** Things about a score a PM should notice. */
export const ScoreFlag = z.enum([
  "high_score_weak_evidence", // must/should-level score, but evidence level C or D
]);
export type ScoreFlag = z.infer<typeof ScoreFlag>;

export const ScoreBreakdown = z.object({
  factors: z.record(ScoreFactor, FactorScore),
  total: z.number().min(0).max(100),
  suggestedPriority: Priority, // what the score says; Requirement.priority may be overridden by the PM
  method: z.string().min(1), // versioned; current: "ws8-weighted@1" (older data may say "weighted-sum@1")
  scoredAt: z.iso.datetime(),
  flags: z.array(ScoreFlag).optional(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

/** The documented formula: 100 × Σ(weight × value) / (5 × Σ weight), rounded to one decimal. */
export function weightedTotal(
  values: Record<ScoreFactor, number>,
  weights: Record<ScoreFactor, number>,
): number {
  let num = 0;
  let den = 0;
  for (const f of ScoreFactor.options) {
    const v = values[f];
    const w = weights[f];
    if (!(v >= 0 && v <= 5)) throw new RangeError(`Factor ${f} must be within 0–5, got ${v}`);
    if (!(w >= 0)) throw new RangeError(`Weight for ${f} must be ≥ 0, got ${w}`);
    num += w * v;
    den += 5 * w;
  }
  if (den === 0) throw new RangeError("At least one score weight must be > 0");
  return Math.round((1000 * num) / den) / 10;
}

export function priorityForScore(total: number, t: PriorityThresholds): Priority {
  if (total >= t.must) return "must";
  if (total >= t.should) return "should";
  if (total >= t.could) return "could";
  return "wont";
}

/** Evidence levels (see requirement.ts) that rest on a single source or on assumptions. */
const WEAK_EVIDENCE = new Set(["C", "D"]);

/** A must/should-level score built on C/D evidence should catch the eye (PRODUCT.md). */
export function scoreFlags(
  total: number,
  evidenceLevel: "A" | "B" | "C" | "D" | undefined,
  t: PriorityThresholds,
): ScoreFlag[] {
  return evidenceLevel && WEAK_EVIDENCE.has(evidenceLevel) && total >= t.should
    ? ["high_score_weak_evidence"]
    : [];
}

/** Factors by contribution (weight × value), largest first; factors that add nothing are left out. */
export function topDrivers(score: ScoreBreakdown, n = 2): ScoreFactor[] {
  return ScoreFactor.options
    .map((f, i) => ({ f, i, c: score.factors[f].weight * score.factors[f].value }))
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c || a.i - b.i)
    .slice(0, n)
    .map((x) => x.f);
}

/** "Customer impact 5/5 (weight 3) and evidence strength 4/5 (weight 2)", for rationales. */
export function describeDrivers(score: ScoreBreakdown, n = 2): string {
  const parts = topDrivers(score, n).map((f) => {
    const { value, weight } = score.factors[f];
    return `${SCORE_FACTOR_LABELS[f].toLowerCase()} ${value}/5 (weight ${weight})`;
  });
  if (!parts.length) return "no factor adds to the score";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * The same factor values under new Settings weights and thresholds: the stored values and notes
 * stay, the weights snapshot, total, band and flags are recomputed.
 */
export function rescoreBreakdown(
  score: ScoreBreakdown,
  scoring: { weights: ScoreWeights; thresholds: PriorityThresholds },
  evidenceLevel: "A" | "B" | "C" | "D" | undefined,
  now: string,
): ScoreBreakdown {
  const weightOf = (f: ScoreFactor) => scoring.weights[f] ?? 0;
  const values = Object.fromEntries(
    ScoreFactor.options.map((f) => [f, score.factors[f].value]),
  ) as Record<ScoreFactor, number>;
  const weights = Object.fromEntries(ScoreFactor.options.map((f) => [f, weightOf(f)])) as Record<
    ScoreFactor,
    number
  >;
  const total = weightedTotal(values, weights);
  return {
    ...score,
    factors: Object.fromEntries(
      ScoreFactor.options.map((f) => [f, { ...score.factors[f], weight: weights[f] }]),
    ) as ScoreBreakdown["factors"],
    total,
    suggestedPriority: priorityForScore(total, scoring.thresholds),
    scoredAt: now,
    flags: scoreFlags(total, evidenceLevel, scoring.thresholds),
  };
}
