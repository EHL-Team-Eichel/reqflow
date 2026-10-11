import {
  connect,
  createBlock,
  DEFAULT_SETTINGS,
  type ReqflowApi,
  type WorkflowRun,
} from "@reqflow/core";
import { fixtureRun } from "@reqflow/core/fixtures";
import { describe, expect, it, vi } from "vitest";
import { createRunStore, pausedHil } from "./run-store";

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
  const resume = vi.fn().mockResolvedValue({ ...run, status: "completed" });
  const api = {
    workflows: { save },
    runs: {
      start,
      get,
      cancel,
      resume,
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
  return { store, save, start, get, cancel, resume, emit, listeners };
}

describe("Data Flow execution wiring", () => {
  it("preserves a selected template's name when saving the workflow", async () => {
    const { store, save } = setup();
    await store.getState().start(graph, scope, "Feedback to requirements");
    expect(save.mock.calls[0]![0].name).toBe("Feedback to requirements");
  });

  it("resets finished run identity before starting a different template as a new workflow", async () => {
    const { store, save } = setup();
    store.setState({
      workflowId: "wf_old",
      run: { ...run, status: "completed" },
      error: "Old error",
    });
    expect(store.getState().reset()).toBe(true);
    expect(store.getState()).toMatchObject({ workflowId: null, run: null, error: null });
    await store.getState().start(graph, scope, "A different workflow");
    expect(save.mock.calls[0]![0].id).toBeUndefined();
  });

  it.each(["queued", "running", "waiting_for_review"] as const)(
    "does not reset a %s run to replace its graph",
    (status) => {
      const { store } = setup();
      store.setState({ workflowId: run.workflowId, run: { ...run, status } });
      expect(store.getState().reset()).toBe(false);
      expect(store.getState().run?.status).toBe(status);
    },
  );

  it("does not reset a workflow while it is being saved", () => {
    const { store } = setup();
    store.setState({ busy: true, workflowId: "wf_pending" });
    expect(store.getState().reset()).toBe(false);
    expect(store.getState().workflowId).toBe("wf_pending");
  });

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
    expect(store.getState().run?.status).toBe("failed");
    stopAgain();
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "does not regress %s to active after a stale fetch or event",
    async (status) => {
      const { store, emit } = setup();
      await store.getState().start(graph, scope);
      store.setState({ run: { ...run, status } });
      const stop = store.getState().subscribe();
      await Promise.resolve();
      emit({ ...run, status: "running" });
      emit({ ...run, status: "waiting_for_review" });
      expect(store.getState().run?.status).toBe(status);
      stop();
    },
  );

  it("shows recovered live status after a catch-up error", async () => {
    const { store, get, emit } = setup();
    await store.getState().start(graph, scope);
    get.mockRejectedValueOnce(new Error("Status unavailable"));
    const stop = store.getState().subscribe();
    await Promise.resolve();
    expect(store.getState().error).toBe("Status unavailable");
    emit({ ...run, status: "completed" });
    expect(store.getState()).toMatchObject({ run: { status: "completed" }, error: null });
    stop();
  });

  it("saves every nested workplace rather than just the open sub-flow", async () => {
    const { store, save, start } = setup();
    const custom = createBlock("custom", { id: "custom", position: { x: 0, y: 0 } });
    custom.inner = {
      blocks: [...custom.inner!.blocks, ...structuredClone(graph.blocks)],
      edges: structuredClone(graph.edges),
    };
    const root = { blocks: [custom], edges: [] };
    await store.getState().start(root, scope);
    expect(save).toHaveBeenCalledExactlyOnceWith({ ...root, scope, name: "Data Flow" });
    expect(start).toHaveBeenCalledExactlyOnceWith("wf_test");
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

describe("explicit HIL review and resume", () => {
  const hil = createBlock("hil", { id: "review", position: { x: 150, y: 0 } });
  const paused: WorkflowRun = {
    ...run,
    status: "waiting_for_review",
    graph: { blocks: [raw, hil, car], edges: [] },
    blockRuns: [{ blockId: hil.id, status: "waiting_for_review", counts: {}, logs: [] }],
  };
  const setupPaused = () => {
    const c = setup();
    c.store.setState({ run: structuredClone(paused), workflowId: paused.workflowId });
    return c;
  };

  it("does not resume automatically and requires an explicit confirmation of the current gate", async () => {
    const { store, resume } = setupPaused();
    expect(pausedHil(store.getState().run)?.block.id).toBe(hil.id);
    expect(resume).not.toHaveBeenCalled();
    await store.getState().resume(paused.id, hil.id, false);
    expect(resume).not.toHaveBeenCalled();
    await store.getState().resume(paused.id, hil.id, true);
    expect(resume).toHaveBeenCalledExactlyOnceWith(paused.id);
    expect(store.getState()).toMatchObject({
      busy: false,
      error: null,
      run: { status: "completed" },
    });
  });

  it("rejects stale run ids, the wrong HIL block, and non-paused runs", async () => {
    const { store, resume } = setupPaused();
    await store.getState().resume("run_old", hil.id, true);
    await store.getState().resume(paused.id, "other-gate", true);
    store.setState({ run: { ...paused, status: "running" } });
    await store.getState().resume(paused.id, hil.id, true);
    expect(resume).not.toHaveBeenCalled();
    expect(store.getState().error).toMatch(/current paused HIL/);
  });

  it("records one approval on a multi-reviewer gate and explains that it stays paused", async () => {
    const { store, resume } = setupPaused();
    store.setState({
      run: {
        ...paused,
        graph: {
          ...paused.graph,
          blocks: [raw, { ...hil, params: { ...hil.params, approvals: 2 } }, car],
        },
      },
    });
    // The backend keeps the run paused until a second, different reviewer approves.
    resume.mockResolvedValueOnce(store.getState().run!);
    await store.getState().resume(paused.id, hil.id, true);
    expect(resume).toHaveBeenCalledWith(paused.id);
    expect(store.getState()).toMatchObject({
      error: null,
      busy: false,
      run: { status: "waiting_for_review" },
    });
    expect(store.getState().notice).toMatch(/needs 2 approvals from different reviewers/);
  });

  it("keeps the current gate paused after a resume failure so the human can retry", async () => {
    const { store, resume, listeners } = setupPaused();
    resume.mockRejectedValueOnce(new Error("Resume failed"));
    await store.getState().resume(paused.id, hil.id, true);
    expect(store.getState()).toMatchObject({
      error: "Resume failed",
      busy: false,
      run: { status: "waiting_for_review" },
    });
    expect(listeners.size).toBe(0);
  });

  it("prevents duplicate pending clicks and preserves a newer terminal update", async () => {
    const { store, resume, emit, listeners } = setupPaused();
    let resolve!: (value: WorkflowRun) => void;
    resume.mockImplementation(
      () =>
        new Promise<WorkflowRun>((r) => {
          resolve = r;
        }),
    );
    const pending = store.getState().resume(paused.id, hil.id, true);
    await store.getState().resume(paused.id, hil.id, true);
    expect(resume).toHaveBeenCalledTimes(1);
    emit({ ...paused, status: "completed" });
    resolve({ ...paused, status: "running" });
    await pending;
    expect(store.getState().run?.status).toBe("completed");
    expect(listeners.size).toBe(0);
  });

  it("keeps long-running resumed work cancellable", async () => {
    const { store, resume, emit, cancel } = setupPaused();
    let resolve!: (value: WorkflowRun) => void;
    resume.mockImplementation(
      () =>
        new Promise<WorkflowRun>((r) => {
          resolve = r;
        }),
    );
    const pending = store.getState().resume(paused.id, hil.id, true);
    emit({ ...paused, status: "running" });
    expect(store.getState().busy).toBe(false);
    await store.getState().cancel();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(paused.id);
    emit({ ...paused, status: "cancelled" });
    resolve({ ...paused, status: "running" });
    await pending;
    expect(store.getState().run?.status).toBe("cancelled");
  });

  it("does not regress a terminal resume result after stale active events", async () => {
    const { store, resume, emit } = setupPaused();
    resume.mockImplementation(async () => {
      emit({ ...paused, status: "completed" });
      emit({ ...paused, status: "running" });
      emit(paused);
      return { ...paused, status: "running" };
    });
    await store.getState().resume(paused.id, hil.id, true);
    expect(store.getState()).toMatchObject({ run: { status: "completed" }, busy: false });
  });

  it("requires a separate confirmation when execution pauses at the next HIL gate", async () => {
    const { store, resume } = setupPaused();
    const next = createBlock("hil", { id: "review-next", position: { x: 225, y: 0 } });
    resume.mockResolvedValue({
      ...paused,
      graph: { ...paused.graph, blocks: [...paused.graph.blocks, next] },
      blockRuns: [
        { blockId: hil.id, status: "succeeded", counts: {}, logs: [] },
        { blockId: next.id, status: "waiting_for_review", counts: {}, logs: [] },
      ],
    });
    await store.getState().resume(paused.id, hil.id, true);
    expect(pausedHil(store.getState().run)?.block.id).toBe(next.id);
    await store.getState().resume(paused.id, hil.id, true);
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
