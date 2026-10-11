import { z } from "zod";
import { Actor } from "./audit";
import { DATA_KEYS, PipelineData, type DataKey } from "./pipeline";

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

/** Layers the AI Filter classifies, most advanced first. */
export const FILTER_LAYERS = ["requirements", "themes", "findings", "records"] as const;
export type FilterLayer = (typeof FILTER_LAYERS)[number];
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
      // Absent in reports written before lower layers were classified: then the primary layer.
      layer: z.enum(FILTER_LAYERS).optional(),
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

type Membership = Record<DataKey, Set<string>>;
const emptyMembership = () =>
  Object.fromEntries(DATA_KEYS.map((key) => [key, new Set<string>()])) as Membership;

/**
 * The links between a filter input's items, indexed once. `closure` is what one item brings along:
 * a requirement its findings and sources, a theme its findings, a finding its themes, records and
 * sources, a record its source. `onMissing` hears about references to items that aren't there.
 */
export function filterGraph(input: PipelineData) {
  const byId = Object.fromEntries(
    DATA_KEYS.map((key) => [key, new Map<string, unknown>(input[key].map((i) => [i.id, i]))]),
  ) as Record<DataKey, Map<string, unknown>>;
  const themesByFinding = new Map<string, string[]>();
  for (const theme of input.themes)
    for (const id of theme.findingIds)
      themesByFinding.set(id, [...(themesByFinding.get(id) ?? []), theme.id]);
  const findingsByTheme = new Map<string, string[]>();
  for (const finding of input.findings)
    if (finding.themeId)
      findingsByTheme.set(finding.themeId, [
        ...(findingsByTheme.get(finding.themeId) ?? []),
        finding.id,
      ]);

  function closure(layer: DataKey, id: string, onMissing?: (key: DataKey) => void): Membership {
    const ids = emptyMembership();
    const pending: [DataKey, string][] = [];
    const add = (key: DataKey, ref: string) => {
      if (ids[key].has(ref)) return;
      if (!byId[key].has(ref)) return onMissing?.(key);
      ids[key].add(ref);
      pending.push([key, ref]);
    };
    add(layer, id);
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const [key, ref] = pending[cursor]!;
      if (key === "requirements") {
        const r = byId.requirements.get(ref) as PipelineData["requirements"][number];
        for (const f of [...r.findingIds, ...r.conflictingFindingIds]) add("findings", f);
        for (const s of r.sourceIds) add("sources", s);
      } else if (key === "themes") {
        const t = byId.themes.get(ref) as PipelineData["themes"][number];
        for (const f of [...t.findingIds, ...(findingsByTheme.get(ref) ?? [])]) add("findings", f);
      } else if (key === "findings") {
        const f = byId.findings.get(ref) as PipelineData["findings"][number];
        for (const t of [...(f.themeId ? [f.themeId] : []), ...(themesByFinding.get(ref) ?? [])])
          add("themes", t);
        for (const e of f.evidence) {
          add("sources", e.sourceId);
          if (e.recordId) add("records", e.recordId);
        }
      } else if (key === "records") {
        add("sources", (byId.records.get(ref) as PipelineData["records"][number]).sourceId);
      }
    }
    return ids;
  }

  /**
   * What the filter decides on: every item of the most advanced layer, plus every lower-layer item
   * nothing above it brings along (feedback comments without findings, say). Nothing is left out
   * unseen just because another input carried findings.
   */
  function units(): { layer: FilterLayer; id: string }[] {
    const covered = emptyMembership(); // what higher layers' units bring along
    const out: { layer: FilterLayer; id: string }[] = [];
    for (const layer of FILTER_LAYERS) {
      const fresh = input[layer].filter((item) => !covered[layer].has(item.id));
      for (const item of fresh) out.push({ layer, id: item.id });
      for (const item of fresh) {
        const brought = closure(layer, item.id);
        for (const key of DATA_KEYS) for (const ref of brought[key]) covered[key].add(ref);
      }
    }
    return out;
  }

  return { closure, units, membership: emptyMembership };
}

/** The layer a decision classified (older reports classified only their primary layer). */
export function decisionLayer(
  report: FilterReport,
  decision: FilterReport["decisions"][number],
): DataKey {
  return decision.layer ?? report.primaryLayer;
}

/** The exact original item behind each decision, by item id. */
export function filterOriginals(report: FilterReport): Map<string, { id: string }> {
  const byLayer = new Map<DataKey, Map<string, { id: string }>>();
  const originals = new Map<string, { id: string }>();
  for (const decision of report.decisions) {
    const layer = decisionLayer(report, decision);
    let items = byLayer.get(layer);
    if (!items) {
      items = new Map(report.originalInput[layer].map((item) => [item.id, item]));
      byLayer.set(layer, items);
    }
    const item = items.get(decision.itemId);
    if (item) originals.set(decision.itemId, item);
  }
  return originals;
}
