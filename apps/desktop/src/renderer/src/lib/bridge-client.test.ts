import type { IpcResult, ReqflowBridge } from "@reqflow/core/ipc";
import { describe, expect, it, vi } from "vitest";
import { createApi, ReqflowError } from "./bridge-client";
import { emptyPipelineData, HilReportRequest } from "@reqflow/core";
import { fixtureScope } from "@reqflow/core/fixtures";

function fakeBridge(result: IpcResult<unknown>) {
  const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => result);
  const onRunUpdate = vi.fn(() => () => {});
  return { bridge: { invoke, onRunUpdate } satisfies ReqflowBridge, invoke, onRunUpdate };
}

describe("renderer API client", () => {
  it("calls the namespaced channel with the arguments and unwraps the value", async () => {
    const { bridge, invoke } = fakeBridge({ ok: true, value: { id: "wf_1" } });
    const api = createApi(bridge);
    await expect(api.workflows.get("wf_1")).resolves.toEqual({ id: "wf_1" });
    expect(invoke).toHaveBeenCalledWith("reqflow:workflows.get", "wf_1");
  });

  it("turns structured IPC errors into ReqflowError with the code", async () => {
    const { bridge } = fakeBridge({
      ok: false,
      error: { code: "not_implemented", message: "nope" },
    });
    const err = await createApi(bridge)
      .audit.list()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReqflowError);
    expect(err).toMatchObject({ code: "not_implemented", message: "nope" });
  });

  it("passes run updates straight through to the bridge subscription", () => {
    const { bridge, onRunUpdate } = fakeBridge({ ok: true, value: null });
    const listener = () => {};
    createApi(bridge).runs.onUpdate(listener);
    expect(onRunUpdate).toHaveBeenCalledWith(listener);
  });

  it("passes sampled report data unchanged through the allowlisted export channel", async () => {
    const { bridge, invoke } = fakeBridge({ ok: true, value: null });
    const request: HilReportRequest = {
      metadata: {
        scope: fixtureScope,
        gate: { label: "Review", reviewer: "pm", approvalsNeeded: 1 },
        currentStep: { label: "Review", id: "hil" },
        lineageSteps: [{ id: "hil", label: "Review", kind: "hil", path: [] }],
        lineageLinks: [],
      },
      selectedData: {
        ...emptyPipelineData(),
        records: [{ id: "rec_synthetic", sourceId: "src_synthetic", text: "Synthetic value" }],
      },
      fullCounts: { Sources: 1, Records: 10, Findings: 0, Themes: 0, Requirements: 0 },
    };
    await expect(createApi(bridge).exports.hilReport(request)).resolves.toBeNull();
    expect(invoke).toHaveBeenCalledWith("reqflow:exports.hilReport", request);
  });
});
