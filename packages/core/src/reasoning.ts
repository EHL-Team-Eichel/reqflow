import { z } from "zod";
import { ContextMode } from "./blocks";
import { DataKey } from "./pipeline";
import { RequirementConfidence } from "./requirement";
import { ProductScope } from "./scope";

/**
 * The thought process of the Add to Car agents, saved with every run so a PM can see why each
 * requirement exists: which agent did what, on which evidence, and how sure it was. Plain language
 * on purpose: this is what the "thought process" view shows, not raw model output.
 */

export const AGENT_ROLES = [
  "context",
  "analyst",
  "synthesizer",
  "architect",
  "critic",
  "judge",
] as const;
export const AgentRole = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRole>;

/** Roles that write text. The judge only answers typed questions (see DecisionClient). */
export type WriterRole = Exclude<AgentRole, "judge">;

export const AGENT_ROLE_INFO: Record<AgentRole, { label: string; does: string }> = {
  context: {
    label: "Context reader",
    does: "Reads the context inputs and sums up what they mean for the next car.",
  },
  analyst: {
    label: "Analysts",
    does: "Read every item that arrives and pick out customer signals, each with a verbatim quote.",
  },
  synthesizer: {
    label: "Synthesizer",
    does: "Groups related signals into themes and spots evidence that disagrees.",
  },
  architect: {
    label: "Requirements architect",
    does: "Turns each theme into a customer-facing requirement for the successor, with measurable targets.",
  },
  critic: {
    label: "Critic",
    does: "Challenges every draft against the evidence and the scope rules, and scores it.",
  },
  judge: {
    label: "Judge",
    does: "Answers short yes/no and scale questions about each requirement; they make up its confidence.",
  },
};

/** One input of the block as the agents saw it. */
export const TraceInput = z.object({
  port: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["priority", "context"]),
  rank: z.number().int().min(1).optional(), // priority inputs: 1 = most important
  mode: ContextMode.optional(), // context inputs
  counts: z.partialRecord(DataKey, z.number().int().nonnegative()),
});
export type TraceInput = z.infer<typeof TraceInput>;

export const StepStatus = z.enum(["done", "warning", "failed", "skipped"]);
export type StepStatus = z.infer<typeof StepStatus>;

/** One box in the thought-process view: an agent (or a code step) and what it did. */
export const ReasoningStep = z.object({
  id: z.string().min(1),
  role: AgentRole,
  title: z.string().min(1), // "Analysts read 1. Priority"
  summary: z.string().min(1), // one or two plain sentences: what it did and concluded
  notes: z.array(z.string().min(1)), // key points and warnings, one line each
  stats: z.array(z.object({ label: z.string().min(1), value: z.number() })), // in display order
  model: z.string().min(1), // exact model id, "deterministic" or "offline"
  setup: z.string().optional(), // name of the API setup (Settings → AI)
  calls: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  status: StepStatus,
});
export type ReasoningStep = z.infer<typeof ReasoningStep>;

/** One line of an agent's stated reasoning about a requirement. */
export const ThoughtLine = z.object({ role: AgentRole, text: z.string().min(1) });
export type ThoughtLine = z.infer<typeof ThoughtLine>;

export const TraceEvidence = z.object({
  sourceId: z.string().startsWith("src_"),
  recordId: z.string().startsWith("rec_").optional(),
  findingId: z.string().startsWith("fnd_").optional(),
  excerpt: z.string().min(1).max(1000), // verbatim
  rank: z.number().int().min(1).optional(), // the priority input it arrived on
  supports: z.boolean(), // false: argues against the requirement
});
export type TraceEvidence = z.infer<typeof TraceEvidence>;

/** accepted: the critic found nothing to fix · revised: fixed after its review · flagged: open issues. */
export const CritiqueVerdict = z.enum(["accepted", "revised", "flagged"]);
export type CritiqueVerdict = z.infer<typeof CritiqueVerdict>;

/** "Why this requirement?": the chain from evidence to the requirement on the car. */
export const RequirementReasoning = z.object({
  requirementId: z.string().min(1),
  title: z.string().min(1),
  theme: z.string().min(1),
  ranks: z.array(z.number().int().min(1)), // priority inputs its evidence came from
  evidence: z.array(TraceEvidence),
  thoughts: z.array(ThoughtLine),
  verdict: CritiqueVerdict,
  issues: z.array(z.string().min(1)),
  confidence: RequirementConfidence,
  contextUsed: z.array(z.string().min(1)), // labels of the context inputs it drew on
});
export type RequirementReasoning = z.infer<typeof RequirementReasoning>;

/** A theme the agents did not turn into a requirement, and why. Nothing is dropped silently. */
export const HeldBack = z.object({
  theme: z.string().min(1),
  reason: z.string().min(1),
  signals: z.number().int().nonnegative(),
});
export type HeldBack = z.infer<typeof HeldBack>;

export const ReasoningTrace = z.object({
  id: z.string().startsWith("rsn_"),
  runId: z.string().startsWith("run_"),
  blockId: z.string().min(1),
  createdAt: z.iso.datetime(),
  scope: ProductScope,
  inputs: z.array(TraceInput),
  steps: z.array(ReasoningStep),
  requirements: z.array(RequirementReasoning),
  heldBack: z.array(HeldBack),
  totals: z.object({
    calls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  /** True when the offline mock wrote it: no AI model was involved. */
  offline: z.boolean(),
});
export type ReasoningTrace = z.infer<typeof ReasoningTrace>;
