import {
  connect,
  createBlock,
  DEFAULT_SETTINGS,
  type ReqflowApi,
  type WorkflowRun,
} from "@reqflow/core";
import { fixtureRun } from "@reqflow/core/fixtures";
import { describe, expect, it, vi } from "vitest";
import { createRunStore } from "./run-store";

const scope = DEFAULT_SETTINGS.defaultScope;
const raw = createBlock("raw", { id: "raw", position: { x: 0, y: 0 } });
const car = createBlock("add_to_car", { id: "car", position: { x: 300, y: 0 } });
const graph = connect(
  { blocks: [raw, car], edges: [] },
  {
    source: raw.id,
    sourcePort: "out",
    target: car.id,
    targetPort: "in-0",
  },
);
const run: WorkflowRun = {
  ...structuredClone(fixtureRun),
  id: "run_test",
  workflowId: "wf_test",
  status: "running",
};

function setup() {
  const listeners = new Set<(run: WorkflowRun) => void>();
  const save = vi.fn().mockResolvedValue({ id: "wf_test" });
  const start = vi.fn().mockResolvedValue(run);
  const get = vi.fn().mockResolvedValue(run);
  const cancel = vi.fn().mockResolvedValue({ ...run, status: "cancelled" });
  const api = {
    workflows: { save },
    runs: {
      start,
      get,
      cancel,
      onUpdate: vi.fn((listener: (run: WorkflowRun) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    },
  } as unknown as ReqflowApi;
  const store = createRunStore(api);
  const emit = (next: WorkflowRun) => {
    for (const listener of listeners) listener(next);
  };
  return { store, save, start, get, cancel, emit, listeners };
}

describe("Data Flow execution wiring", () => {
  it("saves the complete graph and scope before starting the persisted workflow", async () => {
    const { store, save, start } = setup();
    await store.getState().start(graph, scope);
    expect(save).toHaveBeenCalledExactlyOnceWith({ ...graph, scope, name: "Data Flow" });
    expect(start).toHaveBeenCalledExactlyOnceWith("wf_test");
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!);
    expect(store.getState()).toMatchObject({
      workflowId: "wf_test",
      run,
      busy: false,
      error: null,
    });
  });

  it("keeps a stable graph snapshot if the editor changes while saving", async () => {
    const { store, save } = setup();
    const current = structuredClone(graph);
    const pending = store.getState().start(current, scope);
    current.blocks[0]!.params.dataset = "other";
    current.edges.splice(0);
    await pending;
    expect(save.mock.calls[0]![0].edges).toEqual(graph.edges);
    expect(save.mock.calls[0]![0].blocks[0].params).toEqual(raw.params);
  });

  it("preserves terminal events received before the start IPC response", async () => {
    const { store, start, emit, listeners } = setup();
    const completed = { ...run, status: "completed" as const };
    start.mockImplementation(async () => {
      emit(completed);
      return run;
    });
    await store.getState().start(graph, scope);
    expect(store.getState().run?.status).toBe("completed");
    expect(listeners.size).toBe(0);
  });

  it("uses live events for the active run and ignores other workflows", async () => {
    const { store, emit, listeners } = setup();
    const stop = store.getState().subscribe();
    await store.getState().start(graph, scope);
    emit({ ...run, id: "run_other", status: "failed" });
    expect(store.getState().run?.status).toBe("running");
    emit({ ...run, status: "waiting_for_review" });
    expect(store.getState().run?.status).toBe("waiting_for_review");
    // A paused review cannot be bypassed by launching the graph again.
    await store.getState().start(graph, scope);
    expect(store.getState().run?.status).toBe("waiting_for_review");
    stop();
    expect(listeners.size).toBe(0);
  });

  it("prevents duplicate clicks and updates the existing workflow on the next run", async () => {
    const { store, save, start, emit } = setup();
    const stop = store.getState().subscribe();
    await Promise.all([store.getState().start(graph, scope), store.getState().start(graph, scope)]);
    expect(start).toHaveBeenCalledTimes(1);
    emit({ ...run, status: "completed" });
    await store.getState().start(graph, scope);
    expect(save.mock.calls[1]![0].id).toBe("wf_test");
    stop();
  });

  it("surfaces save/start failures and rejects empty graphs without running", async () => {
    const { store, save, start, listeners } = setup();
    await store.getState().start({ blocks: [], edges: [] }, scope);
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().error).toMatch(/Add and connect/);
    save.mockRejectedValueOnce(new Error("Could not save workflow"));
    await store.getState().start(graph, scope);
    expect(start).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ error: "Could not save workflow", busy: false });
    start.mockRejectedValueOnce(new Error("No implementation for ai_filter"));
    await store.getState().start(graph, scope);
    expect(store.getState()).toMatchObject({
      error: "No implementation for ai_filter",
      busy: false,
    });
    expect(listeners.size).toBe(0);
  });

  it("catches up after changing tabs without replacing newer pushed state", async () => {
    const { store, get, emit, listeners } = setup();
    await store.getState().start(graph, scope);
    get.mockResolvedValueOnce({ ...run, status: "completed" });
    const stop = store.getState().subscribe();
    emit({ ...run, status: "failed", error: "Source read failed" });
    await Promise.resolve();
    expect(store.getState().run?.status).toBe("failed");
    stop();
    expect(listeners.size).toBe(0);
    const stopAgain = store.getState().subscribe();
    await Promise.resolve();
    expect(store.getState().run?.status).toBe("running");
    stopAgain();
  });

  it("cancels the active run explicitly and displays cancellation errors", async () => {
    const { store, cancel } = setup();
    await store.getState().start(graph, scope);
    cancel.mockRejectedValueOnce(new Error("Cancellation failed"));
    await store.getState().cancel();
    expect(store.getState().error).toBe("Cancellation failed");
    await store.getState().cancel();
    expect(cancel).toHaveBeenCalledWith(run.id);
    expect(store.getState().run?.status).toBe("cancelled");
  });
});
