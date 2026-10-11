import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlockRegistry } from "@reqflow/blocks";
import { DEFAULT_SETTINGS, defaultBlockParams, type LlmClient, type Settings } from "@reqflow/core";
import { createFileStore } from "@reqflow/db";
import type { BlockContext } from "@reqflow/engine";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
        code: "invalid_input",
        message: expect.stringMatching(/run the flow/i),
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });

  it("does not invoke OpenCode CLI execution during preview", async () => {
    await expect(
      previewBlock(registry, files, {
        kind: "research_opencode",
        params: defaultBlockParams("research_opencode"),
        scope,
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/run the flow/i),
    });
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

  it("passes supplied settings and llm client to block context", async () => {
    const mockLlm: LlmClient = {
      generateText: vi.fn().mockResolvedValue({ text: "ok", model: "custom-test-model" }),
      generateObject: vi.fn().mockResolvedValue({ object: {} }),
    };
    const customSettings: Settings = {
      ...DEFAULT_SETTINGS,
      llm: { ...DEFAULT_SETTINGS.llm, model: "custom-preview-model" },
    };
    let capturedCtx: BlockContext | undefined;
    const rawImpl = registry.get("raw");
    const originalRun = rawImpl.run;
    const spy = vi.spyOn(rawImpl, "run").mockImplementation(async (inputs, params, ctx) => {
      capturedCtx = ctx;
      return originalRun.call(rawImpl, inputs, params, ctx);
    });
    try {
      const info = await files.importFile(join(SAMPLES, "equipment_take_rates.csv"));
      const params = {
        ...defaultBlockParams("raw"),
        dataset: "equipment_data",
        file: { fileId: info.id, name: info.name },
      };
      await previewBlock(
        registry,
        files,
        { kind: "raw", params, scope },
        { settings: customSettings, llm: mockLlm },
      );
      expect(capturedCtx).toBeDefined();
      expect(capturedCtx?.settings.llm.model).toBe("custom-preview-model");
      expect(capturedCtx?.settings.defaultScope).toEqual(scope);
      await capturedCtx?.llm.generateText({ prompt: "test prompt" });
      expect(mockLlm.generateText).toHaveBeenCalledWith({ prompt: "test prompt" });
    } finally {
      spy.mockRestore();
    }
  });

  it("wraps AI provider failure into generic message and keeps logs safe", async () => {
    const failingLlm: LlmClient = {
      generateText: vi
        .fn()
        .mockRejectedValue(new Error('Anthropic 401: {"error":{"api_key":"sk-ant-secret-12345"}}')),
      generateObject: vi.fn().mockRejectedValue(new Error("Secret provider payload")),
    };
    const rawImpl = registry.get("raw");
    const spy = vi.spyOn(rawImpl, "run").mockImplementation(async (_inputs, _params, ctx) => {
      ctx.log("Starting preview before AI call");
      await ctx.llm.generateText({ prompt: "test" });
      return { status: "ok", outputs: {} };
    });
    try {
      const info = await files.importFile(join(SAMPLES, "equipment_take_rates.csv"));
      const params = {
        ...defaultBlockParams("raw"),
        dataset: "equipment_data",
        file: { fileId: info.id, name: info.name },
      };
      let thrownError: unknown;
      try {
        await previewBlock(registry, files, { kind: "raw", params, scope }, { llm: failingLlm });
      } catch (err) {
        thrownError = err;
      }
      expect(thrownError).toBeInstanceOf(ReqflowError);
      const reqError = thrownError as ReqflowError;
      expect(reqError.code).toBe("block_failed");
      expect(reqError.message).not.toContain("sk-ant-secret-12345");
      expect(reqError.message).not.toContain("Anthropic 401");
      expect(reqError.message).toMatch(/AI provider failed/i);
      expect((reqError.details as { logs?: string[] })?.logs).toContain(
        "Starting preview before AI call",
      );
    } finally {
      spy.mockRestore();
    }
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
    ).toBe("invalid_input");
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

  it("preserves quota diagnostics across preview without exposing provider bodies", async () => {
    const llm: LlmClient = {
      generateObject: vi
        .fn()
        .mockRejectedValue(
          new Error("Google request failed (HTTP 429): PRIVATE_PROVIDER_BODY synthetic-key"),
        ),
      generateText: vi.fn(),
    };
    const spy = vi
      .spyOn(registry.get("raw"), "run")
      .mockImplementation(async (_inputs, _params, ctx) => {
        await ctx.llm.generateObject({
          prompt: "Synthetic only",
          schema: z.strictObject({ ok: z.boolean() }),
        });
        return { status: "ok", outputs: {} };
      });
    try {
      const error = await previewBlock(
        registry,
        files,
        { kind: "raw", params: defaultBlockParams("raw"), scope },
        { llm },
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ReqflowError);
      expect((error as Error).message).toContain("HTTP 429");
      expect((error as Error).message).not.toContain("PRIVATE_PROVIDER_BODY");
      expect((error as Error).message).not.toContain("synthetic-key");
    } finally {
      spy.mockRestore();
    }
  });
});
