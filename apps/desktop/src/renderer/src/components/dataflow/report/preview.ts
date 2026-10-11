import {
  blockPorts,
  graphAt,
  isBoundaryBlockKind,
  isPaletteBlockKind,
  mergePipelineData,
  PipelineData,
  type BlockPreview,
  type BlockPreviewRequest,
  type LineageStep,
  type PaletteBlockKind,
  type ProductScope,
  type WorkflowBlock,
  type WorkflowGraph,
} from "@reqflow/core";

interface PreviewInput {
  block: WorkflowBlock & { kind: PaletteBlockKind };
  port: string;
}

/** Only source outputs can be previewed; never bypass a transformation that needs a run. */
export function reportPreviewInputs(root: WorkflowGraph, step: LineageStep): PreviewInput[] | null {
  const sourceInput = (block: WorkflowBlock, port: string): PreviewInput | null => {
    if (
      !isPaletteBlockKind(block.kind) ||
      blockPorts(block).inputs.length > 0 ||
      block.inner?.blocks.some((b) => !isBoundaryBlockKind(b.kind))
    )
      return null;
    return { block: { ...block, kind: block.kind }, port };
  };

  if (step.block.kind !== "hil") {
    const port = blockPorts(step.block).outputs[0]?.id;
    const input = port ? sourceInput(step.block, port) : null;
    return input ? [input] : null;
  }

  const graph = graphAt(root, step.path);
  const incoming = graph.edges.filter((edge) => edge.target === step.block.id);
  if (!incoming.length) return null;
  const inputs: PreviewInput[] = [];
  for (const edge of incoming) {
    const source = graph.blocks.find((block) => block.id === edge.source);
    const input = source ? sourceInput(source, edge.sourcePort) : null;
    if (!input) return null;
    inputs.push(input);
  }
  return inputs;
}

export async function previewReportInputs(
  inputs: PreviewInput[],
  scope: ProductScope,
  preview: (request: BlockPreviewRequest) => Promise<BlockPreview>,
  savedResearch?: (block: WorkflowBlock) => Promise<BlockPreview>,
): Promise<{ data: PipelineData; logs: string[] }> {
  const outputs = new Map<string, BlockPreview>();
  for (const { block } of inputs) {
    if (outputs.has(block.id)) continue;
    try {
      outputs.set(
        block.id,
        (block.kind === "research" || block.kind === "research_opencode") && savedResearch
          ? await savedResearch(block)
          : await preview({ kind: block.kind, params: block.params, scope }),
      );
    } catch (err) {
      throw new Error(
        `Couldn't read ${block.label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const parts = inputs.map(({ block, port }) => {
    const output = outputs.get(block.id)!.outputs[port];
    if (!output) throw new Error(`${block.label} did not return output port "${port}".`);
    const parsed = PipelineData.safeParse(output);
    if (!parsed.success) throw new Error(`${block.label} returned invalid data on port "${port}".`);
    return parsed.data;
  });
  return {
    data: mergePipelineData(...parts),
    logs: [...outputs.values()].flatMap((output) => output.logs),
  };
}
