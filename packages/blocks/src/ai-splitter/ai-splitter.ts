import { DATA_KEYS, countPipelineData, emptyPipelineData } from "@reqflow/core";
import { defineBlock } from "@reqflow/engine";
import {
  emptyMembership,
  emptyOutputs,
  evidenceIndex,
  primaryLayer,
  retainOrphans,
  select,
  validateInput,
  type PromptItem,
} from "./evidence";
import { priorityBranches, routePriority } from "./priority";
import { analyzeRaw } from "./raw-analysis";
import { selectRawOutputs } from "./raw-evidence";
import {
  Assignments,
  ROUTING_SYSTEM,
  SplitterParams,
  batches,
  generate,
  validateIds,
} from "./protocol";

export const aiSplitterBlock = defineBlock({
  kind: "ai_splitter",
  reroute(input, report) {
    if (report.input.primaryLayer !== "records")
      throw new Error("Routing corrections currently require a raw-record analytical report.");
    validateInput(input);
    return selectRawOutputs(
      input,
      new Map(report.assignments.map((a) => [a.itemId, Number(a.outputPortId.slice(4))])),
      report.branches.length,
    ).outputs;
  },
  async run(inputs, rawParams, ctx) {
    ctx.signal.throwIfAborted();
    const params = SplitterParams.parse(rawParams);
    const ports = Object.keys(inputs);
    if (ports.some((port) => port !== "in"))
      throw new Error("AI Splitter supports only input port in");
    const input = Object.hasOwn(inputs, "in") ? inputs.in! : emptyPipelineData();
    validateInput(input);
    if (
      params.splitBy === "customer_priority" ||
      params.splitBy === "car_parts" ||
      (params.splitBy === "custom" && (input.records.length > 0 || !primaryLayer(input)))
    ) {
      return analyzeRaw(input, params, ctx);
    }
    if (params.splitBy === "priority") priorityBranches(params.branches);
    const counts = countPipelineData(input);
    ctx.log(
      `AI Splitter input: ${JSON.stringify(counts)}. ${params.branches.length} outputs, mode ${params.splitBy}.`,
    );
    ctx.progress(0, "Validating and preparing routing");
    const outputs = emptyOutputs(params.branches.length);
    const layer = primaryLayer(input);
    if (!layer) {
      if (input.sources.length) {
        outputs["out-0"] = input;
        ctx.log(
          `Source-only input: retained ${input.sources.length} sources as unclassified context on out-0; no LLM call.`,
        );
      } else ctx.log("Empty input; all output envelopes empty, no LLM call.");
      ctx.progress(1, "No primary items to route");
      return { status: "ok", outputs };
    }
    const index = evidenceIndex(input, ctx.log);
    const closures = new Map(input[layer].map((item) => [item.id, index.closure(layer, item.id)]));
    const items: PromptItem[] = input[layer].map((item) => {
      const context = index.context(closures.get(item.id)!);
      context[layer] = []; // Primary item is supplied once; dependencies are only contextual data.
      return { id: item.id, layer, item, context };
    });
    ctx.log(
      `Routing ${items.length} primary ${layer}; upstream evidence follows dependencies, not independent classification.`,
    );
    let routes: Map<string, number>;
    if (params.splitBy === "priority") routes = await routePriority(items, params, ctx);
    else {
      routes = new Map();
      const payload = (batch: PromptItem[]) => ({
        contract: "reqflow.ai-splitter.routing@1",
        mode: params.splitBy,
        branches: params.branches,
        instruction: params.splitBy === "custom" ? params.instruction : "",
        items: batch,
      });
      const groups = batches(items, payload);
      for (const [batchIndex, batch] of groups.entries()) {
        ctx.signal.throwIfAborted();
        ctx.log(`Routing batch ${batchIndex + 1}/${groups.length}: ${batch.length} primary items.`);
        // A single invalid answer (unknown ID or branch) is asked once more, then fails the run.
        const route = async () => {
          const { object, model } = await generate(ctx, {
            system: ROUTING_SYSTEM,
            prompt: JSON.stringify(payload(batch)),
            schema: Assignments,
            tier: params.model,
          });
          const assignments = validateIds(
            object.assignments,
            batch.map((item) => item.id),
          );
          for (const entry of batch) {
            const assignment = assignments.get(entry.id)!;
            if (assignment.branchIndex >= params.branches.length) {
              throw new Error(
                `AI Splitter assignment ${entry.id} uses unknown branchIndex ${assignment.branchIndex}`,
              );
            }
          }
          return { assignments, model };
        };
        let answer;
        try {
          answer = await route();
        } catch (error) {
          ctx.signal.throwIfAborted();
          ctx.log(
            `Routing batch ${batchIndex + 1}: the answer failed validation (${error instanceof Error ? error.message : String(error)}); asking once more.`,
          );
          answer = await route();
        }
        for (const entry of batch) {
          const assignment = answer.assignments.get(entry.id)!;
          routes.set(entry.id, assignment.branchIndex);
          ctx.log(`Routed 1 primary item to out-${assignment.branchIndex}, model ${answer.model}.`);
        }
        ctx.progress(
          routes.size / items.length,
          `Routed ${routes.size}/${items.length} primary items`,
        );
      }
    }
    ctx.signal.throwIfAborted();
    const memberships = params.branches.map(() => emptyMembership());
    for (const item of items) {
      const branchIndex = routes.get(item.id);
      if (branchIndex === undefined)
        throw new Error(`AI Splitter is missing a route for ${item.id}`);
      const membership = memberships[branchIndex];
      if (!membership)
        throw new Error(`AI Splitter route ${item.id} uses unknown branch ${branchIndex}`);
      const closure = closures.get(item.id)!;
      for (const key of DATA_KEYS) for (const id of closure[key]) membership[key].add(id);
    }
    retainOrphans(input, memberships, index, ctx.log);
    for (const [branchIndex, membership] of memberships.entries()) {
      if (membership[layer].size) outputs[`out-${branchIndex}`] = select(input, membership);
      ctx.log(
        `out-${branchIndex} (${params.branches[branchIndex]}): ${JSON.stringify(countPipelineData(outputs[`out-${branchIndex}`]!))}`,
      );
    }
    ctx.progress(
      1,
      `Routed ${items.length}/${items.length} primary items; supporting context retained`,
    );
    return { status: "ok", outputs };
  },
});
