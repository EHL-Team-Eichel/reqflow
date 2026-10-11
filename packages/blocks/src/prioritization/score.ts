import {
  describeDrivers,
  FactorScore,
  priorityForScore,
  ScoreBreakdown,
  ScoreFactor,
  scoreFlags,
  topDrivers,
  weightedTotal,
  type Settings,
} from "@reqflow/core";
import { deterministicFactors, type ScoringEvidence } from "./factors";
import { cleanJudgementNote, type JudgedFactor, type Judgement } from "./judge";

export const PRIORITIZATION_METHOD = "ws8-weighted@1";

export interface ScoreInput {
  evidence: ScoringEvidence;
  judged: Record<JudgedFactor, Judgement>;
  evidenceLevel?: "A" | "B" | "C" | "D";
  scoring: Settings["scoring"];
  now: string; // ISO datetime
}

export function scoreItem(input: ScoreInput): ScoreBreakdown {
  const det = deterministicFactors(input.evidence);
  const factors: Record<string, FactorScore> = {};

  const detKeys: (keyof typeof det)[] = [
    "customer_impact",
    "evidence_strength",
    "competitive_gap",
    "trend_momentum",
  ];
  for (const k of detKeys) {
    const weight = input.scoring.weights[k] ?? 0;
    factors[k] = {
      value: det[k].value,
      weight,
      note: det[k].note,
      by: "deterministic",
    };
  }

  const judgedKeys: JudgedFactor[] = ["brand_fit", "ease"];
  for (const k of judgedKeys) {
    const j = input.judged[k];
    if (!Number.isFinite(j.value)) {
      throw new RangeError(`Judged factor ${k} must be finite, got ${j.value}`);
    }
    const weight = input.scoring.weights[k] ?? 0;
    const value = Math.max(0, Math.min(5, j.value));
    factors[k] = {
      value,
      weight,
      note: cleanJudgementNote(j.note) || "Assumption: no note given.",
      by: j.by,
    };
  }

  const values = Object.fromEntries(
    ScoreFactor.options.map((f) => [f, factors[f]!.value]),
  ) as Record<ScoreFactor, number>;
  const weights = Object.fromEntries(
    ScoreFactor.options.map((f) => [f, factors[f]!.weight]),
  ) as Record<ScoreFactor, number>;

  const total = weightedTotal(values, weights);
  const suggestedPriority = priorityForScore(total, input.scoring.thresholds);
  const flags = scoreFlags(total, input.evidenceLevel, input.scoring.thresholds);

  return ScoreBreakdown.parse({
    factors,
    total,
    suggestedPriority,
    method: PRIORITIZATION_METHOD,
    scoredAt: input.now,
    ...(flags.length ? { flags } : {}),
  });
}

/** "Score 72/100 (must), driven by customer impact 5/5 (weight 3) and …." */
export function scoreSentence(score: ScoreBreakdown): string {
  const drivers = topDrivers(score).length
    ? `driven by ${describeDrivers(score)}`
    : "no factor adds to it";
  return `Score ${score.total}/100 (${score.suggestedPriority}), ${drivers}.`;
}

/** Said when a must/should-level score rests on C/D evidence. */
export function weakEvidenceSentence(evidenceLevel: "A" | "B" | "C" | "D" | undefined): string {
  return `Its evidence is weak (level ${evidenceLevel ?? "C or D"}), so check it before approving.`;
}

/** The score sentence, plus the weak-evidence warning when the score is flagged. */
export function explainPriority(
  score: ScoreBreakdown,
  evidenceLevel?: "A" | "B" | "C" | "D",
): string {
  const weak = score.flags?.includes("high_score_weak_evidence");
  return weak
    ? `${scoreSentence(score)} ${weakEvidenceSentence(evidenceLevel)}`
    : scoreSentence(score);
}
