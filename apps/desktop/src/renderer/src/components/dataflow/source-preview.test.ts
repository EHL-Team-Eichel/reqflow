import { connect, createBlock, traceLineage, type WorkflowRun } from "@reqflow/core";
import { fixturePipelineData, fixtureRun } from "@reqflow/core/fixtures";
import { describe, expect, it, vi } from "vitest";
import { previewSource } from "./source-preview";
import { previewReportInputs, reportPreviewInputs } from "./report/preview";

const research = createBlock("research", { id: "research-preview", position: { x: 0, y: 0 } });
const run: WorkflowRun = {
  ...fixtureRun,
  status: "completed",
  graph: { blocks: [research], edges: [] },
  blockRuns: [{ blockId: research.id, status: "succeeded", logs: [], counts: {} }],
};
const scope = run.scope;
const output = {
  out: {
    ...fixturePipelineData,
    records: fixturePipelineData.records.map((record) => ({
      ...record,
      collectedRecordId: "synthetic-original",
      archivedMetadataKeys: ["rawHtml"],
      metadata: { synthetic: true },
    })),
  },
};
const client = () => ({
  blocks: { preview: vi.fn().mockResolvedValue({ outputs: output, logs: ["Read Raw"] }) },
  runs: { blockOutput: vi.fn().mockResolvedValue(output) },
});

describe("saved Research source previews", () => {
  it("reads saved output without standalone collection and retains archived lineage", async () => {
    const api = client();
    const result = await previewSource(api, research, scope, run);
    expect(result.outputs).toBe(output);
    expect(result.outputs.out!.records[0]).toMatchObject({
      collectedRecordId: "synthetic-original",
      archivedMetadataKeys: ["rawHtml"],
    });
    expect(api.runs.blockOutput).toHaveBeenCalledExactlyOnceWith(run.id, research.id);
    expect(api.blocks.preview).not.toHaveBeenCalled();
    expect(result.logs).toEqual([`Saved Research output from run ${run.id}.`]);
  });

  it("also reads finished Research while a downstream HIL is waiting or a different block failed", async () => {
    for (const status of ["waiting_for_review", "failed", "running"] as const) {
      const api = client();
      expect((await previewSource(api, research, scope, { ...run, status })).outputs).toBe(output);
      expect(api.blocks.preview).not.toHaveBeenCalled();
    }
  });

  it("requires an executed matching source and never falls back to collection", async () => {
    for (const missing of [null, { ...run, graph: { blocks: [], edges: [] } }]) {
      const api = client();
      await expect(previewSource(api, research, scope, missing)).rejects.toThrow(
        "Run the flow first",
      );
      expect(api.blocks.preview).not.toHaveBeenCalled();
      expect(api.runs.blockOutput).not.toHaveBeenCalled();
    }
    for (const status of ["pending", "running", "failed", "skipped"] as const) {
      const api = client();
      await expect(
        previewSource(api, research, scope, {
          ...run,
          blockRuns: [{ blockId: research.id, status, logs: [], counts: {} }],
        }),
      ).rejects.toThrow("no completed output");
      expect(api.runs.blockOutput).not.toHaveBeenCalled();
    }
  });

  it("rejects changed parameters, inner processing or Settings scope instead of showing stale results", async () => {
    const raw = createBlock("raw", { id: "inner-raw", position: { x: 0, y: 0 } });
    for (const changed of [
      { ...research, params: { ...research.params, question: "New synthetic question" } },
      { ...research, inner: { blocks: [raw], edges: [] } },
    ]) {
      const api = client();
      await expect(previewSource(api, changed, scope, run)).rejects.toThrow(
        "configuration has changed",
      );
      expect(api.runs.blockOutput).not.toHaveBeenCalled();
    }
    const api = client();
    await expect(previewSource(api, research, { ...scope, horizonYears: 4 }, run)).rejects.toThrow(
      "configuration has changed",
    );
  });

  it("ignores object-key order and parent layout/name edits", async () => {
    const reordered = {
      ...research,
      label: "Renamed",
      position: { x: 10, y: 40 },
      params: Object.fromEntries(Object.entries(research.params).reverse()),
    };
    expect((await previewSource(client(), reordered, scope, run)).outputs).toBe(output);
  });

  it("reports missing or malformed persisted output without triggering requests", async () => {
    for (const bad of [{}, { out: { sources: [] } }]) {
      const api = client();
      api.runs.blockOutput.mockResolvedValue(bad as unknown as typeof output);
      await expect(previewSource(api, research, scope, run)).rejects.toThrow(/missing|Malformed/);
      expect(api.blocks.preview).not.toHaveBeenCalled();
    }
  });

  it("keeps Raw standalone file preview", async () => {
    const raw = createBlock("raw", { id: "raw-preview", position: { x: 0, y: 0 } });
    const api = client();
    await previewSource(api, raw, scope, null);
    expect(api.blocks.preview).toHaveBeenCalledExactlyOnceWith({
      kind: "raw",
      params: raw.params,
      scope,
    });
    expect(api.runs.blockOutput).not.toHaveBeenCalled();
  });

  it("shows saved Research in a newly inserted HIL and merges a Raw source without approving or rerunning", async () => {
    const hil = createBlock("hil", { id: "new-review", position: { x: 200, y: 0 } });
    const raw = createBlock("raw", { id: "raw-preview", position: { x: 0, y: 150 } });
    let graph = connect(
      { blocks: [research, hil, raw], edges: [] },
      { source: research.id, sourcePort: "out", target: hil.id, targetPort: "in" },
    );
    graph = connect(graph, { source: raw.id, sourcePort: "out", target: hil.id, targetPort: "in" });
    const inputs = reportPreviewInputs(graph, traceLineage(graph, [], hil.id).steps[0]!)!;
    const api = client();
    const result = await previewReportInputs(inputs, scope, api.blocks.preview, (block) =>
      previewSource(api, block, scope, run),
    );
    expect(result.data.records).toHaveLength(fixturePipelineData.records.length);
    expect(api.runs.blockOutput).toHaveBeenCalledExactlyOnceWith(run.id, research.id);
    expect(api.blocks.preview).toHaveBeenCalledExactlyOnceWith({
      kind: "raw",
      params: raw.params,
      scope,
    });
    expect(result.logs).toEqual([`Saved Research output from run ${run.id}.`, "Read Raw"]);
  });

  it("handles research_opencode blocks identically to research blocks", async () => {
    const researchOpenCode = createBlock("research_opencode", {
      id: "opencode-preview",
      position: { x: 0, y: 0 },
    });
    const openCodeRun: WorkflowRun = {
      ...fixtureRun,
      status: "completed",
      graph: { blocks: [researchOpenCode], edges: [] },
      blockRuns: [{ blockId: researchOpenCode.id, status: "succeeded", logs: [], counts: {} }],
    };
    const api = client();
    const result = await previewSource(api, researchOpenCode, scope, openCodeRun);
    expect(result.outputs).toBe(output);
    expect(api.runs.blockOutput).toHaveBeenCalledExactlyOnceWith(
      openCodeRun.id,
      researchOpenCode.id,
    );
    expect(api.blocks.preview).not.toHaveBeenCalled();
  });
});
