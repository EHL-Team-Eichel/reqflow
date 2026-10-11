import { createBlock, emptyPipelineData, type PipelineData, type WorkflowRun } from "@reqflow/core";
import { fixtureRun } from "@reqflow/core/fixtures";
import { describe, expect, it, vi } from "vitest";
import { blockDraftChanged, loadSelectedOutput, readRunOutput, snapshotBlock } from "./run-view";

const block = createBlock("raw", { id: "raw", position: { x: 0, y: 0 } });
const run: WorkflowRun = { ...structuredClone(fixtureRun), graph: { blocks: [block], edges: [] } };

describe("saved block output inspection", () => {
  it("uses exact run identity and preserves original objects/extension fields", async () => {
    const data = { ...emptyPipelineData(), extension: { preserved: true } };
    const read = vi.fn(async () => ({ out: data }));
    const result = await readRunOutput(run, "raw", read);
    expect(read).toHaveBeenCalledExactlyOnceWith(run.id, "raw");
    expect(result.out).toBe(data);
    expect(result.out?.extension).toEqual({ preserved: true });
    expect(snapshotBlock(run, "new-draft-id")).toBeNull();
    expect(
      blockDraftChanged({ ...block, params: { ...block.params, dataset: "other" } }, block),
    ).toBe(true);
  });

  it("rejects wrong ports and malformed envelopes, rather than presenting fixtures", async () => {
    await expect(
      readRunOutput(run, "raw", async () => ({ "out-unknown": emptyPipelineData() })),
    ).rejects.toThrow(/snapshot/);
    await expect(
      readRunOutput(run, "raw", async () => ({ out: { records: [] } as unknown as PipelineData })),
    ).rejects.toThrow(/snapshot/);
    await expect(readRunOutput(run, "missing", async () => ({}))).rejects.toThrow(/not part/);
    expect(await readRunOutput(run, "raw", async () => ({}))).toEqual({});
  });

  it("ignores late responses after the selected run/block is replaced", async () => {
    let resolve!: (data: Record<string, PipelineData>) => void;
    const receive = vi.fn();
    const dispose = loadSelectedOutput(
      run,
      "raw",
      async () =>
        new Promise((yes) => {
          resolve = yes;
        }),
      receive,
    );
    dispose();
    resolve({ out: emptyPipelineData() });
    await Promise.resolve();
    await Promise.resolve();
    expect(receive).not.toHaveBeenCalled();
  });

  it("reports an API error and supports an explicit retry", async () => {
    const first = vi.fn();
    loadSelectedOutput(
      run,
      "raw",
      async () => {
        throw new Error("Saved output unavailable");
      },
      first,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(first).toHaveBeenCalledWith({ status: "error", message: "Saved output unavailable" });
    const retry = vi.fn();
    loadSelectedOutput(run, "raw", async () => ({ out: emptyPipelineData() }), retry);
    await Promise.resolve();
    await Promise.resolve();
    expect(retry).toHaveBeenCalledWith({ status: "ready", outputs: { out: emptyPipelineData() } });
  });
});
