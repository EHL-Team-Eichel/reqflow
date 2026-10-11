import { FindingKind, KanoClass, RequirementCategory } from "@reqflow/core";
import { z } from "zod";

/**
 * What each agent must answer. Every field is required and there are no unions or dynamic keys:
 * that is what structured-output modes (Claude, OpenAI strict) accept. Limits are described, not
 * enforced, so a slightly long answer is trimmed in code instead of failing a whole call.
 */

export const CONTRACT = {
  analyst: "reqflow.add-to-car.analyst@1",
  synthesizer: "reqflow.add-to-car.synthesizer@1",
  merge: "reqflow.add-to-car.merge@1",
  architect: "reqflow.add-to-car.architect@1",
  revise: "reqflow.add-to-car.revise@1",
  critic: "reqflow.add-to-car.critic@1",
  context: "reqflow.add-to-car.context@1",
} as const;
export type Contract = (typeof CONTRACT)[keyof typeof CONTRACT];

export const AnalystAnswer = z.object({
  signals: z.array(
    z.object({
      kind: FindingKind,
      statement: z
        .string()
        .describe("One neutral sentence: which part of the car, what the point is."),
      category: RequirementCategory,
      inScope: z.boolean(),
      outOfScopeReason: z.string().describe('Why it is out of scope; "" when in scope.'),
      refs: z.array(z.string()).describe("Refs of every record that makes this point."),
      quotes: z
        .array(z.object({ ref: z.string(), quote: z.string() }))
        .describe("1–3 verbatim passages copied exactly from those records."),
      sentiment: z.number().describe("-1 very negative … 1 very positive."),
    }),
  ),
  ignored: z.array(z.string()).describe("Refs of records with no customer point at all."),
});
export type AnalystAnswer = z.infer<typeof AnalystAnswer>;

export const SynthesizerAnswer = z.object({
  themes: z.array(
    z.object({
      label: z.string().describe("2–6 words."),
      need: z.string().describe("The underlying customer need in one sentence, solution-open."),
      category: RequirementCategory,
      signals: z
        .array(z.string())
        .describe("Refs of supporting signals; each signal in one theme at most."),
      conflicting: z.array(z.string()).describe("Refs of signals that argue against this theme."),
    }),
  ),
});
export type SynthesizerAnswer = z.infer<typeof SynthesizerAnswer>;

export const MergeAnswer = z.object({
  merges: z.array(
    z.object({
      keep: z.string().describe("Ref of the theme that stays."),
      absorb: z.array(z.string()).describe("Refs of themes with the same need, merged into it."),
    }),
  ),
});
export type MergeAnswer = z.infer<typeof MergeAnswer>;

export const DraftAnswer = z.object({
  title: z.string().describe("At most 12 words."),
  description: z
    .string()
    .describe("2–4 sentences: what the customer must experience in the successor."),
  category: RequirementCategory,
  kano: KanoClass,
  targets: z
    .array(z.object({ metric: z.string(), target: z.string(), acceptance: z.string() }))
    .describe(
      "1–3 customer-perceivable, measurable targets with how a test would confirm them. At least 1 is required; leave it empty only if nothing about the theme can be measured, and it is held back.",
    ),
  assumptions: z.array(z.string()),
  uncertainties: z.array(z.string()),
  why: z.string().describe("2–3 sentences for the product manager, citing signals like [s3]."),
  usedSignals: z.array(z.string()).describe("Refs of the signals the requirement relies on."),
  contextUsed: z.array(z.string()).describe("Refs of context inputs that changed the reasoning."),
});
export type DraftAnswer = z.infer<typeof DraftAnswer>;

const Factor = z.object({
  value: z.number().describe("0–5, higher = more worth doing."),
  note: z.string().describe("One line starting with 'Evidence:' citing [s#], or 'Assumption:'."),
});
export const ReviewAnswer = z.object({
  verdict: z.enum(["accept", "revise", "reject"]),
  issues: z.array(z.string()).describe("Concrete problems; empty when accepted."),
  fixes: z.array(z.string()).describe("How to fix each issue."),
  rejectReason: z.string().describe('Why it can\'t become a requirement; "" unless rejected.'),
  factors: z.object({
    brand_fit: Factor,
    ease: Factor,
  }),
});
export type ReviewAnswer = z.infer<typeof ReviewAnswer>;

export const ContextAnswer = z.object({
  whatItIs: z.string().describe("One sentence."),
  facts: z
    .array(z.object({ text: z.string(), refs: z.array(z.string()) }))
    .describe("Up to 8 key facts, numbers copied exactly."),
  implications: z
    .array(z.string())
    .describe("Up to 4: what this means for the successor's priorities."),
  caveats: z.array(z.string()).describe("Up to 3 limits of this data."),
});
export type ContextAnswer = z.infer<typeof ContextAnswer>;
