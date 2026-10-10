import type { Requirement } from "@reqflow/core";

/** Other scorers' evidence-strength values are not an independent confidence assessment. */
export function judgeScore(score: Requirement["score"]) {
  if (!score?.method.startsWith("ai-judge@")) return null;
  return {
    importance: score.total,
    confidence: (score.factors.evidence_strength?.value ?? 0) * 20,
    explanation: score.factors.evidence_strength?.note ?? "Not assessed",
  };
}
