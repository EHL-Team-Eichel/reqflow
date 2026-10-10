import { WorkflowRun } from "@reqflow/core";

/** Startup recovery only; paused HIL runs remain resumable by the engine. */
export function recoverInterruptedRun(run: WorkflowRun): WorkflowRun {
  if (run.status !== "running" && run.status !== "queued") return run;
  const recovered = structuredClone(run);
  recovered.status = "failed";
  recovered.finishedAt = new Date().toISOString();
  recovered.error =
    "App stopped before run finished; preserved outputs and research remain available.";
  for (const block of recovered.blockRuns) {
    if (["succeeded", "failed", "skipped"].includes(block.status)) continue;
    block.status = block.status === "running" ? "failed" : "skipped";
    block.finishedAt = recovered.finishedAt;
    if (block.status === "failed") block.error = recovered.error;
  }
  return WorkflowRun.parse(recovered);
}
