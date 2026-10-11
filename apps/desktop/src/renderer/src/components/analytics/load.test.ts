import {
  connect,
  createBlock,
  DEFAULT_SETTINGS,
  emptyPipelineData,
  type PipelineData,
  type WorkflowGraph,
  type WorkflowRun,
} from "@reqflow/core";
import { describe, expect, it, vi } from "vitest";
import { feedbackData, SAMPLE_ROWS } from "./engine/fixtures";
import { isPreviewable, loadInputs, planInputs } from "./load";

const scope = DEFAULT_SETTINGS.defaultScope;
const rawA = createBlock("raw", { id: "raw-a", position: { x: 0, y: 0 } });
const rawB = createBlock("raw", { id: "raw-b", position: { x: 0, y: 200 } });
const hil = createBlock("hil", { id: "hil-1", position: { x: 200, y: 200 } });
const analytics = {
  ...createBlock("analytics", { id: "analytics-1", position: { x: 400, y: 0 } }),
  params: {
    ...createBlock("analytics", { id: "x", position: { x: 0, y: 0 } }).params,
    inputs: ["F70", "G60", "Empty"],
  },
};
const a = feedbackData(SAMPLE_ROWS.slice(0, 6), { source: "a" });
const b = feedbackData(SAMPLE_ROWS.slice(6), { source: "b" });

function graph(): WorkflowGraph {
  let g: WorkflowGraph = { blocks: [rawA, rawB, hil, analytics], edges: [] };
  g = connect(g, { source: rawA.id, sourcePort: "out", target: analytics.id, targetPort: "in-0" });
  g = connect(g, { source: rawB.id, sourcePort: "out", target: hil.id, targetPort: "in" });
  g = connect(g, { source: hil.id, sourcePort: "out", target: analytics.id, targetPort: "in-1" });
  return g;
}

describe("analytics input loading", () => {
  it("plans one entry per named input with its incoming edges", () => {
    const plans = planInputs(graph(), [], analytics.id);
    expect(plans.map((p) => [p.port, p.label, p.edges.map((e) => e.source?.id)])).toEqual([
      ["in-0", "F70", ["raw-a"]],
      ["in-1", "G60", ["hil-1"]],
      ["in-2", "Empty", []],
    ]);
    expect(() => planInputs(graph(), [], "gone")).toThrow(/no longer/);
  });

  it("previews sources without a run, and asks for a run behind transforming blocks", async () => {
    const preview = vi.fn().mockResolvedValue({ outputs: { out: a }, logs: [] });
    const inputs = await loadInputs(planInputs(graph(), [], analytics.id), {
      run: null,
      scope,
      preview,
      blockOutput: vi.fn(),
    });
    expect(inputs.map((i) => i.status)).toEqual(["ready", "needs_run", "unconnected"]);
    expect(inputs[0]!.data!.records).toHaveLength(6);
    expect(inputs[1]!.message).toMatch(/HIL.*Start the flow/);
    expect(preview).toHaveBeenCalledExactlyOnceWith({ kind: "raw", params: rawA.params, scope });
  });

  it("reads the saved outputs of a run, never a fresh preview", async () => {
    const run = { id: "run-1" } as WorkflowRun;
    const blockOutput = vi.fn(
      async (_run: string, block: string): Promise<Record<string, PipelineData>> =>
        block === "raw-a" ? { out: a } : block === "hil-1" ? { out: b } : {},
    );
    const preview = vi.fn();
    const inputs = await loadInputs(planInputs(graph(), [], analytics.id), {
      run,
      scope,
      preview,
      blockOutput,
    });
    expect(inputs.map((i) => [i.status, i.data?.records.length ?? 0])).toEqual([
      ["ready", 6],
      ["ready", 6],
      ["unconnected", 0],
    ]);
    expect(preview).not.toHaveBeenCalled();
  });

  it("says when the run hasn't reached an input yet", async () => {
    const blockOutput = vi.fn(async (_run: string, block: string) => {
      if (block === "hil-1")
        throw new Error(`No outputs found for block "${block}" in run "run-1"`);
      return { out: emptyPipelineData() };
    });
    const inputs = await loadInputs(planInputs(graph(), [], analytics.id), {
      run: { id: "run-1" } as WorkflowRun,
      scope,
      preview: vi.fn(),
      blockOutput,
    });
    expect(inputs[1]).toMatchObject({ status: "needs_run" });
    expect(inputs[1]!.message).toMatch(/hasn't reached/);
  });

  it("reports read errors on the input instead of failing the whole view", async () => {
    const preview = vi.fn().mockRejectedValue(new Error("file is gone"));
    const inputs = await loadInputs(planInputs(graph(), [], analytics.id), {
      run: null,
      scope,
      preview,
      blockOutput: vi.fn(),
    });
    expect(inputs[0]).toMatchObject({ status: "error", message: "file is gone" });
  });

  it("knows which blocks can be read on their own", () => {
    expect(isPreviewable(rawA)).toBe(true);
    expect(isPreviewable(hil)).toBe(false);
    expect(isPreviewable(undefined)).toBe(false);
  });
});
