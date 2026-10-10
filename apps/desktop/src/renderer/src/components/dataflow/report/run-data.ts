import {
  graphAt,
  mergePipelineData,
  PipelineData,
  type LineageStep,
  type ReqflowApi,
  type WorkflowRun,
} from "@reqflow/core";

/** Review the persisted run snapshot, never a fresh read of a source that may have changed. */
export async function loadRunData(
  run: WorkflowRun,
  step: LineageStep,
  blockOutput: ReqflowApi["runs"]["blockOutput"],
): Promise<PipelineData> {
  const graph = graphAt(run.graph, step.path);
  const block = graph.blocks.find((b) => b.id === step.block.id);
  if (!block) throw new Error("This step is not part of the selected run.");
  if (block.kind !== "hil") {
    const outputs = await blockOutput(run.id, block.id);
    return mergePipelineData(...Object.values(outputs).map((data) => PipelineData.parse(data)));
  }
  const incoming = graph.edges.filter((edge) => edge.target === block.id);
  if (!incoming.length) throw new Error("This HIL step has no connected input in the saved run.");
  const reads = new Map<string, ReturnType<typeof blockOutput>>();
  const parts = await Promise.all(
    incoming.map(async (edge) => {
      if (!reads.has(edge.source)) reads.set(edge.source, blockOutput(run.id, edge.source));
      const outputs = await reads.get(edge.source)!;
      const data = outputs[edge.sourcePort];
      if (!data)
        throw new Error(
          `The saved output for ${edge.source} is missing port "${edge.sourcePort}".`,
        );
      return PipelineData.parse(data);
    }),
  );
  return mergePipelineData(...parts);
}
