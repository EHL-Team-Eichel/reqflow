import { useEffect } from "react";
import { useStore } from "zustand";
import { Link } from "react-router";
import { walkBlocks } from "@reqflow/core";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { useDataflow } from "./store";
import { createRunStore } from "./run-store";

const runStore = createRunStore(api);
const STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  waiting_for_review: "Waiting for human review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function RunControls() {
  const root = useDataflow((s) => s.root);
  const scope = useSettings((s) => s.settings.defaultScope);
  const run = useStore(runStore, (s) => s.run);
  const busy = useStore(runStore, (s) => s.busy);
  const error = useStore(runStore, (s) => s.error);
  const active = run && ["queued", "running", "waiting_for_review"].includes(run.status);
  const labels = new Map(
    run ? [...walkBlocks(run.graph)].map(({ block }) => [block.id, block.label]) : [],
  );

  useEffect(() => runStore.getState().subscribe(), []);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-panel px-4 py-2">
      <Button
        variant="primary"
        data-testid="flow-run"
        disabled={busy || !!active || root.blocks.length === 0}
        onClick={() => void runStore.getState().start(root, scope)}
      >
        {busy ? "Working…" : "Save & run"}
      </Button>
      {active && (
        <Button
          data-testid="flow-cancel"
          disabled={busy}
          onClick={() => void runStore.getState().cancel()}
        >
          Cancel run
        </Button>
      )}
      <div className="min-w-0 flex-1 text-sm">
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : run ? (
          <div data-testid="flow-run-status" aria-live="polite" className="text-ink">
            {STATUS_LABELS[run.status]}
            {run.error && (
              <span role="alert" className="ml-2 text-danger">
                {run.error}
              </span>
            )}
            {run.status === "waiting_for_review" && (
              <p className="text-xs text-muted">
                The flow is paused at HIL. Nothing downstream is added until human review resumes
                it.
              </p>
            )}
            <p className="text-xs text-muted">
              This run uses the saved flow snapshot. Edits apply to the next run.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted">
            Connections configure the flow. Run it to publish proposed requirements through Add to
            Car.
          </p>
        )}
      </div>
      {run && (
        <details className="max-w-full text-xs text-muted" data-testid="flow-run-details">
          <summary className="cursor-pointer">Block status & logs</summary>
          <div className="mt-2 max-h-56 overflow-auto">
            {run.blockRuns.map((blockRun) => (
              <div key={blockRun.blockId} className="border-t border-line py-2">
                <span className="font-medium text-ink">
                  {labels.get(blockRun.blockId) ?? blockRun.blockId}:{" "}
                  {blockRun.status.replaceAll("_", " ")}
                </span>
                {blockRun.error && (
                  <p role="alert" className="text-danger">
                    {blockRun.error}
                  </p>
                )}
                {blockRun.logs.map((log, i) => (
                  <p key={i}>{log.message}</p>
                ))}
              </div>
            ))}
          </div>
        </details>
      )}
      <Link to="/car" className="text-sm font-medium text-brand hover:underline">
        View car
      </Link>
    </div>
  );
}
