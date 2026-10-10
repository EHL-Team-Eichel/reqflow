import { z } from "zod";

/**
 * Contract between the AI Judge block (`@reqflow/blocks`) and the agents that do its language work
 * (`@reqflow/agents`, Mastra, main process only). Agents only propose and check: every number that
 * ranks or scores a requirement is computed deterministically in the block.
 */

export const JudgeScope = z.object({
  interpretation: z.string().describe("One sentence: what the PM is asking about."),
  core: z.array(
    z.object({
      component: z.string().describe("component id from the list"),
      aspect: z
        .string()
        .nullable()
        .describe("aspect id from the list, or null for every aspect of the component"),
      reason: z.string(),
    }),
  ),
  adjacent: z.array(
    z.object({
      component: z.string(),
      aspect: z.string().nullable(),
      relevance: z
        .number()
        .min(0.2)
        .max(0.8)
        .describe("0.2 (loosely related) to 0.8 (closely related)"),
      reason: z.string(),
    }),
  ),
});
export type JudgeScope = z.infer<typeof JudgeScope>;

export const JudgeResearch = z.object({
  items: z.array(
    z.object({
      problemKey: z.string().describe('a key from the problem list, or "other"'),
      url: z.string(),
      title: z.string(),
      publisher: z.string(),
      published: z.string().nullable(),
      quote: z
        .string()
        .describe("an exact sentence copied verbatim from the page (at least 8 words)"),
      polarity: z.enum(["negative", "request", "positive"]),
      note: z.string(),
    }),
  ),
  searchNotes: z.string().describe("what was searched and what could not be found"),
});
export type JudgeResearch = z.infer<typeof JudgeResearch>;

export const JUDGE_ACTION_TYPES = [
  "fix_defect",
  "quality_improvement",
  "usability_improvement",
  "comfort_improvement",
  "new_feature",
  "packaging_or_availability",
  "communication_or_onboarding",
  "investigate",
] as const;
export const JudgeActionType = z.enum(JUDGE_ACTION_TYPES);
export type JudgeActionType = z.infer<typeof JudgeActionType>;

export const JudgeActions = z.object({
  actions: z.array(
    z.object({
      title: z.string().describe("imperative, max 12 words"),
      type: JudgeActionType,
      description: z
        .string()
        .describe("what to do for the successor, customer-facing, 2-4 sentences"),
      acceptanceCriteria: z
        .array(z.string().min(1))
        .min(1)
        .max(3)
        .describe("1-3 measurable, customer-observable criteria"),
      addresses: z
        .array(z.string())
        .describe("refs (E1, E2, …) of the quotes this action resolves"),
      rationale: z.string(),
      assumptions: z.array(z.string()),
      risks: z.array(z.string()),
    }),
  ),
});
export type JudgeActions = z.infer<typeof JudgeActions>;

export const SolutionSupport = z.enum(["strong", "moderate", "weak", "none"]);
export type SolutionSupport = z.infer<typeof SolutionSupport>;

export const JudgeVerdict = z.object({
  quoteChecks: z.array(
    z.object({
      ref: z.string(),
      describesProblem: z.boolean(),
      note: z.string(),
    }),
  ),
  solutionSupport: SolutionSupport,
  solutionReasoning: z.string(),
  whyNotHigher: z.array(z.string()),
  toRaiseIt: z.array(z.string()),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/** The language work of the AI Judge. Prompts are plain text; outputs are validated with the schemas above. */
export interface JudgingAgents {
  /** Exact model id, recorded on every AI audit event. */
  readonly model: string;
  resolveScope(prompt: string, signal?: AbortSignal): Promise<JudgeScope>;
  /** Searches the web (provider-native search + page fetch). Quotes are verified by the caller. */
  research(prompt: string, signal?: AbortSignal): Promise<JudgeResearch>;
  proposeActions(prompt: string, signal?: AbortSignal): Promise<JudgeActions>;
  /** The independent confidence judge: never sees the priority of what it judges. */
  judge(prompt: string, signal?: AbortSignal): Promise<JudgeVerdict>;
}
