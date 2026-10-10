import type { WorkflowGraph } from "@reqflow/core";
import type { DataflowState, XY } from "./store";

/** Size of a block before React Flow has measured it (BlockNode is w-56). */
export const DEFAULT_BLOCK_SIZE = { width: 224, height: 120 };
const GAP = 24;

/**
 * Where to put a block added by click: the free spot nearest to `center` (top-left corner
 * coordinates), searched ring by ring on a grid one block wide/tall, so blocks never stack.
 */
export function findFreePosition(
  graph: WorkflowGraph,
  measured: DataflowState["measured"],
  center: XY,
): XY {
  const { width, height } = DEFAULT_BLOCK_SIZE;
  const start = { x: center.x - width / 2, y: center.y - height / 2 };
  const boxes = graph.blocks.map((b) => ({
    x: b.position.x,
    y: b.position.y,
    ...(measured[b.id] ?? DEFAULT_BLOCK_SIZE),
  }));
  const free = (p: XY) =>
    boxes.every(
      (b) =>
        p.x + width + GAP <= b.x ||
        b.x + b.width + GAP <= p.x ||
        p.y + height + GAP <= b.y ||
        b.y + b.height + GAP <= p.y,
    );
  const stepX = width + GAP;
  const stepY = height + GAP;
  for (let ring = 0; ring <= 12; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue; // only this ring's cells
        const p = { x: start.x + dx * stepX, y: start.y + dy * stepY };
        if (free(p)) return p;
      }
    }
  }
  return start; // a very crowded workplace: overlap rather than fail
}
