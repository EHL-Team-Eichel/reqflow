import {
  boundaryBlockId,
  connect,
  createBlock,
  edgeId,
  graphAt,
  setBlockParams,
  validateGraph,
  walkBlocks,
  type PaletteBlockKind,
  type WorkflowTemplate,
} from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { FEEDBACK_TEMPLATES, instantiateTemplate } from "./templates";

function ids() {
  let count = 0;
  return (kind: PaletteBlockKind) => `${kind.replaceAll("_", "-")}-test-${++count}`;
}

function nestedTemplate(): WorkflowTemplate {
  const raw = createBlock("raw", { id: "raw", position: { x: 0, y: 0 } });
  raw.params.file = { fileId: "file_synthetic", name: "Synthetic.csv" };
  const custom = createBlock("custom", { id: "parent", position: { x: 300, y: 0 } });
  const filter = createBlock("ai_filter", { id: "filter", position: { x: 250, y: 0 } });
  custom.inner!.blocks.push(filter);
  custom.inner = connect(custom.inner!, {
    source: boundaryBlockId(custom.id, "in"),
    sourcePort: "out",
    target: filter.id,
    targetPort: "in",
  });
  custom.inner = connect(custom.inner, {
    source: filter.id,
    sourcePort: "out",
    target: boundaryBlockId(custom.id, "out"),
    targetPort: "in",
  });
  return {
    name: "Synthetic nested workflow",
    description: "A test-only connected inner workplace.",
    graph: connect(
      { blocks: [raw, custom], edges: [] },
      { source: raw.id, sourcePort: "out", target: custom.id, targetPort: "in" },
    ),
  };
}

describe("product-management workflow templates", () => {
  it("provides valid connected feedback and prioritization setups with human gates", () => {
    expect(FEEDBACK_TEMPLATES).toHaveLength(2);
    for (const template of FEEDBACK_TEMPLATES) {
      expect(validateGraph(template.graph)).toEqual([]);
      expect(template.graph.blocks.some((b) => b.kind === "raw")).toBe(true);
      expect(template.graph.blocks.some((b) => b.kind === "add_to_car")).toBe(true);
      const car = template.graph.blocks.find((b) => b.kind === "add_to_car")!;
      const inputs = template.graph.edges.filter((e) => e.target === car.id);
      expect(inputs.length).toBeGreaterThan(0);
      expect(
        inputs.every((e) => template.graph.blocks.find((b) => b.id === e.source)?.kind === "hil"),
      ).toBe(true);
      expect(
        template.graph.blocks.filter((b) => b.kind === "raw").every((b) => b.params.file === null),
      ).toBe(true);
    }
    expect(FEEDBACK_TEMPLATES[0]!.graph.edges.find((e) => e.target === "car")?.targetPort).toBe(
      "in-1",
    );
    expect(FEEDBACK_TEMPLATES[1]!.graph.blocks.filter((b) => b.kind === "hil")).toHaveLength(3);
  });

  it("assigns fresh ids across the whole tree and deep-clones parameters and positions", () => {
    const template = nestedTemplate();
    const original = structuredClone(template);
    const mint = ids();
    const a = instantiateTemplate(template, mint);
    const b = instantiateTemplate(template, mint);
    const oldIds = new Set([...walkBlocks(template.graph)].map(({ block }) => block.id));
    const aIds = new Set([...walkBlocks(a)].map(({ block }) => block.id));
    const bIds = new Set([...walkBlocks(b)].map(({ block }) => block.id));
    expect([...aIds].some((id) => oldIds.has(id) || bIds.has(id))).toBe(false);
    (a.blocks[0]!.params.file as { name: string }).name = "Changed.csv";
    a.blocks[0]!.position.x = 999;
    expect(template).toEqual(original);
    expect((b.blocks[0]!.params.file as { name: string }).name).toBe("Synthetic.csv");
    expect(b.blocks[0]!.position.x).toBe(0);
    expect(a.edges[0]!.id).not.toBe(template.graph.edges[0]!.id);
  });

  it("uses canonical boundary ids and retains inner wiring through parameter synchronization", () => {
    const graph = instantiateTemplate(nestedTemplate(), ids());
    const custom = graph.blocks.find((b) => b.kind === "custom")!;
    expect(custom.inner!.blocks.map((b) => b.id)).toEqual(
      expect.arrayContaining([boundaryBlockId(custom.id, "in"), boundaryBlockId(custom.id, "out")]),
    );
    for (const { block } of walkBlocks(graph)) {
      for (const edge of block.inner?.edges ?? []) expect(edge.id).toBe(edgeId(edge));
    }
    const synced = setBlockParams(graph, custom.id, custom.params);
    expect(synced.removedEdges).toEqual([]);
    expect(graphAt(synced.graph, [custom.id]).edges).toEqual(custom.inner!.edges);
    expect(validateGraph(synced.graph)).toEqual([]);
  });

  it("keeps splitter branch boundaries canonical when branch parameters change", () => {
    const graph = instantiateTemplate(FEEDBACK_TEMPLATES[1]!, ids());
    const splitter = graph.blocks.find((b) => b.kind === "ai_splitter")!;
    expect(splitter.inner!.blocks.map((b) => b.id)).toContain(
      boundaryBlockId(splitter.id, "out-2"),
    );
    const synced = setBlockParams(graph, splitter.id, {
      ...splitter.params,
      branches: ["Must", "Should", "Could"],
    });
    expect(synced.removedEdges).toEqual([]);
    expect(validateGraph(synced.graph)).toEqual([]);
  });

  it("rejects malformed graphs and missing edges instead of silently dropping connections", () => {
    const template = nestedTemplate();
    template.graph.edges[0]!.target = "missing";
    expect(() => instantiateTemplate(template, ids())).toThrow(
      /Synthetic nested workflow.*isn't on this workplace/,
    );
    const unknown = {
      ...FEEDBACK_TEMPLATES[0]!,
      graph: { blocks: [{ kind: "unknown" }], edges: [] },
    };
    expect(() => instantiateTemplate(unknown as unknown as WorkflowTemplate, ids())).toThrow();
  });

  it("rejects id collisions and duplicate physical connections after remapping", () => {
    expect(() => instantiateTemplate(FEEDBACK_TEMPLATES[0]!, () => "same-id")).toThrow(
      /used more than once/,
    );
    const template = structuredClone(FEEDBACK_TEMPLATES[0]!);
    template.graph.edges.push({ ...template.graph.edges[0]!, id: "duplicate-connection" });
    expect(() => instantiateTemplate(template, ids())).toThrow(/used more than once/);
  });
});
