import {
  isPaletteBlockKind,
  walkBlocks,
  type BlockPreview,
  type ProductScope,
  type ReqflowApi,
  type WorkflowBlock,
  type WorkflowRun,
} from "@reqflow/core";
import { loadRunOutput } from "./research-results";

const sameJson = (a: unknown, b: unknown) => {
  const stable = (value: unknown) =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  return stable(a) === stable(b);
};

/** Research preview reads a completed source output; it never collects or plans new queries. */
export async function previewSource(
  client: {
    blocks: Pick<ReqflowApi["blocks"], "preview">;
    runs: Pick<ReqflowApi["runs"], "blockOutput">;
  },
  block: WorkflowBlock,
  scope: ProductScope,
  run: WorkflowRun | null,
): Promise<BlockPreview> {
  const isResearch = block.kind === "research" || block.kind === "research_opencode";
  if (!isResearch) {
    if (!isPaletteBlockKind(block.kind)) throw new Error("This block is not a previewable source.");
    return client.blocks.preview({ kind: block.kind, params: block.params, scope });
  }
  const saved = run && [...walkBlocks(run.graph)].find(({ block: b }) => b.id === block.id);
  if (
    !run ||
    !saved ||
    (saved.block.kind !== "research" && saved.block.kind !== "research_opencode")
  )
    throw new Error("No saved Research output for this block. Run the flow first.");
  if (
    !sameJson(saved.block.params, block.params) ||
    !sameJson(saved.block.inner, block.inner) ||
    !sameJson(run.scope, scope)
  )
    throw new Error(
      "Research configuration has changed since the saved run. Run the flow again to preview it.",
    );
  const state = run.blockRuns.find((entry) => entry.blockId === block.id);
  if (state?.status !== "succeeded")
    throw new Error(
      "Research has no completed output yet. Run the flow and wait for Research to finish.",
    );
  const outputs = await loadRunOutput(client, run.id, block.id);
  if (!outputs.out) throw new Error("The saved Research output is missing. Run the flow again.");
  return { outputs, logs: [`Saved Research output from run ${run.id}.`] };
}
