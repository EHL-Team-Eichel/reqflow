import { z } from "zod";
import { Actor } from "./audit";

const Count = z.number().int().nonnegative();
const Score = z.number().min(0).max(100).nullable();

/** Excerpts remain verbatim; these references never replace the original records. */
export const SplitterEvidence = z.object({
  sourceId: z.string().startsWith("src_"),
  recordId: z.string().startsWith("rec_"),
  excerpt: z.string().min(1),
  locator: z.string().optional(),
});

export const SplitterAssignment = z.object({
  itemId: z.string().min(1),
  unitId: z.string().min(1),
  groupIds: z.array(z.string().min(1)),
  primaryGroupId: z.string().nullable(),
  outputPortId: z.string().regex(/^out-\d+$/),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  evidence: z.array(SplitterEvidence),
});

export const SplitterGroup = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  outputPortId: z.string().regex(/^out-\d+$/),
  support: Count,
  opposition: Count,
  unclear: Count,
  frequency: Score,
  impact: Score,
  frequencyContribution: Score,
  impactContribution: Score,
  score: Score,
  scoreOrigin: z.enum(["calculated", "upstream", "human_override", "not_computed"]),
  confidence: z.number().min(0).max(1).nullable(),
  assumptions: z.array(z.string()),
});

export const SplitterSignal = z.object({
  groupId: z.string(),
  unitId: z.string(),
  stance: z.enum(["support", "opposition", "unclear"]),
  impact: Score,
  confidence: z.number().min(0).max(1).nullable(),
  evidence: SplitterEvidence,
  reason: z.string().min(1),
});

/** Versioned analytical snapshot stored with BlockRun, separate from raw evidence and PM decisions. */
export const SplitterReport = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().startsWith("run_"),
  blockId: z.string().min(1),
  createdAt: z.iso.datetime(),
  mode: z.enum(["customer_priority", "car_parts", "custom", "priority", "category", "sentiment"]),
  models: z.array(z.string()),
  input: z.object({
    primaryLayer: z.enum(["records", "findings", "themes", "requirements", "sources"]),
    primaryCount: Count,
    recordCount: Count,
    sourceCount: Count,
    feedbackUnitCount: Count,
    contextUnitCount: Count,
    duplicateUnitCount: Count,
    customerCount: z.null(),
    countingBasis: z.string().min(1),
  }),
  branches: z
    .array(z.object({ portId: z.string(), label: z.string(), primaryItemCount: Count }))
    .min(2)
    .max(10),
  groups: z.array(SplitterGroup),
  assignments: z.array(SplitterAssignment),
  signals: z.array(SplitterSignal),
  sourceMatrix: z.array(
    z.object({
      sourceId: z.string(),
      groupId: z.string(),
      support: Count,
      opposition: Count,
      unclear: Count,
      denominator: Count.nullable(),
    }),
  ),
  scoreMethod: z.object({
    id: z.string().min(1),
    frequencyWeight: z.number().min(0).max(1),
    impactWeight: z.number().min(0).max(1),
    formula: z.string().min(1),
    impactScale: z.array(z.string()),
    thresholds: z.array(z.object({ portId: z.string(), min: z.number(), max: z.number() })),
  }),
  limitations: z.array(z.string()),
  reviews: z
    .array(
      z.object({
        version: z.number().int().positive(),
        at: z.iso.datetime(),
        actor: Actor,
        rationale: z.string().min(1),
        changes: z.array(
          z.object({ itemId: z.string(), fromPortId: z.string(), toPortId: z.string() }),
        ),
      }),
    )
    .default([]),
});
export type SplitterReport = z.infer<typeof SplitterReport>;
export type SplitterGroup = z.infer<typeof SplitterGroup>;
export type SplitterSignal = z.infer<typeof SplitterSignal>;
export type SplitterAssignment = z.infer<typeof SplitterAssignment>;

export const SplitterReview = z.object({
  expectedVersion: z.number().int().nonnegative(),
  rationale: z.string().trim().min(1).max(2000),
  changes: z
    .array(z.object({ itemId: z.string().min(1), toPortId: z.string().regex(/^out-\d+$/) }))
    .min(1)
    .max(10000),
});
export type SplitterReview = z.infer<typeof SplitterReview>;
