import {
  validateGraph,
  walkBlocks,
  type ProductScope,
  type ReqflowApi,
  type WorkflowGraph,
  type WorkflowRun,
  type Workflow,
  type WorkflowSave,
} from "@reqflow/core";
import { createStore } from "zustand/vanilla";

type RunApi = Pick<ReqflowApi, "workflows" | "runs">;
interface RunState {
  workflowId: string | null;
  run: WorkflowRun | null;
  busy: boolean;
  error: string | null;
  start(graph: WorkflowGraph, scope: ProductScope, name?: string): Promise<void>;
  cancel(): Promise<void>;
  resume(runId: string, blockId: string, confirmed: boolean): Promise<void>;
  reset(): boolean;
  subscribe(): () => void;
}

const active = (run: WorkflowRun | null) =>
  run !== null && ["queued", "running", "waiting_for_review"].includes(run.status);

export function pausedHil(run: WorkflowRun | null) {
  if (run?.status !== "waiting_for_review") return null;
  return (
    [...walkBlocks(run.graph)].find(
      ({ block }) =>
        block.kind === "hil" &&
        run.blockRuns.some((br) => br.blockId === block.id && br.status === "waiting_for_review"),
    ) ?? null
  );
}

const staleActiveUpdate = (current: WorkflowRun | null, next: WorkflowRun) =>
  current?.id === next.id && !active(current) && active(next);

/** Kept outside the page so changing tabs does not lose the current run or saved workflow id. */
export function createRunStore(
  api: RunApi,
  saveForRun?: (input: WorkflowSave) => Promise<{ workflow: Workflow; release(): void }>,
) {
  return createStore<RunState>()((set, get) => ({
    workflowId: null,
    run: null,
    busy: false,
    error: null,
    reset() {
      if (get().busy || active(get().run)) return false;
      set({ workflowId: null, run: null, error: null });
      return true;
    },
    async start(graph, scope, name = "Data Flow") {
      if (get().busy || active(get().run)) return;
      set({ busy: true, error: null });
      let release: (() => void) | undefined;
      try {
        if (!graph.blocks.length)
          throw new Error("Add and connect blocks before running the flow.");
        const issues = validateGraph(graph);
        if (issues.length) throw new Error(issues.map((issue) => issue.message).join("; "));
        // Snapshot before awaiting IPC: edits made while saving belong to the next run.
        const snapshot = structuredClone(graph);
        const input = {
          ...snapshot,
          scope: structuredClone(scope),
          name,
          ...(get().workflowId ? { id: get().workflowId! } : {}),
        };
        const reservation = saveForRun ? await saveForRun(input) : null;
        release = reservation?.release;
        const saved = reservation?.workflow ?? (await api.workflows.save(input));
        set({ workflowId: saved.id, run: null });
        const updates = new Map<string, WorkflowRun>();
        const unsubscribe = api.runs.onUpdate((run) => {
          if (run.workflowId === saved.id) updates.set(run.id, run);
        });
        try {
          const started = await api.runs.start(saved.id);
          // Updates can reach the renderer before start() returns its initial running snapshot.
          set({ run: updates.get(started.id) ?? started });
        } finally {
          unsubscribe();
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        release?.();
        set({ busy: false });
      }
    },
    async cancel() {
      const run = get().run;
      if (!run || get().busy || !active(run)) return;
      set({ busy: true, error: null });
      try {
        set({ run: await api.runs.cancel(run.id) });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        set({ busy: false });
      }
    },
    async resume(runId, blockId, confirmed) {
      if (get().busy) return;
      const run = get().run;
      const gate = pausedHil(run);
      if (!confirmed || run?.id !== runId || gate?.block.id !== blockId) {
        set({ error: "Review and confirm the current paused HIL step before continuing." });
        return;
      }
      if (gate.block.params.approvals !== 1) {
        set({
          error:
            "This gate requires multiple reviewers. Multiple review confirmations are not supported yet.",
        });
        return;
      }
      set({ busy: true, error: null });
      const updates = new Map<string, WorkflowRun>();
      const unsubscribe = api.runs.onUpdate((next) => {
        if (next.id !== runId || staleActiveUpdate(get().run, next)) return;
        updates.set(next.id, next);
        // Once execution starts, let the human cancel long-running downstream work.
        set({ run: next, busy: next.status !== "running" });
      });
      try {
        const resumed = await api.runs.resume(runId);
        const latest = updates.get(runId) ?? resumed;
        if (get().run?.id === runId && !staleActiveUpdate(get().run, latest)) set({ run: latest });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      } finally {
        unsubscribe();
        set({ busy: false });
      }
    },
    subscribe() {
      let disposed = false;
      let receivedUpdate = false;
      const unsubscribe = api.runs.onUpdate((run) => {
        if (get().run?.id === run.id && !staleActiveUpdate(get().run, run)) {
          receivedUpdate = true;
          set({ run, error: null });
        }
      });
      // Catch up when the page remounts after a run finished while the Car tab was open.
      const current = get().run;
      if (current) {
        void api.runs.get(current.id).then(
          (run) => {
            if (
              !disposed &&
              !receivedUpdate &&
              get().run?.id === run.id &&
              !staleActiveUpdate(get().run, run)
            )
              set({ run, error: null });
          },
          (err: unknown) => {
            if (!disposed && !receivedUpdate && get().run?.id === current.id)
              set({ error: err instanceof Error ? err.message : String(err) });
          },
        );
      }
      return () => {
        disposed = true;
        unsubscribe();
      };
    },
  }));
}
