import { z } from "zod";
import { ProductScope } from "./scope";
import { PriorityThresholds, ScoreWeights } from "./scoring";

/** "mock" returns canned, schema-valid output so the app runs offline and in tests. */
export const LlmProvider = z.enum(["anthropic", "mock"]);
export type LlmProvider = z.infer<typeof LlmProvider>;

export const ResearchProvider = z.enum(["anthropic_web_search", "tavily", "off"]);
export type ResearchProvider = z.infer<typeof ResearchProvider>;

/**
 * Everything the Settings page edits. API keys are NOT settings — they live in .env.local
 * and the server only reports whether one is configured.
 */
export const Settings = z.object({
  llm: z.object({
    provider: LlmProvider,
    model: z.string().min(1), // quality tier: clustering, derivation, challenge answers
    fastModel: z.string().min(1), // bulk tier: per-record signal extraction
    temperature: z.number().min(0).max(1),
  }),
  research: z.object({
    provider: ResearchProvider,
    maxResultsPerQuery: z.number().int().min(1).max(50),
    allowedDomains: z.array(z.string()), // empty = any
    blockedDomains: z.array(z.string()),
  }),
  scoring: z.object({
    weights: ScoreWeights,
    thresholds: PriorityThresholds,
  }),
  review: z.object({
    // The prototype has no login: this identity is the human actor in the audit trail.
    reviewer: z.object({
      userId: z.string().min(1),
      name: z.string().min(1),
      role: z.string().min(1),
    }),
  }),
  defaultScope: ProductScope,
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  llm: {
    provider: "mock",
    model: "claude-opus-5-5",
    fastModel: "claude-haiku-5-5",
    temperature: 0.2,
  },
  research: {
    provider: "off",
    maxResultsPerQuery: 8,
    allowedDomains: [],
    blockedDomains: [],
  },
  scoring: {
    weights: {
      customer_impact: 3,
      evidence_strength: 2,
      competitive_gap: 2,
      trend_momentum: 2,
      brand_fit: 1,
      ease: 1,
    },
    thresholds: { must: 70, should: 50, could: 30 },
  },
  review: {
    reviewer: { userId: "pm-demo", name: "Demo PM", role: "Product Manager" },
  },
  defaultScope: {
    vehicleLine: "5 Series",
    derivative: "Sedan",
    vehicleCode: "5S",
    market: "EU",
    horizonYears: 5,
  },
};
