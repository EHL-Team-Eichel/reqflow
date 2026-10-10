import { z } from "zod";
import { Actor } from "./audit";
import { RequirementCategory } from "./category";
import { REQUIREMENT_ID_PATTERN } from "./ids";
import { ProductScope } from "./scope";
import { Priority, ScoreBreakdown } from "./scoring";

/**
 * How well a requirement is backed — makes "evidence vs. assumption" explicit (briefing).
 *  A strong     – several independent sources incl. quantitative BMW data, consistent
 *  B moderate   – several sources, mostly qualitative, or minor conflicts
 *  C weak       – single source / anecdotal
 *  D assumption – forward-looking, rests mainly on trends or expert judgement
 */
export const EvidenceLevel = z.enum(["A", "B", "C", "D"]);
export type EvidenceLevel = z.infer<typeof EvidenceLevel>;

/**
 * Lifecycle. AI may only ever set `proposed` (and `in_review` after answering a challenge).
 * `approved`, `rejected`, `deferred`, `challenged` are set by a human via RequirementDecision.
 */
export const DecisionStatus = z.enum([
  "proposed",
  "in_review",
  "challenged",
  "approved",
  "rejected",
  "deferred",
]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

/** Kano classification — helps PMs see basic expectations vs. delighters. */
export const KanoClass = z.enum(["basic", "performance", "delighter", "indifferent"]);
export type KanoClass = z.infer<typeof KanoClass>;

/** BMW process step "Specification and quantification": measurable, customer-perceivable target. */
export const MetricTarget = z.object({
  metric: z.string().min(1), // "Real-world highway range"
  target: z.string().min(1), // "≥ 550 km at 130 km/h, 20 °C"
  acceptance: z.string().min(1), // how a customer / test would confirm it
});
export type MetricTarget = z.infer<typeof MetricTarget>;

/** How much to trust a requirement as written: high ≥ 0.75, medium ≥ 0.5, low below. */
export const ConfidenceLevel = z.enum(["high", "medium", "low"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

export function confidenceLevel(value: number): ConfidenceLevel {
  return value >= 0.75 ? "high" : value >= 0.5 ? "medium" : "low";
}

/** One ingredient of the confidence score, e.g. "backed by the cited evidence" = 0.92. */
export const ConfidenceSignal = z.object({
  key: z.string().min(1), // "support", "scope", "durability", "clarity", "breadth", "agreement", "conflicts"
  label: z.string().min(1), // shown to the PM
  value: z.number().min(0).max(1),
  weight: z.number().min(0).max(10),
  by: z.string().min(1), // model id that judged it, or "deterministic"
  note: z.string().optional(),
});
export type ConfidenceSignal = z.infer<typeof ConfidenceSignal>;

/**
 * The agents' confidence in a requirement as written (Add to Car). Separate from the evidence level
 * and the priority score: a must-have can still be low confidence, and that should catch the eye.
 */
export const RequirementConfidence = z.object({
  value: z.number().min(0).max(1),
  level: ConfidenceLevel,
  signals: z.array(ConfidenceSignal).min(1),
  method: z.string().min(1), // versioned, e.g. "agent-confidence@1"
});
export type RequirementConfidence = z.infer<typeof RequirementConfidence>;

export const Requirement = z.object({
  id: z.string().regex(REQUIREMENT_ID_PATTERN), // stable across versions
  version: z.number().int().positive(), // +1 on every content change
  title: z.string().min(1).max(120),
  description: z.string().min(1), // clear, actionable, customer-facing; no engineering specs
  category: RequirementCategory,
  scope: ProductScope,
  targets: z.array(MetricTarget),
  findingIds: z.array(z.string().startsWith("fnd_")).min(1), // traceability: requirement → findings
  sourceIds: z.array(z.string().startsWith("src_")), // denormalized from findings for display/export
  conflictingFindingIds: z.array(z.string().startsWith("fnd_")), // evidence that argues against it
  score: ScoreBreakdown.optional(), // absent until prioritization.score ran
  priority: Priority.optional(), // current priority (suggested or PM override)
  priorityRationale: z.string().optional(),
  evidenceLevel: EvidenceLevel,
  kano: KanoClass.optional(),
  assumptions: z.array(z.string()), // forward-looking assumptions it relies on
  uncertainties: z.array(z.string()), // what could make it wrong
  status: DecisionStatus,
  confidence: RequirementConfidence.optional(), // absent for requirements made before the agents
  inputRank: z.number().int().min(1).optional(), // Add to Car: the "n. Priority" input its evidence came from
  createdBy: Actor,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  runId: z.string().startsWith("run_").optional(),
});
export type Requirement = z.infer<typeof Requirement>;
