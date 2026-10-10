import { boundaryBlockId, graphAt, validateGraph } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { toFlowEdges, toFlowNodes } from "./flow";
import { breadcrumbOf, createDataflowStore, selectInspectedBlock, selectWorkplace } from "./store";

const at = { x: 0, y: 0 };

describe("dataflow store", () => {
  it("adds blocks with unique labels and selects the new one", () => {
    const store = createDataflowStore();
    const a = store.getState().addBlock("raw", at);
    const b = store.getState().addBlock("raw", { x: 300, y: 0 });
    const graph = selectWorkplace(store.getState());
    expect(graph.blocks.map((x) => x.label)).toEqual(["Raw", "Raw 2"]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^raw-[0-9a-f]{8}$/);
    expect(store.getState().selectedBlockIds).toEqual([b]);
    expect(selectInspectedBlock(store.getState())?.id).toBe(b);
  });

  it("applies React Flow node changes: move, measure, select, remove", () => {
    const store = createDataflowStore();
    const raw = store.getState().addBlock("raw", at);
    const hil = store.getState().addBlock("hil", at);
    store.getState().connect({ source: raw, sourceHandle: "out", target: hil, targetHandle: "in" });
    store.getState().applyNodeChanges([
      { type: "position", id: raw, position: { x: 40, y: 50 }, dragging: true },
      { type: "dimensions", id: raw, dimensions: { width: 200, height: 90 } },
      { type: "select", id: raw, selected: true },
      { type: "select", id: hil, selected: false },
    ]);
    let s = store.getState();
    expect(selectWorkplace(s).blocks[0]!.position).toEqual({ x: 40, y: 50 });
    expect(s.measured[raw]).toEqual({ width: 200, height: 90 });
    expect(s.selectedBlockIds).toEqual([raw]);

    store.getState().applyNodeChanges([{ type: "remove", id: raw }]);
    s = store.getState();
    expect(selectWorkplace(s).blocks.map((b) => b.id)).toEqual([hil]);
    expect(selectWorkplace(s).edges).toEqual([]);
    expect(s.selectedBlockIds).toEqual([]);
  });

  it("connects valid ports and shows why invalid ones fail", () => {
    const store = createDataflowStore();
    const raw = store.getState().addBlock("raw", at);
    const car = store.getState().addBlock("add_to_car", at);
    const valid = { source: raw, sourceHandle: "out", target: car, targetHandle: "in-1" };
    expect(store.getState().checkConnection(valid)).toEqual({ ok: true });
    expect(store.getState().connect(valid)).toBe(true);
    expect(store.getState().connect(valid)).toBe(false);
    expect(store.getState().notice).toMatchObject({ tone: "error", message: /already connected/ });
    expect(store.getState().connect({ source: raw, target: car })).toBe(false);
    expect(store.getState().notice?.message).toMatch(/output port to an input port/);
    expect(selectWorkplace(store.getState()).edges).toHaveLength(1);
  });

  it("validates params, and tells the user when connections had to be removed", () => {
    const store = createDataflowStore();
    const split = store.getState().addBlock("ai_splitter", at);
    const hil = store.getState().addBlock("hil", at);
    store
      .getState()
      .connect({ source: split, sourceHandle: "out-2", target: hil, targetHandle: "in" });
    const params = selectWorkplace(store.getState()).blocks[0]!.params;

    expect(store.getState().setParams(split, { ...params, branches: ["Only"] })).toMatch(
      /^Branches/,
    );
    expect(store.getState().setParams(split, { ...params, branches: ["A", "B"] })).toBeNull();
    expect(selectWorkplace(store.getState()).edges).toEqual([]);
    expect(store.getState().notice).toMatchObject({
      tone: "info",
      message: /Removed 1 connection/,
    });
    expect(store.getState().renameBlock(split, "  ")).toMatch(/empty/);
    expect(store.getState().renameBlock(split, "Rank")).toBeNull();
  });

  it("opens inner workplaces, edits them, and navigates back by breadcrumb", () => {
    const store = createDataflowStore();
    const research = store.getState().addBlock("research", at);
    store.getState().openInner(research);
    let s = store.getState();
    expect(s.path).toEqual([research]);
    expect(selectWorkplace(s).blocks.map((b) => b.kind)).toEqual(["block_output"]);

    const inner = store.getState().addBlock("custom", at);
    store.getState().openInner(inner);
    const deep = store.getState().addBlock("raw", at);
    store.getState().connect({
      source: deep,
      sourceHandle: "out",
      target: boundaryBlockId(inner, "out"),
      targetHandle: "in",
    });
    s = store.getState();
    expect(breadcrumbOf(s.root, s.path).map((c) => c.label)).toEqual([
      "Workplace",
      "Research",
      "Custom",
    ]);
    expect(graphAt(s.root, [research, inner]).edges).toHaveLength(1);
    expect(validateGraph(s.root)).toEqual([]);

    store.getState().goTo(0);
    expect(store.getState().path).toEqual([]);
    store.getState().openInner(store.getState().addBlock("hil", at));
    expect(store.getState().notice?.message).toMatch(/no inner workplace/);
    expect(store.getState().path).toEqual([]);
  });

  it("never deletes boundary blocks", () => {
    const store = createDataflowStore();
    const custom = store.getState().addBlock("custom", at);
    store.getState().openInner(custom);
    const input = boundaryBlockId(custom, "in");
    store.getState().applyNodeChanges([{ type: "remove", id: input }]);
    expect(store.getState().notice?.message).toMatch(/can't be deleted/);
    store.getState().selectBlock(input);
    store.getState().deleteSelection();
    expect(selectWorkplace(store.getState()).blocks.map((b) => b.id)).toContain(input);
  });

  it("maps the workplace to React Flow nodes and edges", () => {
    const store = createDataflowStore();
    const custom = store.getState().addBlock("custom", at);
    const hil = store.getState().addBlock("hil", at);
    store
      .getState()
      .connect({ source: custom, sourceHandle: "out", target: hil, targetHandle: "in" });
    const s = store.getState();
    const nodes = toFlowNodes(selectWorkplace(s), s.selectedBlockIds, {
      [hil]: { width: 1, height: 2 },
    });
    expect(nodes.map((n) => [n.type, n.selected, n.deletable])).toEqual([
      ["block", false, true],
      ["block", true, true],
    ]);
    expect(nodes[1]!.measured).toEqual({ width: 1, height: 2 });
    expect(nodes[0]!.data.spec?.hasInnerWorkplace).toBe(true);
    expect(toFlowEdges(selectWorkplace(s), [])[0]).toMatchObject({
      sourceHandle: "out",
      targetHandle: "in",
    });

    store.getState().openInner(custom);
    const inner = toFlowNodes(selectWorkplace(store.getState()), [], {});
    expect(inner.map((n) => [n.type, n.deletable])).toEqual([
      ["boundary", false],
      ["boundary", false],
    ]);
  });

  it("opens a block's report, and reveals a block on another workplace", () => {
    const store = createDataflowStore();
    const custom = store.getState().addBlock("custom", at);
    store.getState().openInner(custom);
    const hil = store.getState().addBlock("hil", at);
    store.getState().openReport(hil);
    expect(store.getState().report).toEqual({ blockId: hil, path: [custom] });

    store.getState().goTo(0);
    store.getState().revealBlock([custom], hil);
    expect(store.getState()).toMatchObject({
      path: [custom],
      selectedBlockIds: [hil],
      report: null,
    });

    store.getState().openReport("missing");
    expect(store.getState().report).toBeNull();
    expect(store.getState().notice?.message).toMatch(/not on this workplace/);
    store.getState().revealBlock([], "missing");
    expect(store.getState().notice?.message).toMatch(/no longer exists/);
    expect(store.getState().path).toEqual([custom]);
  });
});
