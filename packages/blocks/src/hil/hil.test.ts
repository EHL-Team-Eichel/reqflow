import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, emptyPipelineData } from "@reqflow/core";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import type { BlockContext } from "@reqflow/engine";
import { hilBlock } from "./hil";

const mockCtx = (resumed = false): BlockContext => ({
  runId: "run_test",
  blockId: "hil_1",
  scope: DEFAULT_SETTINGS.defaultScope,
  settings: DEFAULT_SETTINGS,
  llm: { generateObject: vi.fn(), generateText: vi.fn() },
  audit: { record: vi.fn() },
  files: { get: vi.fn() },
  web: null,
  car: { add: vi.fn() },
  log: vi.fn(),
  progress: vi.fn(),
  signal: new AbortController().signal,
  resumed,
});

describe("HIL block implementation", () => {
  it("pauses when not resumed", async () => {
    const ctx = mockCtx(false);
    const input = {
      in: {
        ...emptyPipelineData(),
        requirements: fixtureRequirements,
      },
    };

    const res = await hilBlock.run(input, { instructions: "Please check range" }, ctx);
    expect(res.status).toBe("paused");
    if (res.status === "paused") {
      expect(res.message).toBe("Please check range");
    }
  });

  it("passes data through to out port when resumed", async () => {
    const ctx = mockCtx(true);
    const input = {
      in: {
        ...emptyPipelineData(),
        requirements: fixtureRequirements,
      },
    };

    const res = await hilBlock.run(input, { instructions: "" }, ctx);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.outputs.out?.requirements).toHaveLength(fixtureRequirements.length);
    }
  });
});
