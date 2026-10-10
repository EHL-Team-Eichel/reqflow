import { describe, expect, it } from "vitest";
import {
  BLOCK_SPECS,
  blockPorts,
  defaultBlockParams,
  isParamVisible,
  PALETTE_BLOCK_KINDS,
  parseBlockParams,
} from "./blocks";
import {
  boundaryBlockId,
  checkConnection,
  connect,
  createBlock,
  emptyGraph,
  graphAt,
  moveBlock,
  nextBlockLabel,
  removeBlocks,
  removeEdges,
  renameBlock,
  setBlockParams,
  updateGraphAt,
  validateGraph,
  wouldCreateCycle,
} from "./graph";
import type { WorkflowGraph } from "./workflow";

const at = (x = 0, y = 0) => ({ x, y });

function withBlocks(...specs: [Parameters<typeof createBlock>[0], string][]): WorkflowGraph {
  return {
    blocks: specs.map(([kind, id], i) => createBlock(kind, { id, position: at(i * 300) })),
    edges: [],
  };
}

describe("block specs", () => {
  it("every palette kind has valid default params and the documented ports", () => {
    for (const kind of PALETTE_BLOCK_KINDS) {
      expect(() => parseBlockParams(kind, defaultBlockParams(kind))).not.toThrow();
    }
    const ports = (kind: (typeof PALETTE_BLOCK_KINDS)[number]) =>
      blockPorts({ kind, params: defaultBlockParams(kind) });
    expect(ports("raw")).toEqual({ inputs: [], outputs: [{ id: "out", label: "Data stream" }] });
    expect(ports("research").inputs).toHaveLength(0);
    expect(ports("research").outputs).toHaveLength(1);
    expect(ports("hil")).toMatchObject({ inputs: [{ id: "in" }], outputs: [{ id: "out" }] });
    expect(ports("ai_splitter").outputs.map((p) => p.id)).toEqual(["out-0", "out-1", "out-2"]);
    expect(ports("add_to_car").inputs.map((p) => p.label)).toEqual([
      "Must have",
      "Should have",
      "Could have",
    ]);
    expect(ports("add_to_car").outputs).toHaveLength(0);
    expect(BLOCK_SPECS.custom.params).toHaveLength(0);
    const expandable = PALETTE_BLOCK_KINDS.filter((k) => BLOCK_SPECS[k].hasInnerWorkplace);
    expect(expandable).toEqual(["custom", "research", "ai_filter"]);
  });

  it("rejects unknown keys and wrong values instead of dropping them", () => {
    const params = defaultBlockParams("ai_filter");
    expect(() => parseBlockParams("ai_filter", { ...params, typo: 1 })).toThrow();
    expect(() => parseBlockParams("ai_filter", { ...params, minConfidence: 2 })).toThrow();
    expect(() =>
      parseBlockParams("ai_splitter", {
        ...defaultBlockParams("ai_splitter"),
        branches: ["only one"],
      }),
    ).toThrow();
    expect(() =>
      parseBlockParams("research", {
        ...defaultBlockParams("research"),
        sources: ["reviews", "reviews"],
      }),
    ).toThrow();
  });

  it("shows conditional fields only when their condition holds", () => {
    const file = BLOCK_SPECS.raw.params.find((p) => p.key === "file")!;
    const query = BLOCK_SPECS.raw.params.find((p) => p.key === "query")!;
    const params = defaultBlockParams("raw");
    expect(isParamVisible(file, params)).toBe(true);
    expect(isParamVisible(query, params)).toBe(false);
    expect(isParamVisible(query, { ...params, source: "database" })).toBe(true);
  });
});

describe("graph operations", () => {
  it("creates expandable blocks with boundary blocks for their ports", () => {
    const filter = createBlock("ai_filter", { id: "f1", position: at() });
    expect(filter.inner?.blocks.map((b) => [b.id, b.kind])).toEqual([
      ["f1--in", "block_input"],
      ["f1--out", "block_output"],
    ]);
    const research = createBlock("research", { id: "r1", position: at() });
    expect(research.inner?.blocks.map((b) => b.kind)).toEqual(["block_output"]);
    expect(createBlock("hil", { id: "h1", position: at() }).inner).toBeUndefined();
  });

  it("connects compatible ports and explains why others fail", () => {
    const g = withBlocks(["raw", "raw1"], ["hil", "hil1"], ["add_to_car", "car1"]);
    const ok = connect(g, { source: "raw1", sourcePort: "out", target: "hil1", targetPort: "in" });
    expect(ok.edges).toHaveLength(1);
    const check = (source: string, sourcePort: string, target: string, targetPort: string) =>
      checkConnection(ok, { source, sourcePort, target, targetPort });
    expect(check("raw1", "out", "hil1", "in")).toMatchObject({ reason: /already connected/ });
    expect(check("hil1", "out", "hil1", "in")).toMatchObject({ reason: /itself/ });
    expect(check("hil1", "out", "raw1", "in")).toMatchObject({ reason: /no input/ });
    expect(check("car1", "out", "hil1", "in")).toMatchObject({ reason: /no output/ });
    expect(check("hil1", "out", "car1", "in-2")).toEqual({ ok: true });
    expect(check("hil1", "out", "car1", "in-3")).toMatchObject({ reason: /no input/ });
    expect(() =>
      connect(ok, { source: "x", sourcePort: "out", target: "hil1", targetPort: "in" }),
    ).toThrow();
  });

  it("refuses connections that would create a loop", () => {
    let g = withBlocks(["hil", "a"], ["hil", "b"], ["hil", "c"]);
    g = connect(g, { source: "a", sourcePort: "out", target: "b", targetPort: "in" });
    g = connect(g, { source: "b", sourcePort: "out", target: "c", targetPort: "in" });
    expect(wouldCreateCycle(g, "c", "a")).toBe(true);
    expect(
      checkConnection(g, { source: "c", sourcePort: "out", target: "a", targetPort: "in" }),
    ).toMatchObject({ ok: false, reason: /loop/ });
    expect(validateGraph(g)).toEqual([]);
  });

  it("removes blocks with their edges but protects boundary blocks", () => {
    let g = withBlocks(["raw", "raw1"], ["custom", "c1"]);
    g = connect(g, { source: "raw1", sourcePort: "out", target: "c1", targetPort: "in" });
    const removed = removeBlocks(g, ["raw1", "unknown"]);
    expect(removed.blocks.map((b) => b.id)).toEqual(["c1"]);
    expect(removed.edges).toEqual([]);
    expect(removeEdges(g, [g.edges[0]!.id]).edges).toEqual([]);
    const inner = graphAt(g, ["c1"]);
    expect(() => removeBlocks(inner, [boundaryBlockId("c1", "in")])).toThrow(/can't be deleted/);
  });

  it("drops edges on ports that disappear when params change", () => {
    let g = withBlocks(["ai_splitter", "s1"], ["hil", "h1"], ["hil", "h2"]);
    g = connect(g, { source: "s1", sourcePort: "out-0", target: "h1", targetPort: "in" });
    g = connect(g, { source: "s1", sourcePort: "out-2", target: "h2", targetPort: "in" });
    const params = { ...g.blocks[0]!.params, branches: ["Keep", "Also keep"] };
    const { graph, removedEdges } = setBlockParams(g, "s1", params);
    expect(removedEdges.map((e) => e.sourcePort)).toEqual(["out-2"]);
    expect(graph.edges.map((e) => e.sourcePort)).toEqual(["out-0"]);
    expect(blockPorts(graph.blocks[0]!).outputs.map((p) => p.label)).toEqual(["Keep", "Also keep"]);
    expect(() => setBlockParams(g, "s1", { ...params, branches: [] })).toThrow();
    expect(() => setBlockParams(g, "s1", { ...params, extra: true })).toThrow();
  });

  it("navigates and updates inner workplaces immutably", () => {
    const outer = createBlock("custom", { id: "outer", position: at() });
    let g: WorkflowGraph = { blocks: [outer], edges: [] };
    g = updateGraphAt(g, ["outer"], (inner) => ({
      ...inner,
      blocks: [...inner.blocks, createBlock("research", { id: "inner-r", position: at(200) })],
    }));
    g = updateGraphAt(g, ["outer", "inner-r"], (inner) => ({
      ...inner,
      blocks: [...inner.blocks, createBlock("raw", { id: "deep-raw", position: at() })],
    }));
    g = updateGraphAt(g, ["outer", "inner-r"], (inner) =>
      connect(inner, {
        source: "deep-raw",
        sourcePort: "out",
        target: boundaryBlockId("inner-r", "out"),
        targetPort: "in",
      }),
    );
    expect(graphAt(g, ["outer", "inner-r"]).edges).toHaveLength(1);
    expect(graphAt(g, []).blocks[0]).not.toBe(outer);
    expect(validateGraph(g)).toEqual([]);
    expect(() => graphAt(g, ["outer", "missing"])).toThrow(/not on this workplace/);
    expect(() => graphAt(g, ["outer", "outer--in"])).toThrow(/no inner workplace/);
    expect(nextBlockLabel(g, "Raw")).toBe("Raw 2");
    expect(nextBlockLabel(g, "HIL")).toBe("HIL");
  });

  it("moves and renames with validation", () => {
    const g = withBlocks(["hil", "h1"]);
    expect(moveBlock(g, "h1", at(5, 6)).blocks[0]!.position).toEqual(at(5, 6));
    expect(() => moveBlock(g, "h1", at(Number.NaN, 0))).toThrow();
    expect(renameBlock(g, "h1", "  PM check ").blocks[0]!.label).toBe("PM check");
    expect(() => renameBlock(g, "h1", "   ")).toThrow(/empty/);
    expect(() => renameBlock(g, "nope", "x")).toThrow(/not on this workplace/);
  });

  it("validateGraph reports structural problems", () => {
    const g = withBlocks(["hil", "a"], ["hil", "b"]);
    const looped: WorkflowGraph = {
      ...g,
      edges: [
        { id: "1", source: "a", sourcePort: "out", target: "b", targetPort: "in" },
        { id: "2", source: "b", sourcePort: "out", target: "a", targetPort: "in" },
        { id: "3", source: "a", sourcePort: "nope", target: "ghost", targetPort: "in" },
      ],
    };
    const messages = validateGraph(looped)
      .map((i) => i.message)
      .join("\n");
    expect(messages).toMatch(/loop/);
    expect(messages).toMatch(/isn't on this workplace/);

    const dupe: WorkflowGraph = { blocks: [g.blocks[0]!, g.blocks[0]!], edges: [] };
    expect(
      validateGraph(dupe)
        .map((i) => i.message)
        .join(),
    ).toMatch(/more than once/);

    const custom = createBlock("custom", { id: "c", position: at() });
    const broken: WorkflowGraph = {
      blocks: [
        { ...custom, inner: { blocks: [], edges: [] } },
        { ...g.blocks[0]!, inner: { blocks: [], edges: [] } },
      ],
      edges: [],
    };
    const brokenMessages = validateGraph(broken)
      .map((i) => i.message)
      .join("\n");
    expect(brokenMessages).toMatch(/needs exactly one block_input/);
    expect(brokenMessages).toMatch(/can't have an inner workplace/);

    const stray = { blocks: [{ ...custom.inner!.blocks[0]! }], edges: [] };
    expect(
      validateGraph(stray)
        .map((i) => i.message)
        .join(),
    ).toMatch(/only sit inside/);
    expect(validateGraph({ blocks: "nope" })).not.toEqual([]);
    expect(validateGraph(emptyGraph())).toEqual([]);
  });
});
