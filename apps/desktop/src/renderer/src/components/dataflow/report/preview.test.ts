import {
  connect,
  createBlock,
  DEFAULT_SETTINGS,
  emptyPipelineData,
  traceLineage,
  type WorkflowGraph,
} from "@reqflow/core";
import { fixturePipelineData } from "@reqflow/core/fixtures";
import { describe, expect, it, vi } from "vitest";
import { previewReportInputs, reportPreviewInputs } from "./preview";

const raw = createBlock("raw", { id: "raw-1", position: { x: 0, y: 0 } });
const hil = createBlock("hil", { id: "hil-1", position: { x: 300, y: 0 } });
const scope = DEFAULT_SETTINGS.defaultScope;
const data = {
  ...emptyPipelineData(),
  sources: fixturePipelineData.sources,
  records: fixturePipelineData.records,
  findings: fixturePipelineData.findings,
};
const join = (graph: WorkflowGraph, source: string, target = hil.id) =>
  connect(graph, { source, sourcePort: "out", target, targetPort: "in" });
const inputsAt = (graph: WorkflowGraph, id = hil.id, path: string[] = []) =>
  reportPreviewInputs(graph, traceLineage(graph, path, id).steps[0]!);

describe("HIL report source previews", () => {
  it("shows real Raw data at the default HIL step without running or approving", async () => {
    const graph = join({ blocks: [raw, hil], edges: [] }, raw.id);
    const preview = vi.fn().mockResolvedValue({ outputs: { out: data }, logs: ["Read source"] });
    const result = await previewReportInputs(inputsAt(graph)!, scope, preview);
    expect(result.data).toEqual(data);
    expect(result.data.records.length).toBeGreaterThan(0);
    expect(result.data.findings.length).toBeGreaterThan(0);
    expect(result.logs).toEqual(["Read source"]);
    expect(preview).toHaveBeenCalledExactlyOnceWith({ kind: "raw", params: raw.params, scope });
  });

  it("merges all direct inputs in edge order with later duplicate ids winning", async () => {
    const raw2 = createBlock("raw", { id: "raw-2", position: { x: 0, y: 200 } });
    let graph = join({ blocks: [raw2, hil, raw], edges: [] }, raw.id);
    graph = join(graph, raw2.id);
    const second = {
      ...data,
      records: data.records.map((record) => ({ ...record, text: "Synthetic updated record" })),
    };
    const preview = vi
      .fn()
      .mockResolvedValueOnce({ outputs: { out: data }, logs: ["First"] })
      .mockResolvedValueOnce({ outputs: { out: second }, logs: ["Second"] });
    const result = await previewReportInputs(inputsAt(graph)!, scope, preview);
    expect(result.data).toEqual(second);
    expect(result.logs).toEqual(["First", "Second"]);
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("previews each unique source once and selects the connected output port", async () => {
    const graph = join({ blocks: [raw, hil], edges: [] }, raw.id);
    const inputs = inputsAt(graph)!;
    const preview = vi.fn().mockResolvedValue({
      outputs: { unused: emptyPipelineData(), out: data },
      logs: ["Read once"],
    });
    const result = await previewReportInputs([...inputs, ...inputs], scope, preview);
    expect(result.data).toEqual(data);
    expect(result.logs).toEqual(["Read once"]);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected Raw step's own preview", async () => {
    const graph = { blocks: [raw, hil], edges: [] };
    const preview = vi.fn().mockResolvedValue({ outputs: { out: data }, logs: [] });
    expect((await previewReportInputs(inputsAt(graph, raw.id)!, scope, preview)).data).toEqual(
      data,
    );
  });

  it("does not invent data for a disconnected HIL or bypass an AI transformation", () => {
    expect(inputsAt({ blocks: [raw, hil], edges: [] })).toBeNull();
    const filter = createBlock("ai_filter", { id: "filter", position: { x: 150, y: 0 } });
    let graph = join({ blocks: [raw, filter, hil], edges: [] }, raw.id, filter.id);
    graph = join(graph, filter.id);
    expect(inputsAt(graph)).toBeNull();
    // Even a mixed direct/processed input must not appear as a complete HIL preview.
    expect(inputsAt(join(graph, raw.id))).toBeNull();
  });

  it("does not bypass a Research block's inner processing", () => {
    const research = createBlock("research", { id: "research", position: { x: 0, y: 0 } });
    research.inner!.blocks.push(raw);
    const graph = join({ blocks: [research, hil], edges: [] }, research.id);
    expect(inputsAt(graph)).toBeNull();
  });

  it("resolves direct Raw inputs in the selected inner workplace", async () => {
    const custom = createBlock("custom", { id: "custom", position: { x: 0, y: 0 } });
    custom.inner = join({ blocks: [raw, hil], edges: [] }, raw.id);
    const graph = { blocks: [custom], edges: [] };
    const preview = vi.fn().mockResolvedValue({ outputs: { out: data }, logs: [] });
    const result = await previewReportInputs(inputsAt(graph, hil.id, [custom.id])!, scope, preview);
    expect(result.data).toEqual(data);
  });

  it("reports a missing file error instead of substituting synthetic or partial data", async () => {
    const raw2 = createBlock("raw", {
      id: "raw-2",
      label: "Missing file",
      position: { x: 0, y: 200 },
    });
    const graph = join(join({ blocks: [raw, raw2, hil], edges: [] }, raw.id), raw2.id);
    const preview = vi
      .fn()
      .mockResolvedValueOnce({ outputs: { out: data }, logs: [] })
      .mockRejectedValueOnce(new Error("Choose an Excel or CSV file"));
    await expect(previewReportInputs(inputsAt(graph)!, scope, preview)).rejects.toThrow(
      "Couldn't read Missing file: Choose an Excel or CSV file",
    );
  });

  it("refuses missing output ports and malformed pipeline data", async () => {
    const graph = join({ blocks: [raw, hil], edges: [] }, raw.id);
    const preview = vi.fn().mockResolvedValue({ outputs: { wrong: data }, logs: [] });
    await expect(previewReportInputs(inputsAt(graph)!, scope, preview)).rejects.toThrow(
      'Raw did not return output port "out"',
    );
    preview.mockResolvedValue({ outputs: { out: { sources: [] } }, logs: [] });
    await expect(previewReportInputs(inputsAt(graph)!, scope, preview)).rejects.toThrow(
      'Raw returned invalid data on port "out"',
    );
  });
});
