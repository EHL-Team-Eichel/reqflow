import { blockPorts, isBoundaryBlockKind, validateGraph, type WorkflowGraph } from "@reqflow/core";
import type { DataflowState, XY } from "./store";

/** Size of a block before React Flow has measured it (BlockNode is w-56). */
export const DEFAULT_BLOCK_SIZE = { width: 224, height: 120 };
const GAP = 24;

/** Find a free slot near the clicked canvas position without stacking existing blocks. */
export function findFreePosition(
  graph: WorkflowGraph,
  measured: DataflowState["measured"],
  center: XY,
): XY {
  const { width, height } = DEFAULT_BLOCK_SIZE;
  const start = { x: center.x - width / 2, y: center.y - height / 2 };
  const boxes = graph.blocks.map((block) => ({
    x: block.position.x,
    y: block.position.y,
    ...(measured[block.id] ?? DEFAULT_BLOCK_SIZE),
  }));
  const free = (point: XY) =>
    boxes.every(
      (box) =>
        point.x + width + GAP <= box.x ||
        box.x + box.width + GAP <= point.x ||
        point.y + height + GAP <= box.y ||
        box.y + box.height + GAP <= point.y,
    );
  for (let ring = 0; ring <= 12; ring++)
    for (let dy = -ring; dy <= ring; dy++)
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const point = { x: start.x + dx * (width + GAP), y: start.y + dy * (height + GAP) };
        if (free(point)) return point;
      }
  return start;
}

/** Stable dependency columns with measured heights; only the current workplace moves. */
export function layoutWorkplace(
  graph: WorkflowGraph,
  measured: Record<string, { width: number; height: number }> = {},
): WorkflowGraph {
  // Parent-port checks belong to the full root; these fixed blocks are valid in an open inner view.
  const issues = validateGraph(graph).filter(
    (issue) =>
      !graph.blocks.some(
        (block) =>
          isBoundaryBlockKind(block.kind) &&
          issue.blockId === block.id &&
          issue.path.length === 0 &&
          issue.message === `"${block.label}" can only sit inside an inner workplace`,
      ),
  );
  if (issues.length) throw new Error(`Cannot tidy an invalid workplace: ${issues[0]!.message}`);
  if (!graph.blocks.length) return graph;
  const indegree = new Map(graph.blocks.map((block) => [block.id, 0]));
  const outgoing = new Map(graph.blocks.map((block) => [block.id, [] as string[]]));
  const level = new Map(graph.blocks.map((block) => [block.id, 0]));
  for (const edge of graph.edges) {
    indegree.set(edge.target, indegree.get(edge.target)! + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const queue = graph.blocks
    .filter((block) => indegree.get(block.id) === 0)
    .map((block) => block.id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    for (const next of outgoing.get(id)!) {
      level.set(next, Math.max(level.get(next)!, level.get(id)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  const maxLevel = Math.max(...level.values());
  // Unwired output boundaries still belong to the right edge of an inner workplace.
  for (const block of graph.blocks)
    if (block.kind === "block_output") level.set(block.id, Math.max(1, maxLevel));
  const columns = new Map<number, typeof graph.blocks>();
  for (const block of graph.blocks) {
    const column = level.get(block.id)!;
    columns.set(column, [...(columns.get(column) ?? []), block]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let x = 24;
  for (const [, blocks] of [...columns].sort(([a], [b]) => a - b)) {
    let y = 24;
    let width = 224;
    for (const block of blocks) {
      const ports = blockPorts(block);
      const fallbackHeight = isBoundaryBlockKind(block.kind)
        ? 64
        : Math.max(140, 100 + Math.max(ports.inputs.length, ports.outputs.length) * 30);
      const size = measured[block.id];
      positions.set(block.id, { x, y });
      y += Math.max(size?.height ?? fallbackHeight, 64) + 48;
      width = Math.max(width, size?.width ?? 224);
    }
    x += width + 104;
  }
  return {
    ...graph,
    blocks: graph.blocks.map((block) => ({ ...block, position: positions.get(block.id)! })),
  };
}
