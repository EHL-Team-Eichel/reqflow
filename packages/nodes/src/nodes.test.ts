import { WorkflowGraph } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { ALL_NODE_TYPES, allNodes, BMW_DEFAULT_TEMPLATE, createNodeRegistry } from "./index";

describe("node package contract", () => {
  it("only registers node types declared in NODE_TYPES, without duplicates", () => {
    for (const def of allNodes) expect(ALL_NODE_TYPES).toContain(def.type);
    expect(() => createNodeRegistry()).not.toThrow();
  });

  it("default template is a valid, acyclic graph of known node types", () => {
    const graph = WorkflowGraph.parse(BMW_DEFAULT_TEMPLATE.graph);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(ids.size).toBe(graph.nodes.length);
    for (const node of graph.nodes) expect(ALL_NODE_TYPES).toContain(node.type);
    for (const edge of graph.edges) {
      expect(ids.has(edge.source), `edge ${edge.id} source`).toBe(true);
      expect(ids.has(edge.target), `edge ${edge.id} target`).toBe(true);
    }

    // Kahn's algorithm: every node must be reachable in topological order.
    const indegree = new Map([...ids].map((id) => [id, 0]));
    for (const e of graph.edges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
    const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length) {
      const id = queue.shift()!;
      visited++;
      for (const e of graph.edges.filter((e) => e.source === id)) {
        const d = (indegree.get(e.target) ?? 0) - 1;
        indegree.set(e.target, d);
        if (d === 0) queue.push(e.target);
      }
    }
    expect(visited).toBe(graph.nodes.length);
  });
});
