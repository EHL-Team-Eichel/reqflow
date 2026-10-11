import { isBoundaryBlockKind, type PaletteBlockKind, type WorkflowGraph } from "@reqflow/core";
import { instantiateTemplate } from "./templates";

export function selectedClipboard(
  graph: WorkflowGraph,
  selectedIds: readonly string[],
): WorkflowGraph | null {
  const blocks = graph.blocks.filter(
    (block) => selectedIds.includes(block.id) && !isBoundaryBlockKind(block.kind),
  );
  if (!blocks.length) return null;
  const ids = new Set(blocks.map((block) => block.id));
  return structuredClone({
    blocks,
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  });
}

/** Reuse the template remapper so boundary and nested edge identities remain canonical. */
export function pasteClipboard(
  clipboard: WorkflowGraph,
  mintId: (kind: PaletteBlockKind) => string,
  offset: { x: number; y: number },
): WorkflowGraph {
  const clone = instantiateTemplate(
    { name: "Copied blocks", description: "", graph: clipboard },
    mintId,
  );
  return {
    ...clone,
    blocks: clone.blocks.map((block) => ({
      ...block,
      position: { x: block.position.x + offset.x, y: block.position.y + offset.y },
    })),
  };
}
