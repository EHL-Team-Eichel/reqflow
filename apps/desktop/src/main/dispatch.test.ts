import { RequirementDecision } from "@reqflow/core";
import type { ReqflowHandlers } from "@reqflow/core/ipc";
import { describe, expect, it, vi } from "vitest";
import { dispatch, ReqflowError } from "./dispatch";

const handlers = {
  app: {
    info: async () => ({ version: "0.1.0", platform: "test", dataDir: "/tmp", isPackaged: false }),
  },
  audit: {
    list: async () => {
      throw new ReqflowError("not_implemented", "audit.list is not built yet");
    },
  },
  requirements: {
    decide: async (_id: string, input: unknown) => RequirementDecision.parse(input),
  },
  workflows: {
    get: async () => {
      throw new Error("db locked");
    },
  },
} as unknown as ReqflowHandlers;

describe("main-process IPC dispatch", () => {
  it("wraps return values as ok results", async () => {
    await expect(dispatch(handlers, "app", "info", [])).resolves.toMatchObject({
      ok: true,
      value: { platform: "test" },
    });
  });

  it("keeps ReqflowError codes and turns Zod failures into invalid_input", async () => {
    await expect(dispatch(handlers, "audit", "list", [])).resolves.toMatchObject({
      ok: false,
      error: { code: "not_implemented" },
    });
    const bad = await dispatch(handlers, "requirements", "decide", [
      "REQ-F70-EU-001",
      { decision: "approve" },
    ]);
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("reports unexpected errors as internal and unknown methods explicitly", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(dispatch(handlers, "workflows", "get", ["wf_1"])).resolves.toMatchObject({
      ok: false,
      error: { code: "internal", message: "db locked" },
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    await expect(dispatch(handlers, "nope", "missing", [])).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown_method" },
    });
  });
});
