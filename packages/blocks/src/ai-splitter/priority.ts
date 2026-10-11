import {
  describeDrivers,
  Priority,
  rescoreBreakdown,
  Settings,
  type Finding,
  type PipelineData,
  type Requirement,
  type SourceRecord,
} from "@reqflow/core";
import type { BlockContext } from "@reqflow/engine";
import {
  PRIORITIZATION_METHOD,
  scoreItem,
  type JudgedFactor,
  type Judgement,
  type ScoringEvidence,
} from "../prioritization";
import type { PromptItem } from "./evidence";
import {
  SCORING_SYSTEM,
  Scores,
  batches,
  generate,
  validateIds,
  type SplitterParams,
} from "./protocol";

/**
 * Evidence claims need an available ID and verbatim quotation; unmeasured judgement is an
 * assumption. Returns why a note can't count as evidence, or null when it can.
 */
function noteProblem(note: string, entry: PromptItem, factor: JudgedFactor): string | null {
  if (/^(Assumption:|MOCK assumption:)/i.test(note)) return null;
  const match = /^Evidence:\s*(src_\S+|rec_\S+)\s*\|\s*("(?:[^"\\]|\\.)*")\s*\|\s*\S.+$/i.exec(
    note,
  );
  if (!match)
    return `Provisional ${entry.id} factor ${factor} note must identify Assumption: or Evidence: ID | "verbatim excerpt" | judgement`;
  const id = match[1]!;
  let excerpt: string;
  try {
    excerpt = JSON.parse(match[2]!) as string;
  } catch {
    return `Provisional ${entry.id} factor ${factor} evidence quote must be JSON-quoted`;
  }
  const records = [
    ...entry.context.records,
    ...(entry.layer === "records" ? [entry.item as PipelineData["records"][number]] : []),
  ];
  const findings = [
    ...entry.context.findings,
    ...(entry.layer === "findings" ? [entry.item as PipelineData["findings"][number]] : []),
  ];
  // Verbatim means copied from what the model was given: a record's text or one of its field
  // values (e.g. the channel "dealer survey" behind evidence strength), or its source's metadata.
  const texts = [
    ...records
      .filter((record) => record.id === id || record.sourceId === id)
      .flatMap((record) => [
        record.text,
        ...Object.values(record.fields ?? {}).flatMap((v) =>
          v === null || v === undefined || typeof v === "object" ? [] : [String(v)],
        ),
      ]),
    ...entry.context.sources
      .filter((source) => source.id === id)
      .flatMap((source) =>
        [source.title, source.publisher, source.uri].filter((v): v is string => !!v),
      ),
    ...findings.flatMap((finding) =>
      finding.evidence
        .filter((ref) => ref.sourceId === id || ref.recordId === id)
        .map((ref) => ref.excerpt),
    ),
  ];
  if (!excerpt.trim() || !texts.some((text) => text.includes(excerpt)))
    return `Provisional ${entry.id} factor ${factor} cites unknown evidence or a non-verbatim excerpt`;
  return null;
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
  const now = new Date().toISOString();
  ctx.log(
    `Scoring items with ${PRIORITIZATION_METHOD}. Reuse existing priority/score values; unprioritized items use deterministic evidence factors + provisional brand_fit/ease LLM judgement for routing, without persisting changes.`,
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
      const rescored = rescoreBreakdown(requirement.score, scoring, requirement.evidenceLevel, now);
      const branch = branchFor(rescored.suggestedPriority, entry.id, ctx.log);
      result.set(entry.id, branch);
      ctx.log(
        `${entry.id}: total ${rescored.total}/100, ${rescored.suggestedPriority}, out-${branch}, driven by ${describeDrivers(rescored)}. Stored score unchanged.`,
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
    factors: ["brand_fit", "ease"] as const,
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
      // A note that can't be verified is never kept as evidence: its factor counts as an
      // assumption (routing scores are provisional judgement anyway), and the log says so.
      for (const factor of ["brand_fit", "ease"] as const) {
        const problem = noteProblem(score.factors[factor].note, entry, factor);
        if (problem) ctx.log(`${problem}; counted as an unverified assumption, not evidence.`);
      }
      // A requirement's own links say which context findings support it and which argue against it.
      const requirement = entry.layer === "requirements" ? (entry.item as Requirement) : undefined;
      const linked = (ids: readonly string[]) =>
        entry.context.findings.filter((f) => ids.includes(f.id));
      const findings = requirement
        ? linked(requirement.findingIds)
        : [
            ...entry.context.findings,
            ...(entry.layer === "findings" ? [entry.item as Finding] : []),
          ];
      const conflicting = requirement ? linked(requirement.conflictingFindingIds) : undefined;
      const records = [
        ...entry.context.records,
        ...(entry.layer === "records" ? [entry.item as SourceRecord] : []),
      ];
      const sources = entry.context.sources;
      const evidence: ScoringEvidence = {
        findings,
        conflicting,
        records,
        sources,
      };
      const judged: Record<JudgedFactor, Judgement> = {
        brand_fit: {
          value: score.factors.brand_fit.value,
          note: score.factors.brand_fit.note,
          by: model,
        },
        ease: {
          value: score.factors.ease.value,
          note: score.factors.ease.note,
          by: model,
        },
      };
      const breakdown = scoreItem({
        evidence,
        judged,
        evidenceLevel: requirement?.evidenceLevel,
        scoring,
        now,
      });
      const priority = breakdown.suggestedPriority;
      const branch = branchFor(priority, entry.id, ctx.log);
      result.set(entry.id, branch);
      ctx.log(
        `${entry.id}: total ${breakdown.total}/100, ${priority}, out-${branch}, driven by ${describeDrivers(breakdown)}.`,
      );
    }
    completed += batch.length;
    ctx.progress(completed / items.length, `Scored ${completed}/${items.length} primary items`);
  }
  return result;
}
