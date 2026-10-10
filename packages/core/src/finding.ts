import { z } from "zod";
import { RequirementCategory } from "./category";
import { EvidenceRef } from "./source";

/** Signal types the briefing asks us to extract. */
export const FindingKind = z.enum([
  "complaint", // recurring pain point
  "unmet_need", // something customers want but don't get
  "praise", // keep/protect — what customers love
  "competitor_advantage", // a competitor does it better
  "market_trend", // forward-looking signal (3–5 years)
  "usage_pattern", // from equipment take rates / sales volumes
]);
export type FindingKind = z.infer<typeof FindingKind>;

/** A normalized, evidence-linked signal. Every finding must cite at least one source. */
export const Finding = z.object({
  id: z.string().startsWith("fnd_"),
  kind: FindingKind,
  statement: z.string().min(1), // one normalized sentence, e.g. "Rear legroom is too tight for adults."
  category: RequirementCategory,
  evidence: z.array(EvidenceRef).min(1),
  mentions: z.number().int().nonnegative(), // how many records support it (after dedup)
  sentiment: z.number().min(-1).max(1).optional(),
  markets: z.array(z.string()),
  themeId: z.string().startsWith("thm_").optional(),
  confidence: z.number().min(0).max(1), // extractor's confidence that the statement reflects the evidence
  inScope: z.boolean(),
  outOfScopeReason: z.string().optional(), // required when inScope=false
});
export type Finding = z.infer<typeof Finding>;

/** A cluster of duplicate/related findings (BMW process: "classify, cluster, contextualize"). */
export const Theme = z.object({
  id: z.string().startsWith("thm_"),
  label: z.string().min(1),
  summary: z.string(),
  category: RequirementCategory,
  findingIds: z.array(z.string().startsWith("fnd_")).min(1),
});
export type Theme = z.infer<typeof Theme>;
