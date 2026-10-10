import {
  connect,
  createBlock,
  emptyPipelineData,
  traceLineage,
  type WorkflowRun,
} from "@reqflow/core";
import { fixturePipelineData, fixtureRun } from "@reqflow/core/fixtures";
import { describe, expect, it, vi } from "vitest";
import { loadRunData } from "./run-data";

const raw = createBlock("raw", { id: "raw-review", position: { x: 0, y: 0 } });
const hil = createBlock("hil", { id: "hil-review", position: { x: 300, y: 0 } });
const graph = connect(
  { blocks: [raw, hil], edges: [] },
  { source: raw.id, sourcePort: "out", target: hil.id, targetPort: "in" },
);
const run: WorkflowRun = { ...fixtureRun, graph, status: "waiting_for_review" };
const step = traceLineage(graph, [], hil.id).steps[0]!;

describe("saved HIL review data", () => {
  it("loads the exact saved run output instead of re-reading the Raw source", async () => {
    const output = vi
      .fn()
      .mockResolvedValue({ other: emptyPipelineData(), out: fixturePipelineData });
    expect(await loadRunData(run, step, output)).toEqual(fixturePipelineData);
    expect(output).toHaveBeenCalledExactlyOnceWith(run.id, raw.id);
  });

  it("merges HIL inputs in edge order, preserving per-port routing and deduplicating ids", async () => {
    const raw2 = createBlock("raw", { id: "raw-second", position: { x: 0, y: 200 } });
    const next = connect(
      { ...graph, blocks: [...graph.blocks, raw2] },
      { source: raw2.id, sourcePort: "out", target: hil.id, targetPort: "in" },
    );
    const replacement = {
      ...fixturePipelineData,
      records: fixturePipelineData.records.map((r) => ({ ...r, text: "Synthetic replacement" })),
    };
    const output = vi
      .fn()
      .mockResolvedValueOnce({ out: fixturePipelineData })
      .mockResolvedValueOnce({ out: replacement });
    const result = await loadRunData({ ...run, graph: next }, step, output);
    expect(result).toEqual(replacement);
    expect(output.mock.calls.map((call) => call[1])).toEqual([raw.id, raw2.id]);
  });

  it("uses processed splitter outputs, never the earlier Raw data", async () => {
    const splitter = createBlock("ai_splitter", { id: "splitter", position: { x: 150, y: 0 } });
    const next = connect(
      { blocks: [splitter, hil], edges: [] },
      { source: splitter.id, sourcePort: "out-1", target: hil.id, targetPort: "in" },
    );
    const output = vi
      .fn()
      .mockResolvedValue({ "out-0": fixturePipelineData, "out-1": emptyPipelineData() });
    expect(await loadRunData({ ...run, graph: next }, step, output)).toEqual(emptyPipelineData());
    expect(output).toHaveBeenCalledExactlyOnceWith(run.id, splitter.id);
  });

  it("reads saved boundary outputs when the HIL is inside an inner workplace", async () => {
    const custom = createBlock("custom", { id: "parent", position: { x: 0, y: 0 } });
    const boundary = custom.inner!.blocks.find((b) => b.kind === "block_input")!;
    custom.inner = connect(
      { ...custom.inner!, blocks: [...custom.inner!.blocks, hil] },
      { source: boundary.id, sourcePort: "out", target: hil.id, targetPort: "in" },
    );
    const root = { blocks: [custom], edges: [] };
    const innerStep = traceLineage(root, [custom.id], hil.id).steps[0]!;
    const output = vi.fn().mockResolvedValue({ out: fixturePipelineData });
    expect(await loadRunData({ ...run, graph: root }, innerStep, output)).toEqual(
      fixturePipelineData,
    );
    expect(output).toHaveBeenCalledExactlyOnceWith(run.id, boundary.id);
  });

  it("merges a selected step's saved output ports for inspection", async () => {
    const rawStep = traceLineage(graph, [], raw.id).steps[0]!;
    const output = vi
      .fn()
      .mockResolvedValue({ out: fixturePipelineData, other: fixturePipelineData });
    expect(await loadRunData(run, rawStep, output)).toEqual(fixturePipelineData);
  });

  it("surfaces missing ports, read failures and invalid output instead of samples", async () => {
    const output = vi.fn().mockResolvedValue({ wrong: fixturePipelineData });
    await expect(loadRunData(run, step, output)).rejects.toThrow('missing port "out"');
    output.mockRejectedValueOnce(new Error("Saved output unavailable"));
    await expect(loadRunData(run, step, output)).rejects.toThrow("Saved output unavailable");
    output.mockResolvedValue({ out: { sources: [] } });
    await expect(loadRunData(run, step, output)).rejects.toThrow();
    await expect(
      loadRunData({ ...run, graph: { blocks: [hil], edges: [] } }, step, output),
    ).rejects.toThrow("no connected input");
  });
});
