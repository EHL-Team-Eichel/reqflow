import { describe, expect, it } from "vitest";
import {
  layoutSankey,
  stageX,
  type SankeyLink,
  type SankeyLinkInput,
  type SankeyNode,
  type SankeyNodeInput,
} from "./sankey-layout";

const nodes: SankeyNodeInput[] = [
  { id: "in", stage: 0, label: "Input", color: "c0" },
  { id: "de", stage: 1, label: "Germany", color: "c1" },
  { id: "fr", stage: 1, label: "France", color: "c2" },
  { id: "pos", stage: 2, label: "Positive", color: "c3" },
  { id: "neg", stage: 2, label: "Negative", color: "c4" },
];

const links: SankeyLinkInput[] = [
  { source: "in", target: "de", value: 60 },
  { source: "in", target: "fr", value: 40 },
  { source: "de", target: "pos", value: 35 },
  { source: "de", target: "neg", value: 25 },
  { source: "fr", target: "pos", value: 10 },
  { source: "fr", target: "neg", value: 30 },
];

// Every column carries 100 units, so the common scale is 2 px per unit.
const opts = { width: 300, height: 210, nodeWidth: 12, nodePadding: 10 };

function nodeMap(list: SankeyNode[]): Map<string, SankeyNode> {
  return new Map(list.map((node) => [node.id, node]));
}

function band(list: SankeyLink[], source: string, target: string): SankeyLink {
  const found = list.find((link) => link.source === source && link.target === target);
  if (!found) throw new Error(`no band ${source} -> ${target}`);
  return found;
}

describe("layoutSankey", () => {
  it("sizes each node by the larger of its inflow and outflow", () => {
    const { nodes: laid } = layoutSankey(nodes, links, opts);
    const byId = nodeMap(laid);
    expect(byId.get("in")!.value).toBe(100); // outflow only
    expect(byId.get("de")!.value).toBe(60); // 60 in, 60 out
    expect(byId.get("fr")!.value).toBe(40); // 40 in, 40 out
    expect(byId.get("pos")!.value).toBe(45); // 35 + 10 in
    expect(byId.get("neg")!.value).toBe(55); // 25 + 30 in
    for (const node of laid) {
      expect(node.y1 - node.y0).toBeCloseTo(node.value * 2);
    }
  });

  it("keeps the input order inside a column and stacks bands without crossing", () => {
    const layout = layoutSankey(nodes, links, opts);
    const byId = nodeMap(layout.nodes);
    expect(byId.get("de")!.y0).toBeLessThan(byId.get("fr")!.y0);
    expect(byId.get("pos")!.y0).toBeLessThan(byId.get("neg")!.y0);

    // leaving "in": the band to Germany sits above the band to France, touching it
    const inDe = band(layout.links, "in", "de");
    const inFr = band(layout.links, "in", "fr");
    expect(inDe.y0).toBeLessThan(inFr.y0);
    expect(inFr.y0).toBeCloseTo(inDe.y0 + inDe.width);

    // leaving "de": Positive above Negative
    const dePos = band(layout.links, "de", "pos");
    const deNeg = band(layout.links, "de", "neg");
    expect(dePos.y0).toBeLessThan(deNeg.y0);
    expect(deNeg.y0).toBeCloseTo(dePos.y0 + dePos.width);

    // entering "pos": Germany's band above France's band
    const frPos = band(layout.links, "fr", "pos");
    expect(dePos.y1).toBeLessThan(frPos.y1);
    expect(frPos.y1).toBeCloseTo(dePos.y1 + dePos.width);
  });

  it("never overlaps nodes in a column and keeps the padding between them", () => {
    const { nodes: laid } = layoutSankey(nodes, links, opts);
    for (const stage of [0, 1, 2]) {
      const column = laid.filter((node) => node.stage === stage).sort((a, b) => a.y0 - b.y0);
      for (let k = 1; k < column.length; k++) {
        expect(column[k]!.y0).toBeGreaterThanOrEqual(column[k - 1]!.y1 + 10 - 1e-9);
      }
    }
  });

  it("makes band widths add up to node heights where a node's flows balance", () => {
    const layout = layoutSankey(nodes, links, opts);
    const byId = nodeMap(layout.nodes);
    const sumOut = (id: string) =>
      layout.links.filter((l) => l.source === id).reduce((s, l) => s + l.width, 0);
    const sumIn = (id: string) =>
      layout.links.filter((l) => l.target === id).reduce((s, l) => s + l.width, 0);
    const height = (id: string) => byId.get(id)!.y1 - byId.get(id)!.y0;

    expect(sumOut("in")).toBeCloseTo(height("in")); // source
    expect(sumIn("pos")).toBeCloseTo(height("pos")); // sink
    expect(sumIn("neg")).toBeCloseTo(height("neg")); // sink
    for (const id of ["de", "fr"]) {
      expect(sumIn(id)).toBeCloseTo(height(id));
      expect(sumOut(id)).toBeCloseTo(height(id));
    }
  });

  it("keeps every band inside the node it leaves and the node it enters", () => {
    const layout = layoutSankey(nodes, links, opts);
    const byId = nodeMap(layout.nodes);
    for (const l of layout.links) {
      const source = byId.get(l.source)!;
      const target = byId.get(l.target)!;
      expect(l.y0).toBeGreaterThanOrEqual(source.y0 - 1e-9);
      expect(l.y0 + l.width).toBeLessThanOrEqual(source.y1 + 1e-9);
      expect(l.y1).toBeGreaterThanOrEqual(target.y0 - 1e-9);
      expect(l.y1 + l.width).toBeLessThanOrEqual(target.y1 + 1e-9);
    }
  });

  it("keeps all nodes and bands within the height", () => {
    const layout = layoutSankey(nodes, links, opts);
    for (const node of layout.nodes) {
      expect(node.y0).toBeGreaterThanOrEqual(0);
      expect(node.y1).toBeLessThanOrEqual(opts.height + 1e-9);
    }
    for (const l of layout.links) {
      expect(l.y0).toBeGreaterThanOrEqual(0);
      expect(l.y1 + l.width).toBeLessThanOrEqual(opts.height + 1e-9);
    }
  });

  it("places the stage columns from the left edge to the right edge", () => {
    const byId = nodeMap(layoutSankey(nodes, links, opts).nodes);
    expect(stageX(0, 2, 300, 12)).toBe(0);
    expect(stageX(1, 2, 300, 12)).toBe(144);
    expect(byId.get("in")!.x0).toBe(0);
    expect(byId.get("de")!.x0).toBe(144);
    expect(byId.get("pos")!.x1).toBe(300);
  });

  it("drops links that cannot be drawn and keeps the rest", () => {
    const messy: SankeyLinkInput[] = [
      ...links,
      { source: "in", target: "de", value: 0 },
      { source: "in", target: "de", value: -4 },
      { source: "in", target: "de", value: Number.NaN },
      { source: "nowhere", target: "de", value: 5 },
      { source: "in", target: "elsewhere", value: 5 },
      { source: "pos", target: "de", value: 9 }, // runs backwards
      { source: "fr", target: "fr", value: 9 }, // within one stage
    ];
    const layout = layoutSankey(nodes, messy, opts);
    expect(layout.links).toHaveLength(links.length);
    expect(nodeMap(layout.nodes).get("in")!.value).toBe(100);
  });

  it("leaves out nodes that carry no flow without changing the others", () => {
    const withIdle = [...nodes, { id: "idle", stage: 1, label: "Idle", color: "c9" }];
    const layout = layoutSankey(withIdle, links, opts);
    expect(layout.nodes.map((node) => node.id)).not.toContain("idle");
    expect(layout.nodes).toHaveLength(nodes.length);
    expect(layoutSankey(nodes, links, opts).nodes.find((n) => n.id === "fr")!.y0).toBeCloseTo(
      layout.nodes.find((n) => n.id === "fr")!.y0,
    );
  });

  it("is deterministic and orders a column by the given node order", () => {
    const first = layoutSankey(nodes, links, opts);
    expect(layoutSankey(nodes, links, opts)).toEqual(first);

    const reversed = nodeMap(layoutSankey([...nodes].reverse(), links, opts).nodes);
    expect(reversed.get("fr")!.y0).toBeLessThan(reversed.get("de")!.y0);
    expect(reversed.get("neg")!.y0).toBeLessThan(reversed.get("pos")!.y0);
  });

  it("draws each band as a closed path", () => {
    const first = layoutSankey(nodes, links, opts).links[0]!;
    expect(first.path.startsWith("M")).toBe(true);
    expect(first.path.endsWith("Z")).toBe(true);
    expect(first.path).toContain("C");
  });

  it("returns nothing without flow", () => {
    expect(layoutSankey([], [], opts)).toEqual({ nodes: [], links: [] });
    expect(layoutSankey(nodes, [], opts)).toEqual({ nodes: [], links: [] });
  });

  it("rejects duplicate node ids and invalid stages", () => {
    expect(() => layoutSankey([nodes[0]!, nodes[0]!], [], opts)).toThrow(/duplicate/);
    expect(() => layoutSankey([{ ...nodes[0]!, stage: -1 }], [], opts)).toThrow(/stage/);
    expect(() => layoutSankey([{ ...nodes[0]!, stage: 1.5 }], [], opts)).toThrow(/stage/);
  });
});
