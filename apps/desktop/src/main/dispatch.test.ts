import { inspect } from "node:util";
import { RequirementDecision } from "@reqflow/core";
import type { ReqflowHandlers } from "@reqflow/core/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch, ReqflowError } from "./dispatch";

const syntheticCredential = "synthetic-private-provider-credential";
const syntheticProviderDetails = "synthetic-private-provider-response";
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
      throw Object.assign(new Error(`db locked; provider credential ${syntheticCredential}`), {
        details: {
          authorization: `Bearer ${syntheticCredential}`,
          response: syntheticProviderDetails,
        },
      });
    },
  },
} as unknown as ReqflowHandlers;

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("sanitizes unexpected errors without leaking provider credentials or details to IPC or console", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await dispatch(handlers, "workflows", "get", ["wf_1"]);

    expect(response).toMatchObject({
      ok: false,
      error: { code: "internal", message: expect.stringMatching(/internal/i) },
    });
    expect(response).not.toHaveProperty("error.details");
    expect(spy).toHaveBeenCalled();
    for (const output of [
      inspect(response, { depth: null }),
      inspect(spy.mock.calls, { depth: null }),
    ]) {
      expect(output).not.toContain("db locked");
      expect(output).not.toContain(syntheticCredential);
      expect(output).not.toContain(syntheticProviderDetails);
    }
  });

  it("reports unknown methods explicitly", async () => {
    await expect(dispatch(handlers, "nope", "missing", [])).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown_method" },
    });
  });
});
