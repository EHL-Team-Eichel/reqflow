import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  emptyPipelineData,
  newId,
  type AuditLogger,
  type FileStore,
  type LlmClient,
} from "@reqflow/core";
import { fixtureRequirements, fixtureScope } from "@reqflow/core/fixtures";
import { type NodeContext } from "@reqflow/engine";
import { pmGateNode } from "./pm-gate";

const mockCtx = (resumed = false): NodeContext => ({
  runId: newId("run"),
  nodeId: "review-gate",
  scope: fixtureScope,
  settings: DEFAULT_SETTINGS,
  llm: { generateObject: vi.fn(), generateText: vi.fn() } as unknown as LlmClient,
  audit: { record: vi.fn() } as unknown as AuditLogger,
  files: { get: vi.fn() } as unknown as FileStore,
  web: null,
  log: vi.fn(),
  progress: vi.fn(),
  signal: new AbortController().signal,
  resumed,
});

describe("review.pm_gate node", () => {
  it("pauses when not resumed", async () => {
    const ctx = mockCtx(false);
    const input = {
      ...emptyPipelineData(),
      requirements: fixtureRequirements,
    };

    const result = await pmGateNode.run(
      input,
      { message: "Review needed", requireAllDecided: false },
      ctx,
    );
    expect(result.status).toBe("paused");
    if (result.status === "paused") {
      expect(result.message).toBe("Review needed");
    }
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("awaiting review"));
  });

  it("proceeds when resumed", async () => {
    const ctx = mockCtx(true);
    const input = {
      ...emptyPipelineData(),
      requirements: fixtureRequirements,
    };

    const result = await pmGateNode.run(
      input,
      { message: "Review needed", requireAllDecided: false },
      ctx,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.requirements).toHaveLength(fixtureRequirements.length);
    }
  });

  it("enforces requireAllDecided if configured", async () => {
    const ctx = mockCtx(true);
    const input = {
      ...emptyPipelineData(),
      requirements: fixtureRequirements, // has "proposed" & "in_review"
    };

    await expect(
      pmGateNode.run(input, { message: "Review needed", requireAllDecided: true }, ctx),
    ).rejects.toThrow(/still pending PM decision/);
  });
});
