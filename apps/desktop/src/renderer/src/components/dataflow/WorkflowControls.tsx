import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { Button } from "../ui/Button";
import { useSettings } from "@/lib/settings";
import { dataflowStore, useDataflow } from "./store";
import { runStore, workflowStore } from "./run-session";

const replaceConfirmed = () =>
  window.confirm("Replace this workflow? Unsaved edits will be lost. No workflow will be started.");

export function WorkflowControls({ children }: { children?: ReactNode }) {
  const name = useDataflow((s) => s.name);
  const state = useStore(workflowStore);
  const run = useStore(runStore, (s) => s.run);
  const busy = useStore(runStore, (s) => s.busy);
  const globalScope = useSettings((s) => s.settings.defaultScope);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const blocked =
    busy ||
    state.loading ||
    ["queued", "running", "waiting_for_review"].includes(run?.status ?? "");

  useEffect(() => {
    const stop = workflowStore.getState().watch();
    void workflowStore.getState().initialize();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!workflowStore.getState().dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const saveKey = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "s" ||
        event.isComposing
      )
        return;
      if (document.querySelector("dialog[open], [role='dialog'][aria-modal='true']")) return;
      event.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      void workflowStore
        .getState()
        .save()
        .catch(() => {});
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("keydown", saveKey);
    return () => {
      stop();
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("keydown", saveKey);
    };
  }, []);
  useEffect(() => workflowStore.getState().updateGlobalScope(globalScope), [globalScope]);
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [open]);

  const load = async (id: string) => {
    if (await workflowStore.getState().load(id, replaceConfirmed)) setOpen(false);
  };
  const status = state.loading
    ? "Opening..."
    : state.saving
      ? "Saving..."
      : state.dirty
        ? "Unsaved changes"
        : state.id
          ? `Saved (v${state.version})`
          : "New workflow";

  return (
    <section
      aria-label="Workflow document controls"
      data-testid="workflow-controls"
      className="shrink-0 rounded-xl border border-line bg-panel px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="workflow-name">
          Workflow name
        </label>
        <input
          id="workflow-name"
          data-testid="workflow-name"
          value={name}
          onChange={(event) => dataflowStore.getState().setName(event.target.value)}
          className="h-8 w-48 rounded-lg border border-line bg-panel-2 px-2 text-sm font-medium text-ink focus-visible:outline-brand"
        />
        <Button
          size="sm"
          data-testid="workflow-new"
          disabled={blocked}
          title={
            blocked
              ? "Finish or cancel this run before switching workflows"
              : "Start an empty document without running it"
          }
          onClick={() => workflowStore.getState().newDraft(replaceConfirmed)}
        >
          New
        </Button>
        <Button
          size="sm"
          data-testid="workflow-open"
          disabled={blocked}
          onClick={() => {
            setOpen(true);
            void workflowStore.getState().refresh();
          }}
        >
          Open
        </Button>
        <Button
          size="sm"
          data-testid="workflow-save"
          disabled={state.loading || state.saving || !name.trim()}
          title="Save the draft without executing it (Ctrl/Cmd S)"
          onClick={() =>
            void workflowStore
              .getState()
              .save()
              .catch(() => {})
          }
        >
          Save
        </Button>
        <span data-testid="workflow-save-status" role="status" className="text-xs text-muted">
          {status}
        </span>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
        {children}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span data-testid="workflow-scope">
          {state.scopeOrigin === "saved" ? "Saved scope" : "Global scope"}:{" "}
          {state.scope.vehicleLine} / {state.scope.market} / {state.scope.horizonYears} years
        </span>
        {state.scopeOrigin === "saved" && (
          <button
            type="button"
            className="text-brand hover:underline"
            onClick={() => workflowStore.getState().useGlobalScope()}
          >
            Use current global scope
          </button>
        )}
        <span>Edits autosave. Only Start executes the flow.</span>
      </div>
      {state.error && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {state.error}{" "}
          <button
            type="button"
            className="font-medium underline"
            onClick={() =>
              void workflowStore
                .getState()
                .save()
                .catch(() => {})
            }
          >
            Retry save
          </button>
        </p>
      )}
      {state.storageWarning && (
        <p role="status" className="mt-1 text-xs text-warn">
          {state.storageWarning}
        </p>
      )}
      {open && (
        <dialog
          ref={dialog}
          aria-labelledby="workflow-library-title"
          data-testid="workflow-library"
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          className="fixed inset-0 m-auto max-h-[80vh] w-[min(620px,calc(100vw-3rem))] rounded-xl border border-line bg-panel p-0 text-ink shadow-xl backdrop:bg-black/40"
        >
          <header className="flex items-center justify-between border-b border-line p-4">
            <h2 id="workflow-library-title" className="font-semibold">
              Saved workflows
            </h2>
            <Button size="sm" data-testid="workflow-library-close" onClick={() => setOpen(false)}>
              Close
            </Button>
          </header>
          <div className="max-h-[60vh] overflow-auto p-4">
            {state.listing && (
              <p role="status" className="text-sm text-muted">
                Loading saved workflows...
              </p>
            )}
            {state.error && (
              <p role="alert" className="mb-3 text-sm text-danger">
                {state.error}
              </p>
            )}
            {!state.listing && !state.library.length && (
              <p className="text-sm text-muted">
                No saved workflows yet. Name your flow and choose Save.
              </p>
            )}
            <div className="space-y-2">
              {state.library.map((workflow) => (
                <button
                  key={workflow.id}
                  type="button"
                  data-testid={`workflow-load-${workflow.id}`}
                  disabled={blocked}
                  onClick={() => void load(workflow.id)}
                  className="block w-full rounded-lg border border-line bg-panel-2 p-3 text-left hover:border-brand disabled:opacity-50"
                >
                  <span className="block text-sm font-medium">{workflow.name}</span>
                  <span className="block text-xs text-muted">
                    {workflow.blocks.length} blocks / {workflow.scope.vehicleLine} /{" "}
                    {workflow.scope.market} / v{workflow.version} /{" "}
                    {new Date(workflow.updatedAt).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
            <Button
              size="sm"
              className="mt-3"
              disabled={state.listing}
              data-testid="workflow-library-refresh"
              onClick={() => void workflowStore.getState().refresh()}
            >
              Refresh library
            </Button>
          </div>
        </dialog>
      )}
    </section>
  );
}
