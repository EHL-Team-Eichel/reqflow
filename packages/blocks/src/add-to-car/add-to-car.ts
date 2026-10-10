import {
  emptyPipelineData,
  parseBlockParams,
  type Priority,
  type ProductScope,
} from "@reqflow/core";
import { defineBlock, type BlockContext } from "@reqflow/engine";
import { ADD_TO_CAR_ACTOR, deriveRequirements, type DeriveStats, type RankedInput } from "./derive";

/** Mirrors BLOCK_SPECS.add_to_car.params (validated by parseBlockParams before use). */
interface AddToCarParams {
  rankings: string[];
  vehicle: string; // "global" = from Settings
  market: string;
  mergeDuplicates: boolean;
}

const BY_POSITION: Priority[] = ["must", "should", "could", "wont"];
/** Short codes for requirement ids when the block overrides the vehicle line. */
const VEHICLE_CODES: Record<string, string> = {
  "1 Series": "F70",
  "5 Series": "G60",
  "7 Series": "G70",
};

/** "Must have" → must, "Nice to have" (3rd input) → could: the name wins, else the position. */
export function priorityForRanking(name: string, position: number): Priority {
  if (/must/i.test(name)) return "must";
  if (/should/i.test(name)) return "should";
  if (/could/i.test(name)) return "could";
  if (/won'?t|not now|later/i.test(name)) return "wont";
  return BY_POSITION[Math.min(position, BY_POSITION.length - 1)]!;
}

export function scopeFor(params: AddToCarParams, base: ProductScope): ProductScope {
  const scope = { ...base };
  if (params.vehicle !== "global" && params.vehicle !== base.vehicleLine) {
    scope.vehicleLine = params.vehicle;
    scope.vehicleCode = VEHICLE_CODES[params.vehicle] ?? base.vehicleCode;
    delete scope.derivative;
  }
  if (params.market !== "global") scope.market = params.market;
  return scope;
}

function report(stats: DeriveStats): string[] {
  const lines = [
    `Classified ${stats.records} comments: ${stats.byBmwTag} by BMW's classification, ` +
      `${stats.byKeywordRule} by keyword rules, ${stats.unclassified} matched no rule (not used).`,
  ];
  if (stats.unclear) {
    lines.push(`${stats.unclear} comments name a topic but no clear complaint, request or praise.`);
  }
  if (stats.heldBack) {
    lines.push(
      `${stats.heldBack} themes rest on a single comment: kept as findings, not turned into requirements.`,
    );
  }
  if (stats.coveredByInputFindings) {
    lines.push(
      `${stats.coveredByInputFindings} records were already covered by upstream findings.`,
    );
  }
  const skipped = Object.entries(stats.skippedByKind);
  if (skipped.length) {
    lines.push(
      `Not classified (not free text): ${skipped.map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", ")}.`,
    );
  }
  const unmapped = Object.entries(stats.unmappedTags).sort((a, b) => b[1] - a[1]);
  if (unmapped.length) {
    lines.push(
      `${unmapped.length} BMW classification names have no rule yet: ${unmapped
        .slice(0, 5)
        .map(([t, n]) => `${t} (${n})`)
        .join(", ")}${unmapped.length > 5 ? ", …" : ""}.`,
    );
  }
  return lines;
}

/**
 * Add to Car: sorts what arrives into component › aspect themes (BMW's own classification first,
 * keyword rules on untagged comments), derives one requirement per theme with complaints or
 * requests, and hands them to the Car page. The input an item arrives on sets its priority.
 * Fully deterministic: no LLM call, so it runs offline and gives the same result every time.
 */
export const addToCarBlock = defineBlock({
  kind: "add_to_car",
  async run(inputs, rawParams, ctx: BlockContext) {
    const params = parseBlockParams("add_to_car", rawParams) as unknown as AddToCarParams;
    const ranked: RankedInput[] = params.rankings.map((ranking, i) => ({
      ranking,
      priority: priorityForRanking(ranking, i),
      data: inputs[`in-${i}`] ?? emptyPipelineData(),
    }));
    const arrived = ranked.reduce((n, r) => n + r.data.records.length + r.data.findings.length, 0);
    if (arrived === 0) {
      ctx.log("Nothing arrived, so no requirements were added.");
      return { status: "ok", outputs: {} };
    }
    ctx.signal.throwIfAborted();
    ctx.progress(0.1, "Sorting feedback into themes");

    const derived = deriveRequirements(ranked, {
      scope: scopeFor(params, ctx.scope),
      runId: ctx.runId,
      now: new Date().toISOString(),
      mergeDuplicates: params.mergeDuplicates,
    });
    for (const line of report(derived.stats)) ctx.log(line);
    ctx.signal.throwIfAborted();
    ctx.progress(0.6, "Recording findings");

    // Findings live only in the audit trail until the Car page stores them (contract request in STATUS.md).
    // "$" marks a whole newly created entity; audit paths cannot be empty.
    const base = { actor: ADD_TO_CAR_ACTOR, runId: ctx.runId, blockId: ctx.blockId };
    for (const f of derived.findings) {
      await ctx.audit.record({
        ...base,
        action: "finding.extracted",
        entityType: "finding",
        entityId: f.id,
        changes: [{ path: "$", before: null, after: f }],
        rationale: `Theme ${f.themeId}: ${f.mentions} supporting comments.`,
      });
    }
    for (const f of derived.excluded) {
      await ctx.audit.record({
        ...base,
        action: "finding.excluded",
        entityType: "finding",
        entityId: f.id,
        changes: [{ path: "$", before: null, after: f }],
        rationale: f.outOfScopeReason ?? "Out of scope.",
      });
    }
    for (const r of derived.requirements) {
      await ctx.audit.record({
        ...base,
        action: "requirement.proposed",
        entityType: "requirement",
        entityId: r.id,
        changes: [{ path: "$", before: null, after: r }],
        rationale: r.priorityRationale ?? "",
      });
    }
    ctx.progress(0.9, "Adding requirements to the car");
    await ctx.car.add(derived.requirements);

    const byPriority = BY_POSITION.map(
      (p) => [p, derived.requirements.filter((r) => r.priority === p).length] as const,
    ).filter(([, n]) => n > 0);
    ctx.log(
      `Added ${derived.requirements.length} requirements (${byPriority.map(([p, n]) => `${n} ${p}`).join(", ") || "none"}) ` +
        `from ${derived.themes.length} themes; ${derived.excluded.length} findings were out of scope.`,
    );
    ctx.progress(1);
    return { status: "ok", outputs: {} };
  },
});
