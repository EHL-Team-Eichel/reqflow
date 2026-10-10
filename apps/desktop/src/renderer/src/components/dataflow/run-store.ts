import {
  validateGraph,
  type ProductScope,
  type ReqflowApi,
  type WorkflowGraph,
  type WorkflowRun,
} from "@reqflow/core";
import { createStore } from "zustand/vanilla";

type RunApi = Pick<ReqflowApi, "workflows" | "runs">;
interface RunState {
  workflowId: string | null;
  run: WorkflowRun | null;
  busy: boolean;
  error: string | null;
  start(graph: WorkflowGraph, scope: ProductScope): Promise<void>;
  cancel(): Promise<void>;
  subscribe(): () => void;
}

const active = (run: WorkflowRun | null) =>
  run !== null && ["queued", "running", "waiting_for_review"].includes(run.status);

const staleActiveUpdate = (current: WorkflowRun | null, next: WorkflowRun) =>
  current?.id === next.id && !active(current) && active(next);

/** Kept outside the page so changing tabs does not lose the current run or saved workflow id. */
export function createRunStore(api: RunApi) {
  return createStore<RunState>()((set, get) => ({
    workflowId: null,
    run: null,
    busy: false,
    error: null,
    async start(graph, scope) {
      if (get().busy || active(get().run)) return;
      set({ busy: true, error: null });
      try {
        if (!graph.blocks.length)
          throw new Error("Add and connect blocks before running the flow.");
        const issues = validateGraph(graph);
        if (issues.length) throw new Error(issues.map((issue) => issue.message).join("; "));
        // Snapshot before awaiting IPC: edits made while saving belong to the next run.
        const snapshot = structuredClone(graph);
        const saved = await api.workflows.save({
          ...snapshot,
          scope: structuredClone(scope),
          name: "Data Flow",
          ...(get().workflowId ? { id: get().workflowId! } : {}),
        });
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
