import { describe, expect, it, vi } from "vitest";
import { waitForCarScene, type CarSmokeState } from "./car-smoke-ready";

const ready: CarSmokeState = {
  modelId: "synthetic-model",
  powertrain: "electric",
  canvasCount: 1,
  loading: false,
  failed: false,
};

function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
    timeoutMs: 1000,
    intervalMs: 100,
  };
}

describe("native Car scene readiness", () => {
  it("waits past route load until the imported scene and requested powertrain are ready", async () => {
    const read = vi.fn<() => Promise<CarSmokeState>>();
    read.mockResolvedValueOnce({ ...ready, canvasCount: 0, loading: true });
    read.mockResolvedValueOnce({ ...ready, powertrain: "gasoline" });
    read.mockResolvedValue(ready);
    await waitForCarScene(read, { modelId: ready.modelId!, powertrain: "electric" }, clock());
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("still rejects missing/duplicate canvases and wrong model identities", async () => {
    for (const state of [
      { ...ready, canvasCount: 0 },
      { ...ready, canvasCount: 2 },
      { ...ready, modelId: "wrong" },
    ]) {
      await expect(
        waitForCarScene(async () => state, { modelId: "synthetic-model" }, clock()),
      ).rejects.toThrow(/Timed out/);
    }
  });

  it("does not hide actual rendering failures or query failures", async () => {
    await expect(
      waitForCarScene(async () => ({ ...ready, failed: true }), {}, clock()),
    ).rejects.toThrow(/rendering error/);
    await expect(
      waitForCarScene(
        async () => {
          throw new Error("Renderer unavailable");
        },
        {},
        clock(),
      ),
    ).rejects.toThrow("Renderer unavailable");
  });
});
