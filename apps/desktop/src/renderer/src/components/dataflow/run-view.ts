import {
  blockPorts,
  PipelineData,
  walkBlocks,
  type BlockRun,
  type WorkflowBlock,
  type WorkflowRun,
} from "@reqflow/core";

export const BLOCK_STATUS_LABELS: Record<BlockRun["status"], string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  waiting_for_review: "Waiting for review",
};

export function snapshotBlock(run: WorkflowRun | null, blockId: string): WorkflowBlock | null {
  return run
    ? ([...walkBlocks(run.graph)].find(({ block }) => block.id === blockId)?.block ?? null)
    : null;
}

export function blockDraftChanged(draft: WorkflowBlock, saved: WorkflowBlock): boolean {
  return (
    JSON.stringify([draft.kind, draft.params, draft.inner]) !==
    JSON.stringify([saved.kind, saved.params, saved.inner])
  );
}

export async function readRunOutput(
  run: WorkflowRun,
  blockId: string,
  read: (runId: string, blockId: string) => Promise<Record<string, PipelineData>>,
): Promise<Record<string, PipelineData>> {
  const block = snapshotBlock(run, blockId);
  if (!block) throw new Error("This block was not part of the saved run.");
  const outputs = await read(run.id, blockId);
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs))
    throw new Error("The saved block output is malformed.");
  const validPorts = new Set(blockPorts(block).outputs.map((port) => port.id));
  for (const [port, data] of Object.entries(outputs)) {
    if (!validPorts.has(port) || !PipelineData.safeParse(data).success)
      throw new Error("The saved block output does not match its run snapshot.");
  }
  return outputs;
}

/** A cancellable UI loader: older runs/blocks never overwrite the currently selected output. */
export function loadSelectedOutput(
  run: WorkflowRun,
  blockId: string,
  read: (runId: string, blockId: string) => Promise<Record<string, PipelineData>>,
  receive: (
    state:
      | { status: "ready"; outputs: Record<string, PipelineData> }
      | { status: "error"; message: string },
  ) => void,
): () => void {
  let disposed = false;
  void readRunOutput(run, blockId, read).then(
    (outputs) => {
      if (!disposed) receive({ status: "ready", outputs });
    },
    (error: unknown) => {
      if (!disposed)
        receive({
          status: "error",
          message: error instanceof Error ? error.message : "Saved output could not be read.",
        });
    },
  );
  return () => {
    disposed = true;
  };
}
