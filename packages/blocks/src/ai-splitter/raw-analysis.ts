import {
  carPartOutputs,
  SplitterReport,
  type CarPartOutput,
  type DataKey,
  type PipelineData,
  type Source,
  type SourceRecord,
  type SplitterAssignment,
  type SplitterSignal,
} from "@reqflow/core";
import type { BlockContext } from "@reqflow/engine";
import {
  bandLabels,
  calculateGroups,
  stanceCounts,
  summarizeUnits,
  thresholds,
  type DemandSignal,
} from "./customer-demand";
import { FEEDBACK_KINDS, feedbackUnits } from "./feedback-units";
import { primaryLayer } from "./evidence";
import { batches, generate, validateIds, type SplitterParams } from "./protocol";
import { selectRawOutputs, selectWithoutRecords } from "./raw-evidence";
import {
  Consolidate,
  Discover,
  GroupPlan,
  IMPACT_SCALE,
  RAW_SYSTEM,
  SignalAssignments,
  type AssignedItem,
  type CanonicalNeed,
  type DiscoveredItem,
  type DiscoveredNeed,
  type PlannedGroup,
} from "./raw-protocol";

type RawItem = { id: string; record: SourceRecord; source: Source };
type AnalysisItem = RawItem & { kind: "feedback" | "context"; needIds: string[] };
type Evidence = SplitterSignal["evidence"];
const COUNTING_BASIS =
  "Distinct expressed feedback units, not customers or people. Explicit original/provider identities deduplicate reimports/syndication; cross-source URI+locator+content hashes identify reimports. Distinct IDs/customer identities remain independent even with identical text. Context is not a vote.";

/** Validate all protocol evidence at the boundary without ever printing source contents. */
function checkEvidence(evidence: Evidence, item: RawItem): void {
  if (
    evidence.recordId !== item.id ||
    evidence.sourceId !== item.record.sourceId ||
    evidence.sourceId !== item.source.id
  )
    throw new Error(`AI Splitter evidence source/record does not match item ${item.id}`);
  if (!item.record.text.includes(evidence.excerpt))
    throw new Error(`AI Splitter evidence excerpt is not verbatim in record ${item.id}`);
  if (evidence.locator !== undefined && evidence.locator !== item.record.locator)
    throw new Error(`AI Splitter evidence locator does not match record ${item.id}`);
}
function unique(ids: string[], description: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`AI Splitter duplicate ${description}`);
}
function coverage(ids: string[], expected: string[], description: string): void {
  unique(ids, description);
  const allowed = new Set(expected);
  if (ids.some((id) => !allowed.has(id))) throw new Error(`AI Splitter unknown ${description}`);
  const supplied = new Set(ids);
  if (expected.some((id) => !supplied.has(id)))
    throw new Error(`AI Splitter incomplete ${description} coverage`);
}
function bounded(payload: unknown): string {
  const prompt = JSON.stringify(payload);
  if (prompt.length > 96_000)
    throw new Error(
      "AI Splitter global catalog or fixed plan exceeds 96,000 prompt characters; reduce upstream size or grouping granularity. No evidence was truncated.",
    );
  return prompt;
}

/**
 * The model's plan for fixed car-part outputs: exactly the given ids, put back in port order, with
 * our labels and descriptions (the model only decides which needs go where).
 */
function fixedPlan(groups: PlannedGroup[], parts: CarPartOutput[]): PlannedGroup[] {
  unique(
    groups.map((g) => g.id),
    "planned group IDs",
  );
  coverage(
    groups.map((g) => g.id),
    parts.map((p) => p.id),
    "car-part groups",
  );
  const byId = new Map(groups.map((g) => [g.id, g]));
  return parts.map((part) => ({
    ...byId.get(part.id)!,
    label: part.label,
    description: part.description,
  }));
}

export async function analyzeRaw(input: PipelineData, params: SplitterParams, ctx: BlockContext) {
  // Split by car parts, the outputs are fixed by the chosen depth (Other last), not by the AI.
  const fixedParts = params.splitBy === "car_parts" ? carPartOutputs(params.partDepth) : null;
  const count = fixedParts?.length ?? params.branches.length;
  const customerMode = params.splitBy === "customer_priority";
  const models = new Set<string>();
  const limitations = new Set<string>([
    "Feedback counts are entries, not unique customers or population prevalence; customer count is unknown.",
    "Global need consolidation, opinion classification, stances, and expressed impact are AI judgements grounded in cited excerpts; confidence is separate from demand.",
    customerMode
      ? "Absent expressed supporting impact means no computed demand score. Context or unscored records use the default lowest band, not a real customer priority."
      : fixedParts
        ? "Absent expressed supporting impact means no computed demand score. Car-part routes follow the Car tab's parts, not customer priority; records about no specific part go to Other."
        : "Absent expressed supporting impact means no computed demand score. Custom routes follow semantic groups, not customer priority; unmatched records use the explicit default lowest output.",
  ]);
  const base = {
    mode: params.splitBy,
    instruction: params.splitBy === "custom" ? params.instruction : "",
  };
  const request = async <T>(payload: unknown, schema: import("zod").z.ZodType<T>) => {
    const response = await generate(ctx, {
      system: RAW_SYSTEM,
      prompt: bounded(payload),
      schema,
      tier: params.model,
    });
    models.add(response.model);
    ctx.log(
      `AI Splitter analytical response model ${response.model}; ${models.size} distinct models.`,
    );
    return response.object;
  };
  /**
   * One model answer that must pass `check` (known IDs, verbatim evidence, full coverage, …).
   * A model sometimes slips on one item in a batch; that answer is discarded and the same request
   * is asked once more. A second invalid answer fails the run. Nothing invalid is ever accepted,
   * and `check` only returns what it validated, so a discarded answer leaves no trace.
   */
  const validated = async <T, R>(
    what: string,
    payload: unknown,
    schema: import("zod").z.ZodType<T>,
    check: (answer: T) => R,
  ): Promise<R> => {
    try {
      return check(await request(payload, schema));
    } catch (error) {
      ctx.signal.throwIfAborted();
      ctx.log(
        `AI Splitter ${what}: the answer failed validation (${error instanceof Error ? error.message : String(error)}); asking once more.`,
      );
      return check(await request(payload, schema));
    }
  };
  let plan: PlannedGroup[] = [];
  let canonical: CanonicalNeed[] = [];
  const discovered = new Map<string, DiscoveredItem>();
  const discoveredNeeds: DiscoveredNeed[] = [];
  const sources = new Map(input.sources.map((s) => [s.id, s]));
  const rawItems: RawItem[] = input.records.map((record) => {
    const source = sources.get(record.sourceId);
    if (!source)
      throw new Error(
        `AI Splitter raw record ${record.id} references unavailable source ${record.sourceId}`,
      );
    return { id: record.id, record, source };
  });
  const units = feedbackUnits(input.records, sources);
  const assigned = new Map<string, AssignedItem>();

  if (rawItems.length) {
    const discoverPayload = (items: RawItem[], batchIndex = 0) => ({
      contract: "reqflow.ai-splitter.discover@1",
      ...base,
      branchCount: count,
      needIdPrefix: `d${batchIndex}_`,
      items,
    });
    // Preflight all records before the first call. Oversized content is a clear error, never a partial record.
    const discoveryBatches = batches(rawItems, (batch) => discoverPayload(batch, rawItems.length));
    for (const [batchIndex, batch] of discoveryBatches.entries()) {
      ctx.signal.throwIfAborted();
      const prefix = `d${batchIndex}_`;
      const { response, found } = await validated(
        `discovery batch ${batchIndex + 1}`,
        discoverPayload(batch, batchIndex),
        Discover,
        (response) => {
          const entries = validateIds(
            response.items,
            batch.map((i) => i.id),
          );
          unique(
            response.needs.map((n) => n.id),
            "discovery need IDs",
          );
          if (response.needs.some((n) => !n.id.startsWith(prefix)))
            throw new Error("AI Splitter discovery need uses wrong batch prefix");
          const needs = new Set(response.needs.map((n) => n.id));
          const used = new Set<string>();
          const found = new Map<string, DiscoveredItem>();
          for (const item of batch) {
            const entry = entries.get(item.id)!;
            unique(entry.needIds, "discovered item need IDs");
            if (entry.needIds.some((id) => !needs.has(id)))
              throw new Error("AI Splitter discovery item references unknown need");
            for (const id of entry.needIds) used.add(id);
            if (entry.evidence) checkEvidence(entry.evidence, item);
            if (entry.kind === "feedback" && !entry.evidence)
              throw new Error(`AI Splitter feedback ${item.id} requires verbatim opinion evidence`);
            // Eligibility is enforced in code even if the model treats sales/equipment facts as opinions.
            found.set(item.id, {
              ...entry,
              kind: FEEDBACK_KINDS.has(item.source.kind) ? entry.kind : "context",
            });
          }
          if (response.needs.some((n) => !used.has(n.id)))
            throw new Error("AI Splitter discovered an unsupported need without any record");
          return { response, found };
        },
      );
      for (const [id, entry] of found) discovered.set(id, entry);
      discoveredNeeds.push(...response.needs);
      ctx.log(
        `AI Splitter discovery batch ${batchIndex + 1}/${discoveryBatches.length}: ${batch.length} records, ${response.needs.length} candidate needs.`,
      );
      ctx.progress(
        (0.3 * (batchIndex + 1)) / discoveryBatches.length,
        "Discovering global customer needs",
      );
    }
    if (discoveredNeeds.length) {
      canonical = await validated(
        "consolidation",
        { contract: "reqflow.ai-splitter.consolidate@1", ...base, needs: discoveredNeeds },
        Consolidate,
        (response) => {
          unique(
            response.needs.map((n) => n.id),
            "canonical need IDs",
          );
          coverage(
            response.needs.flatMap((n) => n.aliasIds),
            discoveredNeeds.map((n) => n.id),
            "need aliases",
          );
          return response.needs;
        },
      );
      ctx.log(
        `AI Splitter consolidated ${discoveredNeeds.length} candidate needs into ${canonical.length} global needs.`,
      );
      if (customerMode) {
        plan = canonical.map((n) => ({
          id: n.id,
          label: n.label,
          description: n.description,
          needIds: [n.id],
          reason: "Globally consolidated customer need",
        }));
      } else {
        plan = await validated(
          "group plan",
          {
            contract: "reqflow.ai-splitter.plan@1",
            ...base,
            branchCount: count,
            ...(fixedParts ? { fixedGroups: fixedParts } : {}),
            needs: canonical,
          },
          GroupPlan,
          (planned) => {
            const groups = fixedParts ? fixedPlan(planned.groups, fixedParts) : planned.groups;
            if (groups.length !== count)
              throw new Error(`AI Splitter fixed group plan must contain exactly ${count} groups`);
            unique(
              groups.map((g) => g.id),
              "planned group IDs",
            );
            unique(
              groups.map((g) => g.label.toLowerCase()),
              "planned group labels",
            );
            coverage(
              groups.flatMap((g) => g.needIds),
              canonical.map((n) => n.id),
              "planned needs",
            );
            return groups;
          },
        );
      }
      const aliases = new Map(
        canonical.flatMap((n) => n.aliasIds.map((id) => [id, n.id] as const)),
      );
      const items: AnalysisItem[] = rawItems.map((item) => ({
        ...item,
        kind: discovered.get(item.id)!.kind,
        needIds: [...new Set(discovered.get(item.id)!.needIds.map((id) => aliases.get(id)!))],
      }));
      const assignPayload = (items: AnalysisItem[]) => ({
        contract: "reqflow.ai-splitter.assign@1",
        ...base,
        needs: canonical,
        groups: plan,
        items,
      });
      const assignmentBatches = batches(items, assignPayload);
      ctx.progress(0.5, "Fixed global group plan ready");
      for (const [batchIndex, batch] of assignmentBatches.entries()) {
        ctx.signal.throwIfAborted();
        const entries = await validated(
          `assignment batch ${batchIndex + 1}`,
          assignPayload(batch),
          SignalAssignments,
          (response) => {
            const entries = validateIds(
              response.items,
              batch.map((i) => i.id),
            );
            for (const item of batch) {
              const entry = entries.get(item.id)!;
              coverage(
                entry.signals.map((s) => s.needId),
                item.needIds,
                "assigned needs",
              );
              for (const signal of entry.signals) {
                checkEvidence(signal.evidence, item);
                if (
                  signal.impact !== null &&
                  (item.kind !== "feedback" || signal.stance !== "support")
                )
                  throw new Error(
                    `AI Splitter impact is only valid for supporting feedback ${item.id}`,
                  );
              }
            }
            return entries;
          },
        );
        for (const item of batch) assigned.set(item.id, entries.get(item.id)!);
        ctx.log(
          `AI Splitter assignment batch ${batchIndex + 1}/${assignmentBatches.length}: ${batch.length} records.`,
        );
        ctx.progress(
          0.5 + (0.4 * (batchIndex + 1)) / assignmentBatches.length,
          "Assigning evidence to fixed global groups",
        );
      }
    } else {
      for (const item of rawItems)
        assigned.set(item.id, {
          id: item.id,
          reason: discovered.get(item.id)!.reason,
          confidence: null,
          signals: [],
        });
      limitations.add(
        "No customer-facing needs were discovered; all records use the explicit default route.",
      );
    }
  } else
    limitations.add(
      "No raw records are available; customer demand cannot be computed. Original upstream context is retained once without an LLM call.",
    );

  if (!plan.length && fixedParts) {
    plan = fixedParts.map((part) => ({ ...part, needIds: [], reason: "No raw need evidence" }));
  } else if (!plan.length && !customerMode) {
    plan = Array.from({ length: count }, (_, i) => ({
      id: `empty_group_${i}`,
      label: `Unclassified ${i + 1}`,
      description: "No discovered need available",
      needIds: [],
      reason: "No raw need evidence",
    }));
  }
  ctx.signal.throwIfAborted();
  const groupByNeed = new Map(plan.flatMap((g) => g.needIds.map((id) => [id, g.id] as const)));
  const feedback = new Set(
    rawItems.filter((i) => discovered.get(i.id)?.kind === "feedback").map((i) => i.id),
  );
  const feedbackUnitIds = new Set([...feedback].map((id) => units.get(id)!));
  const contextUnitIds = new Set(
    rawItems.filter((i) => !feedbackUnitIds.has(units.get(i.id)!)).map((i) => units.get(i.id)!),
  );
  const needsById = new Map(canonical.map((need) => [need.id, need]));
  const signals: DemandSignal[] = [...assigned.values()].flatMap((item) =>
    item.signals.map((signal) => ({
      groupId: groupByNeed.get(signal.needId)!,
      needId: signal.needId,
      unitId: units.get(item.id)!,
      stance: signal.stance,
      impact: signal.impact,
      confidence: signal.confidence,
      evidence: signal.evidence,
      // The report contract has groupId, not needId. Preserve canonical secondary need identity
      // in the explanation when several needs share a car-part/custom output group.
      reason: `Need "${needsById.get(signal.needId)!.label}" (${signal.needId}): ${signal.reason}`,
    })),
  );
  const groups = calculateGroups(plan, signals, feedback, count, customerMode);
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const assignments: SplitterAssignment[] = rawItems.map((item) => {
    const assignment = assigned.get(item.id)!;
    const groupIds = [...new Set(assignment.signals.map((s) => groupByNeed.get(s.needId)!))];
    const candidates = groupIds.map((id) => groupsById.get(id)!);
    // Stable global plan order breaks equal scores within a record, not equal score bands.
    candidates.sort(
      (a, b) => (b.score ?? -1) - (a.score ?? -1) || groups.indexOf(a) - groups.indexOf(b),
    );
    const isFeedback = feedback.has(item.id);
    const primary = candidates[0] ?? null;
    const computed = isFeedback && primary?.score !== null && primary !== null;
    const outputPortId = customerMode
      ? computed
        ? primary!.outputPortId
        : `out-${count - 1}`
      : (primary?.outputPortId ?? `out-${count - 1}`);
    const routingReason = customerMode
      ? computed
        ? `${assignment.reason} Primary route follows highest globally scored need (${primary!.score}); secondary needs remain in the report.`
        : `${assignment.reason} ${isFeedback ? "Demand not computed" : "Context is not a feedback vote"}; explicit default lowest band, not a real customer priority.`
      : `${assignment.reason} ${primary ? "Primary route follows fixed global group plan, not a real customer priority; secondary groups remain in the report." : "No matched group; explicit default lowest output."}`;
    const reason = `Counting basis: ${isFeedback ? "expressed feedback unit" : "context, not a feedback vote"} (${item.source.kind}); ${discovered.get(item.id)!.reason}. ${routingReason}`;
    return {
      itemId: item.id,
      unitId: units.get(item.id)!,
      groupIds,
      primaryGroupId: primary?.id ?? null,
      outputPortId,
      reason,
      confidence: assignment.confidence,
      evidence: assignment.signals.length
        ? assignment.signals.map((s) => s.evidence)
        : discovered.get(item.id)!.evidence
          ? [discovered.get(item.id)!.evidence!]
          : [],
    };
  });
  const routes = new Map(assignments.map((a) => [a.itemId, Number(a.outputPortId.slice(4))]));
  const selection = rawItems.length
    ? selectRawOutputs(input, routes, count)
    : selectWithoutRecords(input, count);
  if (rawItems.length && "crossBranchEvidence" in selection && selection.crossBranchEvidence)
    limitations.add(
      "Shared upstream evidence references records in other outputs. Non-primary context follows linked records, but primary records are never duplicated; resolve cross-branch references through the original run/report.",
    );
  if ("unavailableReferenceCount" in selection && selection.unavailableReferenceCount)
    limitations.add(
      `${selection.unavailableReferenceCount} upstream evidence references are unavailable in this partial envelope; original links are retained and no replacement evidence is invented.`,
    );
  if (input.records.length > new Set(units.values()).size)
    limitations.add(
      "Explicitly identified duplicate/reimported units contribute once globally. Source matrix counts describe actual feedback units within each source and are not additive across syndicated/reimported sources or population denominators.",
    );
  const layer: DataKey = rawItems.length ? "records" : (primaryLayer(input) ?? "sources");
  if (!rawItems.length) {
    for (const item of input[layer])
      assignments.push({
        itemId: item.id,
        unitId: `unclassified_${item.id}`,
        groupIds: [],
        primaryGroupId: null,
        outputPortId: `out-${count - 1}`,
        reason:
          "No raw records: demand not computed; upstream context retained on explicit default lowest output.",
        confidence: null,
        evidence: [],
      });
  }
  const sourceMatrix = input.sources.flatMap((source) => {
    const sourceFeedback = new Set(
      rawItems
        .filter((i) => i.source.id === source.id && feedback.has(i.id))
        .map((i) => units.get(i.id)!),
    );
    return groups.map((group) => ({
      sourceId: source.id,
      groupId: group.id,
      ...stanceCounts(
        summarizeUnits(
          signals.filter((s) => s.groupId === group.id && s.evidence.sourceId === source.id),
          feedback,
        ),
      ),
      denominator: FEEDBACK_KINDS.has(source.kind) ? sourceFeedback.size : null,
    }));
  });
  const labels = customerMode ? bandLabels(count) : plan.map((g) => g.label);
  const report = SplitterReport.parse({
    schemaVersion: 1,
    runId: ctx.runId,
    blockId: ctx.blockId,
    createdAt: new Date().toISOString(),
    mode: params.splitBy,
    models: [...models],
    input: {
      primaryLayer: layer,
      primaryCount: input[layer].length,
      recordCount: input.records.length,
      sourceCount: input.sources.length,
      feedbackUnitCount: feedbackUnitIds.size,
      contextUnitCount: contextUnitIds.size,
      duplicateUnitCount: input.records.length - new Set(units.values()).size,
      customerCount: null,
      countingBasis: COUNTING_BASIS,
    },
    branches: labels.map((label, i) => ({
      portId: `out-${i}`,
      label,
      primaryItemCount: assignments.filter((a) => a.outputPortId === `out-${i}`).length,
    })),
    groups,
    assignments,
    // needId is internal aggregation identity; the unchanged public report contract uses groupId.
    signals: signals.map(({ needId: _needId, ...signal }) => signal),
    sourceMatrix,
    scoreMethod: {
      id: "customer-demand@1",
      frequencyWeight: 0.7,
      impactWeight: 0.3,
      formula:
        "F = 100 * distinct supporting feedback units / max_support across all global groups; I = mean available expressed supporting impact per distinct unit, after deduplicating canonical-need + verbatim-excerpt observations within each unit. Different anchor judgements on the same observation each contribute once to its mean; reimport copies add no impact weight. score = 0.7 * F + 0.3 * I. No available impact or no support: score = null. Context is excluded. Within-unit conflicting stances count as unclear.",
      impactScale: IMPACT_SCALE,
      thresholds: thresholds(count),
    },
    limitations: [...limitations],
    reviews: [],
  });
  ctx.log(
    `AI Splitter analytical counts: ${input.records.length} records, ${feedbackUnitIds.size} feedback units, ${contextUnitIds.size} context units, ${groups.length} groups; ${models.size} models.`,
  );
  ctx.progress(1, `Routed ${assignments.length} primary items; analytical report ready`);
  return { status: "ok" as const, outputs: selection.outputs, splitterReport: report };
}
