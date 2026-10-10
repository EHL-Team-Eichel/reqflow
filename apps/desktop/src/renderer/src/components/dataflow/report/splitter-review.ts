import { SplitterReview, WorkflowRun, type SplitterReview as Review } from "@reqflow/core";
import { reportForStep, splitterReviewGate } from "./splitter-view";

/** Matches the core IPC contract; optional while an older bridge has no review method. */
export interface SplitterReviewApi {
  reviewSplitter?: (runId: string, blockId: string, review: Review) => Promise<WorkflowRun>;
}
interface ReviewState {
  run: WorkflowRun | null;
  busy: boolean;
  error: string | null;
}
interface ReviewStore {
  getState(): ReviewState;
  setState(patch: Partial<ReviewState>): void;
}

export async function saveSplitterCorrection(
  store: ReviewStore,
  api: SplitterReviewApi,
  runId: string,
  blockId: string,
  input: Review,
) {
  const state = store.getState();
  if (state.busy) throw new Error("Wait for the current run action to finish.");
  try {
    const review = SplitterReview.parse(input);
    const report = reportForStep(state.run, blockId);
    if (state.run?.id !== runId || !report || !splitterReviewGate(state.run, blockId))
      throw new Error(
        "Routing corrections require an editable paused HIL gate upstream of continuation.",
      );
    if (review.expectedVersion !== report.reviews.length)
      throw new Error(
        "Review version changed. Read the latest saved report before correcting a route.",
      );
    for (const change of review.changes) {
      const assignment = report.assignments.find((item) => item.itemId === change.itemId);
      if (!assignment || !report.branches.some((branch) => branch.portId === change.toPortId))
        throw new Error("Choose an item and output from the saved report.");
      if (assignment.outputPortId === change.toPortId)
        throw new Error("Choose a different output.");
    }
    if (!api.reviewSplitter)
      throw new Error("Routing correction is not available in this app version.");
    store.setState({ busy: true, error: null });
    const saved = WorkflowRun.parse(await api.reviewSplitter(runId, blockId, review));
    const savedReport = reportForStep(saved, blockId);
    if (saved.id !== runId || !savedReport || savedReport.reviews.length <= review.expectedVersion)
      throw new Error(
        "The server did not return a persisted routing correction. Reload the run before retrying.",
      );
    const current = store.getState().run;
    // A pushed update can arrive before IPC returns. Never replace a newer persisted revision.
    if (
      current?.id === runId &&
      (reportForStep(current, blockId)?.reviews.length ?? 0) <= savedReport.reviews.length &&
      current.status === "waiting_for_review"
    )
      store.setState({ run: saved });
    return saved;
  } catch (err) {
    store.setState({ error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    store.setState({ busy: false });
  }
}
