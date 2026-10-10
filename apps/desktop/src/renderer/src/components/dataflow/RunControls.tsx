import { useEffect } from "react";
import { useStore } from "zustand";
import { Link } from "react-router";
import { Button } from "../ui/Button";
import { useSettings } from "../../lib/settings";
import { dataflowStore, useDataflow } from "./store";
import { pausedHil } from "./run-store";
import { runStore } from "./run-session";
import { startControl } from "./start-control";
import { ResearchResults, ResearchRunDetails } from "./ResearchResults";

const STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  waiting_for_review: "Waiting for human review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function RunControls() {
  const name = useDataflow((s) => s.name);
  const root = useDataflow((s) => s.root);
  const scope = useSettings((s) => s.settings.defaultScope);
  const run = useStore(runStore, (s) => s.run);
  const busy = useStore(runStore, (s) => s.busy);
  const error = useStore(runStore, (s) => s.error);
  const active = run && ["queued", "running", "waiting_for_review"].includes(run.status);
  const gate = pausedHil(run);
  const start = startControl(run?.status ?? null, busy, root.blocks.length);
  useEffect(() => runStore.getState().subscribe(), []);

  return (
    <section
      aria-label="Workflow run controls"
      data-testid="run-controls"
      className="max-h-72 shrink-0 overflow-auto rounded-xl border border-line bg-panel px-4 py-2"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          data-testid="flow-run"
          disabled={start.disabled}
          title={start.title}
          onClick={() => void runStore.getState().start(root, scope, name)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7Z" />
          </svg>
          {start.label}
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
        {gate && (
          <Button
            variant="primary"
            data-testid="flow-review"
            disabled={busy}
            onClick={() =>
              dataflowStore.setState({ report: { blockId: gate.block.id, path: gate.path } })
            }
          >
            Review paused step
          </Button>
        )}
        <div className="min-w-0 flex-1 text-sm">
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
          {run ? (
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
              Start saves and runs the entire workflow, including inner workplaces. It pauses at HIL
              for human review.
            </p>
          )}
        </div>
        <Link to="/car" className="text-sm font-medium text-brand hover:underline">
          View car
        </Link>
      </div>
      {run && (
        <>
          <ResearchRunDetails key={`output:${run.id}`} run={run} />
          <ResearchResults key={`research:${run.id}`} run={run} busy={busy} />
        </>
      )}
    </section>
  );
}
