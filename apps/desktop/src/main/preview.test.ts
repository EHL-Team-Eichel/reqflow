import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlockRegistry } from "@reqflow/blocks";
import { DEFAULT_SETTINGS, defaultBlockParams } from "@reqflow/core";
import { createFileStore } from "@reqflow/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ReqflowError } from "./dispatch";
import { previewBlock } from "./preview";

const dir = mkdtempSync(join(tmpdir(), "reqflow-preview-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const files = createFileStore(dir);
const registry = createBlockRegistry();
const scope = DEFAULT_SETTINGS.defaultScope;
const SAMPLES = join(import.meta.dirname, "../../../../data/samples");

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err instanceof ReqflowError ? err.code : (err as Error).name;
  }
  return "resolved";
};

describe("blocks.preview", () => {
  it("does not invoke Research collection or paid query planning during preview", async () => {
    const run = vi.spyOn(registry.get("research"), "run");
    try {
      await expect(
        previewBlock(registry, files, {
          kind: "research",
          params: { ...defaultBlockParams("research"), queryPlanning: true },
          scope,
        }),
      ).rejects.toMatchObject({
        code: "not_implemented",
        message: expect.stringMatching(/run the flow/i),
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it("runs the Raw block on an imported file", async () => {
    const info = await files.importFile(join(SAMPLES, "equipment_take_rates.csv"));
    const params = {
      ...defaultBlockParams("raw"),
      dataset: "equipment_data",
      file: { fileId: info.id, name: info.name },
    };
    const preview = await previewBlock(registry, files, { kind: "raw", params, scope });
    expect(preview.outputs.out!.records).toHaveLength(17);
    expect(preview.outputs.out!.findings.length).toBeGreaterThan(0);
    expect(preview.logs.join("\n")).toMatch(/Read 17 record/);
  });

  it("refuses what it can't preview, with distinct error codes", async () => {
    expect(
      await code(
        previewBlock(registry, files, { kind: "hil", params: defaultBlockParams("hil"), scope }),
      ),
    ).toBe("invalid_input");
    expect(
      await code(
        previewBlock(registry, files, {
          kind: "research",
          params: defaultBlockParams("research"),
          scope,
        }),
      ),
    ).toBe("not_implemented");
    expect(
      await code(previewBlock(registry, files, { kind: "raw", params: { nope: 1 }, scope })),
    ).toBe("ZodError");
    expect(await code(previewBlock(registry, files, { kind: "rm -rf", params: {}, scope }))).toBe(
      "ZodError",
    );
    const failed = previewBlock(registry, files, {
      kind: "raw",
      params: defaultBlockParams("raw"),
      scope,
    });
    await expect(failed).rejects.toMatchObject({
      code: "block_failed",
      message: expect.stringMatching(/Choose an Excel or CSV file/),
    });
  });
});
