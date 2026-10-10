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
  createdBy: Actor,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  runId: z.string().startsWith("run_").optional(),
});
export type Requirement = z.infer<typeof Requirement>;
