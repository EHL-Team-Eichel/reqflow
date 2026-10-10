import {
  BLOCK_SPECS,
  blockPorts,
  isBoundaryBlockKind,
  type BlockPorts,
  type BlockSpec,
  type WorkflowBlock,
  type WorkflowGraph,
} from "@reqflow/core";
import type { Edge, Node } from "@xyflow/react";
import type { DataflowState } from "./store";

/** What every node component receives as `data`. */
export type BlockNodeData = {
  block: WorkflowBlock;
  ports: BlockPorts; // handle ids = port ids (targets = inputs, sources = outputs)
  spec: BlockSpec | null; // null for boundary blocks
};
export type BlockFlowNode = Node<BlockNodeData, "block" | "boundary">;

/** Workplace graph → React Flow nodes. Sizes come from the store so nodes don't re-measure. */
export function toFlowNodes(
  graph: WorkflowGraph,
  selectedIds: readonly string[],
  measured: DataflowState["measured"],
): BlockFlowNode[] {
  const selected = new Set(selectedIds);
  return graph.blocks.map((block) => {
    const boundary = isBoundaryBlockKind(block.kind);
    return {
      id: block.id,
      type: boundary ? "boundary" : "block",
      position: block.position,
      data: {
        block,
        ports: blockPorts(block),
        spec: boundary ? null : BLOCK_SPECS[block.kind as keyof typeof BLOCK_SPECS],
      },
      selected: selected.has(block.id),
      measured: measured[block.id],
      deletable: !boundary,
    };
  });
}

export function toFlowEdges(graph: WorkflowGraph, selectedIds: readonly string[]): Edge[] {
  const selected = new Set(selectedIds);
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourcePort,
    target: e.target,
    targetHandle: e.targetPort,
    selected: selected.has(e.id),
  }));
}
