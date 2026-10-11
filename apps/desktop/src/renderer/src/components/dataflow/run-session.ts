import { api } from "@/lib/api";
import { createRunStore } from "./run-store";
import { createWorkflowStore } from "./workflow-store";
import { dataflowStore } from "./store";
import { settingsStore } from "@/lib/settings";

// Run callbacks are deferred until initialization/user actions, avoiding construction-time cycles.
export const workflowStore = createWorkflowStore(api, dataflowStore, {
  defaultScope: () => settingsStore.getState().settings.defaultScope,
  blocked: () => {
    const state = runStore.getState();
    return (
      state.busy || ["queued", "running", "waiting_for_review"].includes(state.run?.status ?? "")
    );
  },
  resetRun: () => runStore.getState().reset(),
  setWorkflowId: (id) => runStore.setState({ workflowId: id }),
  attachRun: (id, run) => runStore.setState({ workflowId: id, run, error: null }),
  storage: () => (typeof window === "undefined" ? null : window.localStorage),
});
export const runStore = createRunStore(api, (input) => workflowStore.getState().saveForRun(input));
