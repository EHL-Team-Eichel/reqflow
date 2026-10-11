import { connect, createBlock, defaultBlockParams, type WorkflowGraph } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { workflowProblems } from "./problems";

const raw = () => ({
  ...createBlock("raw", { id: "raw", position: { x: 0, y: 0 } }),
  params: {
    ...defaultBlockParams("raw"),
    source: "database",
    connection: "synthetic.sqlite",
    query: "SELECT * FROM feedback",
  },
});

describe("workflow preflight problems", () => {
  it("finds missing Raw files and disconnected inputs without reading a file or key", () => {
    const graph = {
      blocks: [
        createBlock("raw", { id: "raw", position: { x: 0, y: 0 } }),
        createBlock("hil", { id: "hil", position: { x: 300, y: 0 } }),
      ],
      edges: [],
    };
    expect(
      workflowProblems(graph)
        .map((problem) => problem.message)
        .join(" "),
    ).toMatch(/uploaded file.*not connected/);
    expect(workflowProblems(graph)).toEqual(workflowProblems(graph));
  });

  it("allows one priority input with all context and other ranking inputs unused", () => {
    const graph = connect(
      {
        blocks: [raw(), createBlock("add_to_car", { id: "car", position: { x: 300, y: 0 } })],
        edges: [],
      },
      { source: "raw", sourcePort: "out", target: "car", targetPort: "in-1" },
    );
    expect(workflowProblems(graph)).toEqual([]);
  });

  it("allows one of several Analytics inputs", () => {
    const analytics = createBlock("analytics", { id: "analytics", position: { x: 300, y: 0 } });
    analytics.params.inputs = ["One", "Two"];
    const graph = connect(
      { blocks: [raw(), analytics], edges: [] },
      { source: "raw", sourcePort: "out", target: "analytics", targetPort: "in-0" },
    );
    expect(workflowProblems(graph)).toEqual([]);
  });

  it("does not flag untouched built-in splitter boundaries but checks authored subflows", () => {
    const splitter = createBlock("ai_splitter", { id: "split", position: { x: 300, y: 0 } });
    let graph = connect(
      { blocks: [raw(), splitter], edges: [] },
      { source: "raw", sourcePort: "out", target: "split", targetPort: "in" },
    );
    expect(workflowProblems(graph)).toEqual([]);
    graph = structuredClone(graph);
    graph.blocks[1]!.inner!.blocks.push(
      createBlock("hil", { id: "inner-review", position: { x: 200, y: 0 } }),
    );
    expect(
      workflowProblems(graph).some(
        (problem) => problem.path[0] === "split" && problem.blockId === "inner-review",
      ),
    ).toBe(true);
  });

  it("reports unconnected Custom output boundaries and malformed drafts safely", () => {
    const custom = createBlock("custom", { id: "custom", position: { x: 300, y: 0 } });
    const graph = connect(
      { blocks: [raw(), custom], edges: [] },
      { source: "raw", sourcePort: "out", target: "custom", targetPort: "in" },
    );
    expect(
      workflowProblems(graph).some(
        (problem) => problem.path[0] === "custom" && problem.message.includes("Inner output"),
      ),
    ).toBe(true);
    expect(workflowProblems({ bad: true } as unknown as WorkflowGraph)).toHaveLength(1);
  });
});
