import { connect, createBlock, type WorkflowGraph } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_SIZE, findFreePosition, layoutWorkplace } from "./layout";

const { width, height } = DEFAULT_BLOCK_SIZE;
const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < width && Math.abs(a.y - b.y) < height;

describe("findFreePosition", () => {
  it("centres the first block on the given point", () => {
    expect(findFreePosition({ blocks: [], edges: [] }, {}, { x: 500, y: 300 })).toEqual({
      x: 500 - width / 2,
      y: 300 - height / 2,
    });
  });
  it("never stacks blocks added one after another", () => {
    let graph: WorkflowGraph = { blocks: [], edges: [] };
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const position = findFreePosition(graph, {}, { x: 0, y: 0 });
      for (const previous of placed) expect(overlaps(position, previous)).toBe(false);
      placed.push(position);
      graph = {
        ...graph,
        blocks: [...graph.blocks, createBlock("hil", { id: `h${i}`, position })],
      };
    }
  });
  it("respects measured sizes of tall blocks", () => {
    const graph = {
      blocks: [createBlock("ai_splitter", { id: "s", position: { x: -112, y: -60 } })],
      edges: [],
    };
    const position = findFreePosition(graph, { s: { width: 224, height: 600 } }, { x: 0, y: 0 });
    expect(
      position.x + width <= -112 ||
        position.x >= 112 ||
        position.y + height <= -60 ||
        position.y >= 540,
    ).toBe(true);
  });
});

describe("workplace layout", () => {
  it("preserves identities and nested trees while arranging dependencies left to right", () => {
    let graph: WorkflowGraph = {
      blocks: [
        createBlock("hil", { id: "hil", position: { x: 0, y: 0 } }),
        createBlock("raw", { id: "raw", position: { x: 900, y: 0 } }),
        createBlock("custom", { id: "custom", position: { x: 0, y: 0 } }),
      ],
      edges: [],
    };
    graph = connect(graph, { source: "raw", sourcePort: "out", target: "hil", targetPort: "in" });
    const laidOut = layoutWorkplace(graph);
    expect(laidOut.blocks.find((block) => block.id === "raw")!.position.x).toBeLessThan(
      laidOut.blocks.find((block) => block.id === "hil")!.position.x,
    );
    expect(laidOut.edges).toBe(graph.edges);
    expect(laidOut.blocks.find((block) => block.id === "custom")!.inner).toBe(
      graph.blocks[2]!.inner,
    );
    expect(graph.blocks[1]!.position.x).toBe(900);
    expect(layoutWorkplace(laidOut)).toEqual(laidOut);
  });

  it("spaces disconnected variable-height nodes without overlapping", () => {
    const graph = {
      blocks: [
        createBlock("raw", { id: "large", position: { x: 0, y: 0 } }),
        createBlock("research", { id: "next", position: { x: 0, y: 0 } }),
      ],
      edges: [],
    };
    const result = layoutWorkplace(graph, { large: { width: 300, height: 400 } });
    expect(result.blocks[1]!.position.y - result.blocks[0]!.position.y).toBeGreaterThan(400);
  });

  it("places unwired output boundaries to the right and keeps empty graphs unchanged", () => {
    const inner = createBlock("custom", { id: "parent", position: { x: 0, y: 0 } }).inner!;
    const result = layoutWorkplace(inner);
    expect(
      result.blocks.find((block) => block.kind === "block_output")!.position.x,
    ).toBeGreaterThan(result.blocks.find((block) => block.kind === "block_input")!.position.x);
    const empty = { blocks: [], edges: [] };
    expect(layoutWorkplace(empty)).toBe(empty);
  });
});
