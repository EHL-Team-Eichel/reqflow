import { boundaryBlockId, validateGraph, walkBlocks } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { createDataflowStore } from "./store";

describe("editor history and clipboard", () => {
  it("undoes graph mutations while selection/measurement changes stay out of history", () => {
    const store = createDataflowStore();
    const id = store.getState().addBlock("raw", { x: 0, y: 0 });
    store.getState().applyNodeChanges([
      { type: "select", id, selected: true },
      { type: "dimensions", id, dimensions: { width: 224, height: 150 } },
    ]);
    expect(store.getState().past).toHaveLength(1);
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().root.blocks).toHaveLength(0);
    expect(store.getState().selectedBlockIds).toEqual([]);
    expect(store.getState().redo()).toBe(true);
    expect(store.getState().root.blocks[0]?.id).toBe(id);
    store.getState().undo();
    store.getState().addBlock("hil", { x: 100, y: 0 });
    expect(store.getState().future).toHaveLength(0);
  });

  it("coalesces a complete drag gesture into one undo step", () => {
    const store = createDataflowStore();
    const id = store.getState().addBlock("raw", { x: 0, y: 0 });
    for (const x of [20, 40, 60])
      store
        .getState()
        .applyNodeChanges([{ type: "position", id, position: { x, y: 10 }, dragging: true }]);
    expect(store.getState().past).toHaveLength(1);
    store
      .getState()
      .applyNodeChanges([{ type: "position", id, position: { x: 80, y: 10 }, dragging: false }]);
    expect(store.getState().past).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().root.blocks[0]?.position).toEqual({ x: 0, y: 0 });
    store.getState().redo();
    expect(store.getState().root.blocks[0]?.position).toEqual({ x: 80, y: 10 });
  });

  it("restores edges removed by a parameter change and preserves redo after rejected edits", () => {
    const store = createDataflowStore();
    const split = store.getState().addBlock("ai_splitter", { x: 0, y: 0 });
    const hil = store.getState().addBlock("hil", { x: 300, y: 0 });
    const params = store.getState().root.blocks.find((block) => block.id === split)!.params;
    expect(
      store
        .getState()
        .setParams(split, { ...params, splitBy: "priority", branches: ["A", "B", "C"] }),
    ).toBeNull();
    expect(
      store
        .getState()
        .connect({ source: split, target: hil, sourceHandle: "out-2", targetHandle: "in" }),
    ).toBe(true);
    const before = structuredClone(store.getState().root);
    store.getState().setParams(split, { ...params, splitBy: "priority", branches: ["A", "B"] });
    expect(store.getState().root.edges).toHaveLength(0);
    store.getState().undo();
    expect(store.getState().root).toEqual(before);
    const redo = store.getState().future;
    expect(store.getState().setParams(split, { unknown: true })).not.toBeNull();
    expect(store.getState().future).toBe(redo);
  });

  it("remaps complete nested trees and canonical boundaries while retaining imported file references", () => {
    const store = createDataflowStore();
    const outer = store.getState().addBlock("custom", { x: 0, y: 0 });
    store.getState().openInner(outer);
    const inner = store.getState().addBlock("custom", { x: 220, y: 0 });
    store.getState().openInner(inner);
    const raw = store.getState().addBlock("raw", { x: 100, y: 80 });
    const rawParams = store
      .getState()
      .root.blocks[0]!.inner!.blocks.find((block) => block.id === inner)!
      .inner!.blocks.find((block) => block.id === raw)!.params;
    store
      .getState()
      .setParams(raw, { ...rawParams, file: { fileId: "file_synthetic", name: "synthetic.xlsx" } });
    store.getState().goTo(0);
    const hil = store.getState().addBlock("hil", { x: 400, y: 0 });
    store
      .getState()
      .connect({ source: outer, sourceHandle: "out", target: hil, targetHandle: "in" });
    store.setState({ selectedBlockIds: [outer, hil] });
    expect(store.getState().copySelection()).toBe(true);
    expect(store.getState().pasteSelection()).toBe(true);
    const graph = store.getState().root;
    expect(validateGraph(graph)).toEqual([]);
    const entries = [...walkBlocks(graph)];
    expect(new Set(entries.map(({ block }) => block.id)).size).toBe(entries.length);
    for (const { block, path } of entries) {
      if (block.kind === "block_input" || block.kind === "block_output")
        expect(block.id).toBe(boundaryBlockId(path.at(-1)!, String(block.params.port)));
    }
    expect(
      entries.filter(({ block }) => block.kind === "raw").map(({ block }) => block.params.file),
    ).toEqual([
      { fileId: "file_synthetic", name: "synthetic.xlsx" },
      { fileId: "file_synthetic", name: "synthetic.xlsx" },
    ]);
    expect(graph.edges).toHaveLength(2);
    const firstPaste = store.getState().selectedBlockIds;
    store.getState().pasteSelection();
    expect(store.getState().selectedBlockIds.some((id) => firstPaste.includes(id))).toBe(false);
    expect(validateGraph(store.getState().root)).toEqual([]);
  });

  it("protects boundaries and preserves the in-app clipboard during duplication", () => {
    const store = createDataflowStore();
    const parent = store.getState().addBlock("custom", { x: 0, y: 0 });
    store.getState().copySelection();
    const clipboard = store.getState().clipboard;
    store.getState().duplicateSelection();
    expect(store.getState().clipboard).toBe(clipboard);
    store.getState().openInner(parent);
    store.setState({
      selectedBlockIds: store.getState().root.blocks[0]!.inner!.blocks.map((block) => block.id),
    });
    expect(store.getState().copySelection()).toBe(false);
    expect(store.getState().duplicateSelection()).toBe(false);
  });

  it("repairs inner navigation when redo removes an ancestor and resets history on document replacement", () => {
    const store = createDataflowStore();
    const id = store.getState().addBlock("custom", { x: 0, y: 0 });
    store.getState().deleteSelection();
    store.getState().undo();
    store.getState().openInner(id);
    store.getState().redo();
    expect(store.getState().path).toEqual([]);
    store.getState().replaceWorkflow({ blocks: [], edges: [] }, "New flow");
    expect(store.getState().past).toEqual([]);
    expect(store.getState().future).toEqual([]);
    expect(store.getState().name).toBe("New flow");
  });

  it("bounds history and does not record no-op moves or renames", () => {
    const store = createDataflowStore();
    const id = store.getState().addBlock("raw", { x: 0, y: 0 });
    store.getState().renameBlock(id, "Raw");
    store.getState().applyNodeChanges([{ type: "position", id, position: { x: 0, y: 0 } }]);
    expect(store.getState().past).toHaveLength(1);
    for (let x = 1; x <= 110; x++)
      store.getState().applyNodeChanges([{ type: "position", id, position: { x, y: 0 } }]);
    expect(store.getState().past).toHaveLength(100);
  });
});
