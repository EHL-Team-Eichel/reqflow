import { describe, expect, it } from "vitest";
import { boundaryBlockId, connect, createBlock, updateGraphAt } from "./graph";
import { traceLineage } from "./lineage";
import type { WorkflowGraph } from "./workflow";

const at = { x: 0, y: 0 };
const add = (g: WorkflowGraph, ...blocks: ReturnType<typeof createBlock>[]): WorkflowGraph => ({
  ...g,
  blocks: [...g.blocks, ...blocks],
});
const wire = (
  g: WorkflowGraph,
  source: string,
  sourcePort: string,
  target: string,
  targetPort: string,
) => connect(g, { source, sourcePort, target, targetPort });
const ids = (lineage: ReturnType<typeof traceLineage>) =>
  lineage.steps.map((s) => s.block.id).sort();

describe("traceLineage", () => {
  it("follows every path into the block, with branch labels and distances", () => {
    let g: WorkflowGraph = { blocks: [], edges: [] };
    g = add(
      g,
      createBlock("raw", { id: "raw", position: at }),
      createBlock("research", { id: "web", position: at }),
      createBlock("ai_filter", { id: "filter", position: at }),
      createBlock("ai_splitter", { id: "split", position: at }),
      createBlock("hil", { id: "hil", position: at }),
      createBlock("hil", { id: "other", position: at }), // not upstream: must not appear
    );
    g = wire(g, "raw", "out", "filter", "in");
    g = wire(g, "web", "out", "filter", "in");
    g = wire(g, "filter", "out", "split", "in");
    g = wire(g, "split", "out-0", "hil", "in");
    g = wire(g, "split", "out-1", "other", "in");

    const lineage = traceLineage(g, [], "hil");
    expect(ids(lineage)).toEqual(["filter", "hil", "raw", "split", "web"]);
    expect(lineage.steps[0]!.block.id).toBe("hil");
    const distance = Object.fromEntries(lineage.steps.map((s) => [s.block.id, s.distance]));
    expect(distance).toEqual({ hil: 0, split: 1, filter: 2, raw: 3, web: 3 });
    const branch = lineage.links.find((l) => l.source === "split")!;
    expect(branch).toMatchObject({ target: "hil", sourceLabel: "High" });
    expect(lineage.links).toHaveLength(4);
  });

  it("an unconnected block has only itself as lineage", () => {
    const g = add({ blocks: [], edges: [] }, createBlock("hil", { id: "hil", position: at }));
    expect(traceLineage(g, [], "hil")).toMatchObject({ steps: [{ distance: 0 }], links: [] });
  });

  it("leaves an inner workplace through its input to what feeds the parent", () => {
    let g: WorkflowGraph = { blocks: [], edges: [] };
    g = add(
      g,
      createBlock("raw", { id: "raw", position: at }),
      createBlock("custom", { id: "box", position: at }),
    );
    g = wire(g, "raw", "out", "box", "in");
    g = updateGraphAt(g, ["box"], (inner) =>
      wire(
        add(inner, createBlock("hil", { id: "hil", position: at })),
        boundaryBlockId("box", "in"),
        "out",
        "hil",
        "in",
      ),
    );

    const lineage = traceLineage(g, ["box"], "hil");
    expect(ids(lineage)).toEqual(["box--in", "hil", "raw"]);
    expect(lineage.steps.find((s) => s.block.id === "raw")!.path).toEqual([]);
    expect(lineage.steps.find((s) => s.block.id === "box--in")!.path).toEqual(["box"]);
    expect(lineage.links.map((l) => `${l.source}->${l.target}`).sort()).toEqual([
      "box--in->hil",
      "raw->box--in",
    ]);
  });

  it("traces through the sub-flow of an upstream block that has blocks inside", () => {
    let g: WorkflowGraph = { blocks: [], edges: [] };
    g = add(
      g,
      createBlock("research", { id: "web", position: at }),
      createBlock("hil", { id: "hil", position: at }),
    );
    g = wire(g, "web", "out", "hil", "in");
    // Inside Research: a Raw block feeds the Research output.
    g = updateGraphAt(g, ["web"], (inner) =>
      wire(
        add(inner, createBlock("raw", { id: "seed", position: at })),
        "seed",
        "out",
        boundaryBlockId("web", "out"),
        "in",
      ),
    );

    const lineage = traceLineage(g, [], "hil");
    expect(ids(lineage)).toEqual(["hil", "seed", "web", "web--out"]);
    const distance = Object.fromEntries(lineage.steps.map((s) => [s.block.id, s.distance]));
    expect(distance).toEqual({ hil: 0, web: 1, "web--out": 2, seed: 3 });
  });

  it("does not descend into empty inner workplaces", () => {
    let g: WorkflowGraph = { blocks: [], edges: [] };
    g = add(
      g,
      createBlock("raw", { id: "raw", position: at }),
      createBlock("ai_filter", { id: "filter", position: at }),
      createBlock("hil", { id: "hil", position: at }),
    );
    g = wire(g, "raw", "out", "filter", "in");
    g = wire(g, "filter", "out", "hil", "in");
    expect(ids(traceLineage(g, [], "hil"))).toEqual(["filter", "hil", "raw"]);
  });

  it("throws for a block that isn't on the given workplace", () => {
    expect(() => traceLineage({ blocks: [], edges: [] }, [], "missing")).toThrow(
      /not on that workplace/,
    );
  });
});
