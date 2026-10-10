import {
  confidenceLevel,
  priorityForScore,
  ScoreFactor,
  weightedTotal,
  type ConfidenceSignal,
  type DecisionAnswer,
  type DecisionQuestion,
  type EvidenceLevel,
  type Priority,
  type RequirementConfidence,
  type ScoreBreakdown,
  type Settings,
  type SourceKind,
} from "@reqflow/core";
import type { ReviewAnswer } from "./schemas";

export const CONFIDENCE_METHOD = "agent-confidence@1";
export const SCORE_METHOD = "agent-critic@1";

const BANDS: Priority[] = ["must", "should", "could"];

/**
 * The input an item arrives on sets its ranking: with n priority inputs, the first third of the
 * ranks are must-haves, the next third should-haves, the rest could-haves (3 inputs: 1 → must,
 * 2 → should, 3 → could). The agents never assign "won't".
 */
export function priorityForRank(rank: number, inputs: number): Priority {
  const band = Math.floor(((Math.max(1, rank) - 1) * BANDS.length) / Math.max(1, inputs));
  return BANDS[Math.min(band, BANDS.length - 1)]!;
}

export const QUANTITATIVE_KINDS: ReadonlySet<SourceKind> = new Set([
  "customer_study",
  "equipment_data",
  "sales_volume",
]);
/** This many customers making the same point is more than anecdotal, even from one dataset. */
export const MIN_MENTIONS_NOT_ANECDOTAL = 10;

export interface EvidenceFacts {
  mentions: number; // supporting records
  sources: number; // distinct supporting sources
  quantitative: boolean; // BMW figures (study, take rates, sales) among them
  forwardOnly: boolean; // every supporting signal is a market trend: it rests on assumptions
  conflictingMentions: number;
}

/** PRODUCT.md evidence levels, computed from the evidence, never from the model's opinion. */
export function evidenceLevel(e: EvidenceFacts): EvidenceLevel {
  if (e.forwardOnly) return "D";
  if (e.sources >= 2 && e.quantitative) return "A";
  if (e.sources >= 2 || e.mentions >= MIN_MENTIONS_NOT_ANECDOTAL) return "B";
  return "C";
}

const DURABILITY_LEVELS = ["Very unlikely", "Unlikely", "Uncertain", "Likely", "Very likely"];
const CLARITY_LEVELS = ["Vague", "Somewhat specific", "Specific", "Specific and measurable"];

/** The judge's typed questions. Short and atomic: a System 1 model answers each in isolation. */
export function judgeQuestions(horizonYears: number): Record<string, DecisionQuestion> {
  return {
    support: {
      type: "noul",
      instructions:
        "Every claim in the requirement is directly backed by the quoted customer evidence.",
    },
    scope: {
      type: "noul",
      instructions:
        "The requirement describes something customers see, feel or use in the car — not a law or regulation, an engineering specification, or a price.",
    },
    durability: {
      type: "score",
      instructions: `How likely customers still want this when the successor launches in about ${horizonYears} years.`,
      criteria: DURABILITY_LEVELS,
    },
    clarity: {
      type: "score",
      instructions: "How specific and testable the requirement and its targets are.",
      criteria: CLARITY_LEVELS,
    },
  };
}

const level = (a: DecisionAnswer | undefined, levels: number): number | null =>
  a?.type === "score" ? Math.max(0, Math.min(1, a.score / Math.max(1, levels - 1))) : null;
const prob = (a: DecisionAnswer | undefined): number | null =>
  a?.type === "noul" ? Math.max(0, Math.min(1, a.value)) : null;

export type CritiqueOutcome = "accepted" | "revised" | "flagged";

/**
 * Combines the judge's answers with facts about the evidence and the critic's verdict.
 * Weighted geometric mean: one very weak ingredient (e.g. claims the evidence doesn't back)
 * pulls the whole score down, which an average would hide.
 */
export function combineConfidence(o: {
  answers: Record<string, DecisionAnswer> | null; // null when the judge failed
  judgeModel: string;
  evidence: EvidenceFacts;
  outcome: CritiqueOutcome;
}): RequirementConfidence {
  const signals: ConfidenceSignal[] = [];
  const add = (s: ConfidenceSignal | null) => s && signals.push(s);
  const a = o.answers ?? {};
  const fromJudge = (key: string, label: string, weight: number, value: number | null) =>
    value === null ? null : { key, label, value: round(value), weight, by: o.judgeModel };

  add(fromJudge("support", "Backed by the quoted evidence", 3, prob(a.support)));
  add(fromJudge("scope", "Customer-facing and in scope", 2, prob(a.scope)));
  add(
    fromJudge(
      "durability",
      "Still wanted at the successor's launch",
      1,
      level(a.durability, DURABILITY_LEVELS.length),
    ),
  );
  add(fromJudge("clarity", "Specific and testable", 1, level(a.clarity, CLARITY_LEVELS.length)));

  const e = o.evidence;
  const breadth = clamp(
    0.25 +
      0.45 * Math.min(1, Math.log10(1 + e.mentions) / Math.log10(21)) +
      0.15 * Math.min(1, (e.sources - 1) / 2) +
      0.15 * (e.quantitative ? 1 : 0),
  );
  signals.push({
    key: "breadth",
    label: "Breadth of evidence",
    value: round(breadth),
    weight: 2,
    by: "deterministic",
    note: `${e.mentions} record(s) from ${e.sources} source(s)${e.quantitative ? ", incl. BMW figures" : ""}.`,
  });
  const agreement = o.outcome === "accepted" ? 1 : o.outcome === "revised" ? 0.85 : 0.45;
  signals.push({
    key: "agreement",
    label: "Critic's review",
    value: agreement,
    weight: 1,
    by: "deterministic",
    note:
      o.outcome === "accepted"
        ? "Accepted as drafted."
        : o.outcome === "revised"
          ? "Fixed after the critic's review."
          : "The critic still sees open issues.",
  });
  const total = e.mentions + e.conflictingMentions;
  const conflictShare = total ? e.conflictingMentions / total : 0;
  signals.push({
    key: "conflicts",
    label: "Little conflicting evidence",
    value: round(1 - Math.min(0.6, conflictShare)),
    weight: 1,
    by: "deterministic",
    note: e.conflictingMentions
      ? `${e.conflictingMentions} record(s) argue against it.`
      : "Nothing in the inputs argues against it.",
  });
  if (!o.answers) {
    signals.push({
      key: "judge",
      label: "Judge unavailable",
      value: 0.5,
      weight: 2,
      by: "deterministic",
      note: "The judge could not answer, so this score rests on the evidence facts only.",
    });
  }

  const weight = signals.reduce((s, x) => s + x.weight, 0);
  const value = round(
    Math.exp(
      signals.reduce((s, x) => s + x.weight * Math.log(Math.max(0.02, x.value)), 0) / weight,
    ),
  );
  return { value, level: confidenceLevel(value), signals, method: CONFIDENCE_METHOD };
}

/** The critic's six factors → the documented weighted score (Settings weights and thresholds). */
export function scoreFromReview(
  factors: ReviewAnswer["factors"],
  scoring: Settings["scoring"],
  now: string,
): ScoreBreakdown {
  const values = Object.fromEntries(
    ScoreFactor.options.map((f) => [f, clamp(factors[f].value, 0, 5)]),
  ) as Record<ScoreFactor, number>;
  const weights = Object.fromEntries(
    ScoreFactor.options.map((f) => [f, scoring.weights[f] ?? 0]),
  ) as Record<ScoreFactor, number>;
  const total = weightedTotal(values, weights);
  return {
    factors: Object.fromEntries(
      ScoreFactor.options.map((f) => [
        f,
        {
          value: values[f],
          weight: weights[f],
          note: oneLine(factors[f].note) || "Assumption: no note given.",
        },
      ]),
    ) as ScoreBreakdown["factors"],
    total,
    suggestedPriority: priorityForScore(total, scoring.thresholds),
    method: SCORE_METHOD,
    scoredAt: now,
  };
}

export function oneLine(s: string, max = 300): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function clamp(v: number, min = 0, max = 1): number {
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
}
const round = (v: number) => Math.round(v * 100) / 100;
