import {
  Priority,
  ScoreFactor,
  Settings,
  priorityForScore,
  weightedTotal,
  type PipelineData,
  type Requirement,
} from "@reqflow/core";
import type { BlockContext } from "@reqflow/engine";
import type { PromptItem } from "./evidence";
import {
  SCORING_SYSTEM,
  Scores,
  batches,
  generate,
  validateIds,
  type SplitterParams,
} from "./protocol";

/** Evidence claims need an available ID and verbatim quotation; unmeasured judgement is an assumption. */
function validateNote(note: string, entry: PromptItem, factor: ScoreFactor): void {
  if (/^(Assumption:|MOCK assumption:)/i.test(note)) return;
  const match = /^Evidence:\s*(src_\S+|rec_\S+)\s*\|\s*("(?:[^"\\]|\\.)*")\s*\|\s*\S.+$/i.exec(
    note,
  );
  if (!match)
    throw new Error(
      `Provisional ${entry.id} factor ${factor} note must identify Assumption: or Evidence: ID | "verbatim excerpt" | judgement`,
    );
  const id = match[1]!;
  let excerpt: string;
  try {
    excerpt = JSON.parse(match[2]!) as string;
  } catch {
    throw new Error(`Provisional ${entry.id} factor ${factor} evidence quote must be JSON-quoted`);
  }
  const records = [
    ...entry.context.records,
    ...(entry.layer === "records" ? [entry.item as PipelineData["records"][number]] : []),
  ];
  const findings = [
    ...entry.context.findings,
    ...(entry.layer === "findings" ? [entry.item as PipelineData["findings"][number]] : []),
  ];
  const texts = [
    ...records
      .filter((record) => record.id === id || record.sourceId === id)
      .map((record) => record.text),
    ...findings.flatMap((finding) =>
      finding.evidence
        .filter((ref) => ref.sourceId === id || ref.recordId === id)
        .map((ref) => ref.excerpt),
    ),
  ];
  if (!excerpt.trim() || !texts.some((text) => text.includes(excerpt))) {
    throw new Error(
      `Provisional ${entry.id} factor ${factor} cites unknown evidence or a non-verbatim excerpt`,
    );
  }
}

/** Named bands only. Contiguous upper bands may coarsen omitted lower bands, always with a log. */
export function priorityBranches(labels: string[]) {
  const map = new Map<Priority, number>();
  for (const [index, label] of labels.entries()) {
    const normalized = label
      .toLowerCase()
      .replace(/[\s'’\-]/g, "")
      .replace(/have$/, "");
    const parsed = Priority.safeParse(normalized);
    if (!parsed.success || map.has(parsed.data)) {
      throw new Error(
        "Priority branches must have unique named bands: Must have, Should have, Could have, Won't have. Use another mode for arbitrary labels.",
      );
    }
    map.set(parsed.data, index);
  }
  const bands = Priority.options;
  if (labels.length > 4 || bands.slice(0, labels.length).some((band) => !map.has(band))) {
    throw new Error(
      "Priority branches must include contiguous upper bands: Must + Should, optionally Could and Won't. Missing intermediate bands are ambiguous.",
    );
  }
  const lowest = bands[labels.length - 1]!;
  return (priority: Priority, id: string, log: BlockContext["log"]): number => {
    const matched = map.get(priority);
    if (matched !== undefined) return matched;
    const branch = map.get(lowest)!;
    log(
      `${id}: priority ${priority} has no named branch; fallback to ${labels[branch]} (out-${branch}), coarsening omitted lower bands.`,
    );
    return branch;
  };
}

export async function routePriority(
  items: PromptItem[],
  params: SplitterParams,
  ctx: BlockContext,
): Promise<Map<string, number>> {
  const branchFor = priorityBranches(params.branches);
  const scoring = Settings.shape.scoring.parse(ctx.settings.scoring);
  const result = new Map<string, number>();
  const pending: PromptItem[] = [];
  ctx.log(
    "WS8 deterministic scorer is unavailable. Reuse existing priority/factor values; missing factors use provisional LLM judgement only for routing, without persisting requirement changes.",
  );
  for (const entry of items) {
    ctx.signal.throwIfAborted();
    const requirement = entry.layer === "requirements" ? (entry.item as Requirement) : undefined;
    if (requirement?.priority) {
      const branch = branchFor(requirement.priority, entry.id, ctx.log);
      result.set(entry.id, branch);
      ctx.log(
        `${entry.id}: existing priority ${requirement.priority} preserved (including any human override); routed to out-${branch}.`,
      );
    } else if (requirement?.score) {
      const values = Object.fromEntries(
        ScoreFactor.options.map((factor) => [factor, requirement.score!.factors[factor].value]),
      ) as Record<ScoreFactor, number>;
      const total = weightedTotal(values, scoring.weights);
      const priority = priorityForScore(total, scoring.thresholds);
      const branch = branchFor(priority, entry.id, ctx.log);
      result.set(entry.id, branch);
      ctx.log(
        `${entry.id}: reused existing factor values with current Settings weights/thresholds; total ${total}/100, priority ${priority}, out-${branch}. Stored score unchanged.`,
      );
      for (const factor of ScoreFactor.options)
        ctx.log(
          `${entry.id}: ${factor}=${values[factor]}/5, weight=${scoring.weights[factor]}; evidence notes retained upstream, not logged.`,
        );
    } else pending.push(entry);
  }
  const payload = (batch: PromptItem[]) => ({
    contract: "reqflow.ai-splitter.scoring@1",
    mode: "priority",
    branches: params.branches,
    instruction: "",
    items: batch,
    scope: ctx.scope,
    factors: ScoreFactor.options,
  });
  const groups = batches(pending, payload);
  let completed = result.size;
  ctx.progress(
    completed / items.length,
    `Resolved ${completed}/${items.length} existing priorities`,
  );
  for (const [index, batch] of groups.entries()) {
    ctx.signal.throwIfAborted();
    ctx.log(
      `Provisional scoring batch ${index + 1}/${groups.length}: ${batch.length} primary items.`,
    );
    // A single invalid answer (unknown ID, non-verbatim evidence) is asked once more, then fails.
    const scoreBatch = async () => {
      const { object, model } = await generate(ctx, {
        system: SCORING_SYSTEM,
        prompt: JSON.stringify(payload(batch)),
        schema: Scores,
        tier: params.model,
      });
      const scores = validateIds(
        object.scores,
        batch.map((item) => item.id),
      );
      for (const entry of batch)
        for (const factor of ScoreFactor.options)
          validateNote(scores.get(entry.id)!.factors[factor].note, entry, factor);
      return { scores, model };
    };
    let answer;
    try {
      answer = await scoreBatch();
    } catch (error) {
      ctx.signal.throwIfAborted();
      ctx.log(
        `Provisional scoring batch ${index + 1}: the answer failed validation (${error instanceof Error ? error.message : String(error)}); asking once more.`,
      );
      answer = await scoreBatch();
    }
    const { scores, model } = answer;
    for (const entry of batch) {
      const score = scores.get(entry.id)!;
      const values = Object.fromEntries(
        ScoreFactor.options.map((factor) => [factor, score.factors[factor].value]),
      ) as Record<ScoreFactor, number>;
      const total = weightedTotal(values, scoring.weights);
      const priority = priorityForScore(total, scoring.thresholds);
      const branch = branchFor(priority, entry.id, ctx.log);
      result.set(entry.id, branch);
      ctx.log(
        `${entry.id}: provisional LLM factors (${model}), total ${total}/100, priority ${priority}, out-${branch}; judgement is not measured data or a human decision. Requirement unchanged.`,
      );
      for (const factor of ScoreFactor.options)
        ctx.log(
          `${entry.id}: ${factor}=${values[factor]}/5, weight=${scoring.weights[factor]}; validated provisional evidence/assumption note omitted from logs.`,
        );
    }
    completed += batch.length;
    ctx.progress(completed / items.length, `Scored ${completed}/${items.length} primary items`);
  }
  return result;
}
