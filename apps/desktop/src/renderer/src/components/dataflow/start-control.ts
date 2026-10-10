import type { WorkflowRun } from "@reqflow/core";

/** Start always executes the saved root flow, including all inner workplaces. */
export function startControl(
  status: WorkflowRun["status"] | null,
  busy: boolean,
  blockCount: number,
) {
  const active = status === "queued" || status === "running" || status === "waiting_for_review";
  const label =
    status === "waiting_for_review"
      ? "Review required"
      : status === "queued"
        ? "Queued…"
        : status === "running"
          ? "Running…"
          : busy
            ? "Starting…"
            : "Start";
  const title =
    status === "waiting_for_review"
      ? "The flow is paused for human review. Cancel it before starting another run."
      : active
        ? "The full workflow is already running."
        : busy
          ? "Saving the flow and starting execution."
          : blockCount === 0
            ? "Add building blocks before starting the flow."
            : "Save and run the entire workflow, including inner workplaces. Pause at HIL for human review.";

  return { label, title, disabled: busy || active || blockCount === 0 };
}
