import { z } from "zod";
import { Actor } from "./audit";
import { PipelineData } from "./pipeline";

export const FILTER_CUSTOMER_CRITERION =
  "Keep information relevant to customer-facing vehicle attributes. Keep mixed-topic items intact if any part is relevant.";
export const FILTER_PRESETS = {
  "customer-facing": {
    criterion: FILTER_CUSTOMER_CRITERION,
    include:
      "Features, equipment, comfort, space, usability, infotainment, digital services, design, perceived quality, driving experience, range, charging, variants and packages.",
    exclude:
      "Pure regulatory or homologation topics, engineering specifications, pricing and business cases without customer-facing information.",
    examples:
      "Keep: The seat is uncomfortable on long journeys.\nExclude: The component must meet a homologation standard.\nReview: Ambiguous or conflicting information without enough context.",
  },
  "all-relevant": {
    criterion:
      "Keep all information relevant to the vehicle and market scope from Settings. Preserve mixed-topic items intact if any part is relevant.",
    include:
      "Customer feedback and relevant equipment, sales, study, competitor, review and trend context.",
    exclude:
      "Only clearly unrelated information. Do not exclude uncertainty or conflicting evidence merely because it disagrees.",
    examples:
      "Keep: Relevant customer feedback or market context.\nExclude: Unrelated content about a different product.\nReview: Relevance cannot be established from available fields.",
  },
} as const;

export const FilterOutcome = z.enum(["keep", "exclude", "review"]);
export const FilterOverride = z.object({
  itemId: z.string().min(1),
  itemHash: z.string().regex(/^[a-f0-9]{64}$/),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  actor: Actor.refine((actor) => actor.type === "human", "A human must restore an item"),
  at: z.iso.datetime(),
  rationale: z.string().trim().min(1).max(2000),
  version: z.number().int().positive(),
});
export type FilterOverride = z.infer<typeof FilterOverride>;

export const FilterReport = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().startsWith("run_"),
  blockId: z.string().min(1),
  createdAt: z.iso.datetime(),
  primaryLayer: z.enum(["records", "findings", "themes", "requirements", "sources"]),
  configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
  configuration: z.object({
    criterion: z.string(),
    include: z.string(),
    exclude: z.string(),
    examples: z.string(),
    fields: z.array(z.string()),
    model: z.enum(["default", "fast"]),
    minConfidence: z.number().min(0).max(1),
    keepUnsure: z.boolean(),
  }),
  // Validate originals without Zod stripping provider-specific provenance or structured fields.
  originalInput: z.custom<PipelineData>((value) => PipelineData.safeParse(value).success),
  decisions: z.array(
    z.object({
      itemId: z.string().min(1),
      itemHash: z.string().regex(/^[a-f0-9]{64}$/),
      modelDecision: FilterOutcome,
      outcome: FilterOutcome,
      confidence: z.number().min(0).max(1),
      reason: z.string().trim().min(1).max(2000),
      quotes: z.array(z.object({ recordId: z.string().min(1), excerpt: z.string().min(1) })),
      model: z.string().min(1),
      forwarded: z.boolean(),
      retainedAsContext: z.boolean(),
      override: FilterOverride.optional(),
    }),
  ),
  warnings: z.array(z.string()),
});
export type FilterReport = z.infer<typeof FilterReport>;

export const FilterReview = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  itemIds: z
    .array(z.string().min(1))
    .min(1)
    .max(10000)
    .refine((ids) => new Set(ids).size === ids.length, "Duplicate items"),
  rationale: z.string().trim().min(1).max(2000),
});
export type FilterReview = z.infer<typeof FilterReview>;
export const FilterReviewState = z.object({
  version: z.number().int().nonnegative(),
  overrides: z.array(FilterOverride),
});
export type FilterReviewState = z.infer<typeof FilterReviewState>;
