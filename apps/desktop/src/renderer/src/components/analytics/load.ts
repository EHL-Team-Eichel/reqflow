import {
  analyticsInputs,
  blockPorts,
  graphAt,
  isBoundaryBlockKind,
  isPaletteBlockKind,
  mergePipelineData,
  PipelineData,
  type BlockPreview,
  type BlockPreviewRequest,
  type ProductScope,
  type ReqflowApi,
  type WorkflowBlock,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowRun,
} from "@reqflow/core";
import type { AnalyticsInput } from "./engine/types";

/**
 * Where each input of an Analytics block gets its data. After a run: the saved output of every
 * block wired into the input (exactly what arrived, never a fresh read). Without a run: a source
 * block (Raw, Research without a sub-flow) can be read on its own; anything that transforms data
 * needs a run first, and the input says so instead of showing something it didn't receive.
 */

export interface InputPlan {
  index: number;
  port: string;
  label: string;
  edges: { edge: WorkflowEdge; source: WorkflowBlock | undefined }[];
}

export function planInputs(
  root: WorkflowGraph,
  path: readonly string[],
  blockId: string,
): InputPlan[] {
  const graph = graphAt(root, [...path]);
  const block = graph.blocks.find((b) => b.id === blockId);
  if (!block) throw new Error("The Analytics block is no longer on this workplace.");
  return analyticsInputs(block.params).map((port, index) => ({
    index,
    port: port.id,
    label: port.label,
    edges: graph.edges
      .filter((e) => e.target === blockId && e.targetPort === port.id)
      .map((edge) => ({ edge, source: graph.blocks.find((b) => b.id === edge.source) })),
  }));
}

/** A block that produces data on its own (no inputs, no sub-flow), so it can be previewed. */
export function isPreviewable(block: WorkflowBlock | undefined): boolean {
  if (!block || !isPaletteBlockKind(block.kind)) return false;
  if (blockPorts(block).inputs.length > 0) return false;
  return !block.inner?.blocks.some((b) => !isBoundaryBlockKind(b.kind));
}

export interface LoadDeps {
  run: WorkflowRun | null;
  scope: ProductScope;
  blockOutput: ReqflowApi["runs"]["blockOutput"];
  preview: (request: BlockPreviewRequest) => Promise<BlockPreview>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function loadInputs(
  plans: readonly InputPlan[],
  deps: LoadDeps,
): Promise<AnalyticsInput[]> {
  const outputs = new Map<string, Promise<Record<string, unknown>>>();
  const outputOf = (block: WorkflowBlock): Promise<Record<string, unknown>> => {
    let p = outputs.get(block.id);
    if (!p) {
      p = deps.run
        ? deps.blockOutput(deps.run.id, block.id)
        : deps
            .preview({
              kind: block.kind as BlockPreviewRequest["kind"],
              params: block.params,
              scope: deps.scope,
            })
            .then((res) => res.outputs);
      outputs.set(block.id, p);
    }
    return p;
  };

  return Promise.all(
    plans.map(async (plan): Promise<AnalyticsInput> => {
      const base = { index: plan.index, port: plan.port, label: plan.label };
      if (!plan.edges.length) {
        return {
          ...base,
          status: "unconnected",
          data: null,
          message: "Nothing is connected to this input.",
        };
      }
      if (!deps.run) {
        const blocked = plan.edges.find(({ source }) => !isPreviewable(source));
        if (blocked) {
          return {
            ...base,
            status: "needs_run",
            data: null,
            message: `"${blocked.source?.label ?? blocked.edge.source}" changes the data on its way here. Start the flow to see what arrives.`,
          };
        }
      }
      try {
        const parts = await Promise.all(
          plan.edges.map(async ({ edge, source }) => {
            if (!source) throw new Error(`Block "${edge.source}" is missing.`);
            const output = (await outputOf(source))[edge.sourcePort];
            if (output === undefined) {
              throw new Error(
                deps.run
                  ? `"${source.label}" has no saved output in this run yet.`
                  : `"${source.label}" returned nothing on its "${edge.sourcePort}" port.`,
              );
            }
            const parsed = PipelineData.safeParse(output);
            if (!parsed.success)
              throw new Error(`"${source.label}" sent data in an unexpected shape.`);
            return parsed.data;
          }),
        );
        return { ...base, status: "ready", data: mergePipelineData(...parts) };
      } catch (err) {
        const text = message(err);
        const pending = !!deps.run && /no saved output|No outputs found/i.test(text);
        return {
          ...base,
          status: pending ? "needs_run" : "error",
          data: null,
          message: pending
            ? "The saved run hasn't reached this input yet. Start or continue the flow to fill it."
            : text,
        };
      }
    }),
  );
}
