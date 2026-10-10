import { createBlock, type WorkflowGraph } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_SIZE, findFreePosition } from "./layout";

const { width, height } = DEFAULT_BLOCK_SIZE;
const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < width && Math.abs(a.y - b.y) < height;

describe("findFreePosition", () => {
  it("centres the first block on the given point", () => {
    const empty: WorkflowGraph = { blocks: [], edges: [] };
    expect(findFreePosition(empty, {}, { x: 500, y: 300 })).toEqual({
      x: 500 - width / 2,
      y: 300 - height / 2,
    });
  });

  it("never stacks blocks added one after another", () => {
    let graph: WorkflowGraph = { blocks: [], edges: [] };
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const p = findFreePosition(graph, {}, { x: 0, y: 0 });
      for (const q of placed) expect(overlaps(p, q)).toBe(false);
      placed.push(p);
      graph = {
        ...graph,
        blocks: [...graph.blocks, createBlock("hil", { id: `h${i}`, position: p })],
      };
    }
  });

  it("respects measured sizes of tall blocks", () => {
    const tall = createBlock("ai_splitter", { id: "s", position: { x: -112, y: -60 } });
    const graph: WorkflowGraph = { blocks: [tall], edges: [] };
    const p = findFreePosition(graph, { s: { width: 224, height: 600 } }, { x: 0, y: 0 });
    const clear = p.x + width <= -112 || p.x >= 112 || p.y + height <= -60 || p.y >= 540;
    expect(clear).toBe(true);
  });
});
