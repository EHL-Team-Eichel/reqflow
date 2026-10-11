import { describe, expect, it } from "vitest";
import { defaultBlockParams, DEFAULT_SETTINGS, PipelineData, type StoredFile } from "@reqflow/core";
import type { BlockContext } from "@reqflow/engine";
import { capPreview } from "../../../../apps/desktop/src/main/preview";
import { rawBlock } from "./raw";

describe("large export preview performance (100k rows)", () => {
  it("runs Raw block on 100,000 rows and caps preview to < 2 MB", async () => {
    const header = "id,comment,country\n";
    const chunkCount = 100_000;
    const lines: string[] = new Array(chunkCount);
    for (let i = 0; i < chunkCount; i++) {
      lines[i] =
        `FB-${i},Synthetic customer feedback comment for performance testing record ${i},DE`;
    }
    const csv = header + lines.join("\n");
    const bytes = new TextEncoder().encode(csv);

    const file: StoredFile = {
      id: "file_perf_100k",
      name: "feedback_100k.csv",
      mimeType: "text/csv",
      bytes,
    };

    const ctx = {
      runId: "run_perf_test",
      blockId: "raw-perf",
      scope: DEFAULT_SETTINGS.defaultScope,
      files: {
        get: async () => file,
      },
      audit: {
        record: async (e: any) => ({ ...e, id: "aud_x", at: "", changes: [] }),
      },
      log: () => {},
      signal: new AbortController().signal,
    } as unknown as BlockContext;

    const start = performance.now();
    const result = await rawBlock.run(
      {},
      {
        ...defaultBlockParams("raw"),
        dataset: "customer_feedback",
        file: { fileId: file.id, name: file.name },
      },
      ctx,
    );
    const rawElapsed = performance.now() - start;

    if (result.status !== "ok") throw new Error("expected ok");
    const outputs = result.outputs as Record<string, PipelineData>;
    expect(outputs.out!.records).toHaveLength(100_000);

    const capStart = performance.now();
    const capped = capPreview(outputs, 1000);
    const capElapsed = performance.now() - capStart;

    const uncappedJson = JSON.stringify(outputs);
    const cappedJson = JSON.stringify(capped.outputs);

    const uncappedBytes = Buffer.byteLength(uncappedJson, "utf8");
    const cappedBytes = Buffer.byteLength(cappedJson, "utf8");

    console.log(
      `[100k Rows Performance]\n` +
        `Raw block execution: ${Math.round(rawElapsed)} ms\n` +
        `capPreview execution: ${Math.round(capElapsed)} ms\n` +
        `Total elapsed: ${Math.round(rawElapsed + capElapsed)} ms\n` +
        `Uncapped records: ${outputs.out!.records.length}\n` +
        `Capped records: ${capped.outputs.out!.records.length}\n` +
        `Uncapped JSON size: ${(uncappedBytes / (1024 * 1024)).toFixed(2)} MB (${uncappedBytes} bytes)\n` +
        `Capped JSON size: ${(cappedBytes / (1024 * 1024)).toFixed(2)} MB (${cappedBytes} bytes)`,
    );

    expect(capped.outputs.out!.records).toHaveLength(1000);
    expect(capped.truncated?.out?.records).toEqual({ shown: 1000, total: 100_000 });
    expect(cappedBytes).toBeLessThan(2 * 1024 * 1024);
  }, 60_000);
});
