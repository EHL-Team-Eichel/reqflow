import {
  addToCarInputs,
  emptyPipelineData,
  parseBlockParams,
  PipelineData,
  type Actor,
  type AgentRole,
  type ProductScope,
} from "@reqflow/core";
import { defineBlock } from "@reqflow/engine";
import { runAgents } from "./agents/pipeline";

/** Mirrors BLOCK_SPECS.add_to_car.params (validated by parseBlockParams before use). */
interface AddToCarParams {
  priorities: number;
  contexts: string[];
  maxRequirements: number;
  vehicle: string; // "global" = from Settings
  market: string;
}

/** Short codes for requirement ids when the block overrides the vehicle line. */
const VEHICLE_CODES: Record<string, string> = {
  "1 Series": "F70",
  "5 Series": "G60",
  "7 Series": "G70",
};

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

/**
 * Add to Car: a team of AI agents turns what arrives into requirements for the successor.
 * "1. Priority" … "n. Priority" carry the evidence (the input an item arrives on sets its
 * ranking); context inputs are background the agents read but never turn into requirements.
 * Every requirement gets a confidence score, and the agents' thought process is kept for the
 * thought-process view. See agents/pipeline.ts.
 */
export const addToCarBlock = defineBlock({
  kind: "add_to_car",
  async run(inputs, rawParams, ctx) {
    const params = parseBlockParams("add_to_car", rawParams) as unknown as AddToCarParams;
    const { priorities, contexts } = addToCarInputs(params as unknown as Record<string, unknown>);
    const ports = new Set([...priorities.map((p) => p.port), ...contexts.map((c) => c.port)]);
    for (const port of Object.keys(inputs)) {
      if (!ports.has(port)) throw new Error(`Add to Car has no input "${port}"`);
    }
    const data = (port: string) => PipelineData.parse(inputs[port] ?? emptyPipelineData());
    const priorityData = priorities.map((p) => ({ ...p, data: data(p.port) }));
    const contextData = contexts.map((c) => ({ ...c, data: data(c.port) }));
    const arrived = priorityData.reduce(
      (n, p) => n + p.data.records.length + p.data.findings.length + p.data.requirements.length,
      0,
    );
    if (arrived === 0) {
      ctx.log(
        contextData.some((c) => c.data.records.length)
          ? "Only context arrived. Context is background, so no requirements were added: connect data to a priority input."
          : "Nothing arrived on the priority inputs, so no requirements were added.",
      );
      return { status: "ok", outputs: {} };
    }

    const scope = scopeFor(params, ctx.scope);
    const firstSeq = (await ctx.car.nextSeq?.(scope)) ?? 1;
    const result = await runAgents(ctx, {
      priorities: priorityData,
      contexts: contextData,
      maxRequirements: params.maxRequirements,
      scope,
      firstSeq,
    });
    ctx.signal.throwIfAborted();
    ctx.progress(0.96, "Recording the results");

    // Every created finding and requirement is audited in full ("$" = the whole new entity).
    const modelOf = (role: AgentRole) =>
      result.trace.steps.find((s) => s.role === role)?.model ?? "unknown";
    const actor = (role: AgentRole): Actor => ({
      type: "ai",
      component: `add_to_car.${role}`,
      model: modelOf(role),
    });
    const base = { runId: ctx.runId, blockId: ctx.blockId };
    for (const f of result.findings) {
      await ctx.audit.record({
        ...base,
        actor: actor("analyst"),
        action: "finding.extracted",
        entityType: "finding",
        entityId: f.id,
        changes: [{ path: "$", before: null, after: f }],
        rationale: `${f.mentions} supporting record(s).`,
      });
    }
    for (const f of result.excluded) {
      await ctx.audit.record({
        ...base,
        actor: actor("analyst"),
        action: "finding.excluded",
        entityType: "finding",
        entityId: f.id,
        changes: [{ path: "$", before: null, after: f }],
        rationale: f.outOfScopeReason ?? "Out of scope.",
      });
    }
    for (const r of result.requirements) {
      await ctx.audit.record({
        ...base,
        actor: actor("architect"),
        action: "requirement.proposed",
        entityType: "requirement",
        entityId: r.id,
        changes: [{ path: "$", before: null, after: r }],
        rationale: r.priorityRationale ?? "",
      });
      await ctx.audit.record({
        ...base,
        actor: actor("judge"),
        action: "requirement.scored",
        entityType: "requirement",
        entityId: r.id,
        changes: [
          { path: "score", before: null, after: r.score },
          { path: "confidence", before: null, after: r.confidence },
        ],
        rationale: `Critic's score ${r.score?.total ?? "–"}/100; confidence ${Math.round((r.confidence?.value ?? 0) * 100)} % (${r.confidence?.level ?? "–"}).`,
      });
    }

    // Store the evidence with the requirements, so the Car page can show quotes and sources.
    await ctx.car.add(result.requirements, {
      sources: result.sources,
      records: result.records,
      findings: [...result.findings, ...result.excluded, ...result.upstreamUsed],
      themes: result.themes,
    });
    await ctx.car.saveReasoning?.(result.trace);

    const t = result.trace.totals;
    ctx.log(
      `Added ${result.requirements.length} requirement(s) from ${result.themes.length} theme(s); ` +
        `${result.trace.heldBack.length} held back. ${t.calls} AI call(s), ${Math.round(t.durationMs / 1000)} s` +
        (result.trace.offline ? " (offline demo, no AI)." : "."),
    );
    ctx.progress(1);
    return { status: "ok", outputs: {} };
  },
});
