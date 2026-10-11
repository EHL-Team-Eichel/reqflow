import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  graphAt,
  traceLineage,
  walkBlocks,
  type WorkflowBlock,
  type WorkflowGraph,
  type WorkflowRun,
} from "@reqflow/core";
import { useStore } from "zustand";
import { useDataflow, dataflowStore } from "../store";
import { BlockIcon } from "../BlockIcon";
import { GROUP_STYLE } from "../groups";
import { MStripe } from "@/components/ui/MStripe";
import { Button } from "@/components/ui/Button";
import { TableIcon, XIcon } from "@/components/ui/icons";
import { LineageChart } from "./LineageChart";
import { DataPanel } from "./DataPanel";
import { cx } from "@/lib/cx";
import { runStore } from "../run-session";
import { pausedHil } from "../run-store";
import { reportsInLineage } from "./splitter-view";

const REVIEWER_LABELS: Record<string, string> = {
  pm: "Product manager",
  expert: "Domain expert",
  anyone: "Any team member",
};

/** HIL and splitter inspection share the saved graph lineage and exact historical outputs. */
export function HilReport() {
  const report = useDataflow((s) => s.report);
  const editorRoot = useDataflow((s) => s.root);
  const currentRun = useStore(runStore, (s) => s.run);
  const snapshotStep = useMemo(
    () =>
      currentRun && report
        ? [...walkBlocks(currentRun.graph)].find(({ block }) => block.id === report.blockId)
        : undefined,
    [currentRun, report],
  );
  const run = snapshotStep ? currentRun : null;
  const root = run?.graph ?? editorRoot;
  const path = snapshotStep?.path ?? report?.path ?? [];
  const block = useMemo(() => {
    if (!report) return null;
    try {
      return graphAt(root, path).blocks.find((b) => b.id === report.blockId) ?? null;
    } catch {
      return null; // its workplace was deleted
    }
  }, [root, path, report]);

  useEffect(() => {
    if (report && !block) dataflowStore.getState().closeReport();
  }, [report, block]);

  if (!report || !block) return null;
  // Keyed by block: the selection starts fresh for every report.
  return (
    <ReportDialog
      key={`${run?.id ?? "preview"}:${block.id}`}
      root={root}
      path={path}
      block={block}
      run={run}
    />
  );
}

function ReportDialog({
  root,
  path,
  block,
  run,
}: {
  root: WorkflowGraph;
  path: string[];
  block: WorkflowBlock;
  run: WorkflowRun | null;
}) {
  const lineage = useMemo(() => traceLineage(root, path, block.id), [root, path, block.id]);
  const upstreamReports = useMemo(() => reportsInLineage(run, lineage), [run, lineage]);
  const [pickedReportId, setPickedReportId] = useState("");
  const [selectedStepId, setSelectedStepId] = useState(block.id);
  const [reviewReady, setReviewReady] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const busy = useStore(runStore, (s) => s.busy);
  const error = useStore(runStore, (s) => s.error);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => cardRef.current?.focus(), []);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dataflowStore.getState().closeReport();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) dataflowStore.getState().closeReport();
  };

  const currentStep = lineage.steps.find((s) => s.block.id === selectedStepId) ?? lineage.steps[0]!;
  const currentStepId = currentStep.block.id;
  const isHil = block.kind === "hil";
  const style = isHil ? GROUP_STYLE.human : GROUP_STYLE.ai;
  const instructions = String(block.params.instructions ?? "").trim();
  const reviewerLabel =
    REVIEWER_LABELS[String(block.params.reviewer)] ?? String(block.params.reviewer);
  const approvalsNeeded = Number(block.params.approvals);
  const mayEdit = block.params.allowEdits === true;
  const waitingHere = isHil && pausedHil(run)?.block.id === block.id;
  const pickedReport =
    upstreamReports.find(({ step }) => step.block.id === pickedReportId) ?? upstreamReports[0];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hil-report-title"
      data-testid="hil-report"
      data-report-kind={block.kind}
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-2 sm:p-6"
      onClick={handleBackdropClick}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        className="relative h-full w-full max-w-[1400px] flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl outline-none"
      >
        <MStripe />

        {/* Header */}
        <div className="flex flex-col border-b border-line p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 gap-4">
              <div
                className={cx(
                  "flex size-12 shrink-0 items-center justify-center rounded-xl",
                  style.tile,
                )}
              >
                <BlockIcon kind={block.kind} className="size-6" />
              </div>
              <div className="min-w-0 break-words">
                <h2 id="hil-report-title" className="text-xl font-semibold text-ink">
                  {isHil
                    ? "Review report"
                    : block.kind === "ai_filter"
                      ? "Filtering & review report"
                      : "Scores & routing report"}{" "}
                  · {block.label}
                </h2>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
                  {isHil ? (
                    <>
                      <span>Human in the loop</span>
                      <span className="w-1 h-1 rounded-full bg-line" />
                      <span>Reviewer: {reviewerLabel}</span>
                      <span className="w-1 h-1 rounded-full bg-line" />
                      <span>Approvals needed: {approvalsNeeded}</span>
                      <span className="w-1 h-1 rounded-full bg-line" />
                      <span>Reviewer may edit: {mayEdit ? "yes" : "no"}</span>
                    </>
                  ) : (
                    <span>
                      {block.kind === "ai_filter"
                        ? "Saved filter decisions and next-run restores only"
                        : "Classifications and routing only"}{" "}
                      · no requirement decisions
                    </span>
                  )}
                  <span className="w-1 h-1 rounded-full bg-line" />
                  <span>{run ? "Saved run snapshot" : "No saved run"}</span>
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-4">
              <Button
                variant="secondary"
                data-testid="report-data"
                onClick={() => setSelectedStepId(lineage.targetId)}
                className="gap-2"
              >
                <TableIcon className="size-4" />
                Data at this point
              </Button>
              <button
                aria-label="Close report"
                className="rounded-lg p-2 text-muted hover:bg-panel-2 hover:text-ink"
                onClick={() => dataflowStore.getState().closeReport()}
              >
                <XIcon className="size-5" />
              </button>
            </div>
          </div>

          {isHil && (
            <div className="mt-3 text-sm">
              {instructions ? (
                <div className="rounded-lg bg-panel-2 p-3 text-ink">{instructions}</div>
              ) : (
                <div className="text-muted">
                  No instructions for the reviewer yet — add them in the block's parameters.
                </div>
              )}
            </div>
          )}
          {isHil && upstreamReports.length > 0 && (
            <div
              className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-brand-soft px-3 py-2"
              data-testid="hil-upstream-splitter-reports"
            >
              <label htmlFor="upstream-splitter-report" className="text-sm font-medium text-ink">
                Upstream splitter analysis
              </label>
              <select
                id="upstream-splitter-report"
                value={pickedReport?.step.block.id ?? ""}
                onChange={(event) => setPickedReportId(event.target.value)}
                className="min-w-0 max-w-80 rounded border border-line bg-panel px-2 py-1 text-sm text-ink focus-visible:outline-2 focus-visible:outline-brand"
              >
                {upstreamReports.map(({ step, report }) => (
                  <option key={step.block.id} value={step.block.id}>
                    {step.block.label} · {report.groups.length} groups · review v
                    {report.reviews.length}
                  </option>
                ))}
              </select>
              <Button
                data-testid="hil-open-upstream-report"
                variant="primary"
                onClick={() => pickedReport && setSelectedStepId(pickedReport.step.block.id)}
              >
                Review scores & evidence
              </Button>
              <span className="text-xs text-muted">
                Nearest upstream report selected first. Saved in this run.
              </span>
            </div>
          )}
        </div>

        {/* Body */}
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(260px,28%)_minmax(0,1fr)]">
          <div className="hidden flex-col h-full bg-panel-2 md:flex">
            <div className="p-4 pb-2">
              <h3 className="font-semibold text-ink">How the data was collected</h3>
              <p className="text-sm text-muted mt-1">
                Saved lineage when a run exists. Select a step to inspect its data; splitter steps
                also show saved scores and routing.
              </p>
            </div>

            <div className="relative flex-1 min-h-0">
              {lineage.steps.length === 1 && (
                <div
                  data-testid="lineage-empty"
                  className="absolute top-4 left-6 right-6 z-10 rounded-lg border border-line bg-panel p-4 text-sm text-ink shadow-sm text-center"
                >
                  Nothing flows into this block yet. Connect its input to see how the data is
                  collected.
                </div>
              )}
              <LineageChart
                lineage={lineage}
                selectedStepId={currentStepId}
                onSelectStep={setSelectedStepId}
                root={root}
              />
            </div>
          </div>

          <div className="min-h-0">
            <DataPanel
              key={currentStep.block.id}
              root={root}
              run={run}
              onReviewReady={setReviewReady}
              step={currentStep}
              isTarget={currentStep.block.id === lineage.targetId}
              gateBlock={block}
              lineage={lineage}
            />
          </div>
        </div>
        {waitingHere && run && (
          <div
            className="flex flex-wrap items-center gap-4 border-t border-line bg-panel p-4"
            data-testid="hil-review-actions"
          >
            <div className="min-w-0 flex-1 text-sm">
              {approvalsNeeded !== 1 ? (
                <p role="alert" className="text-warn">
                  This gate needs multiple reviewers. The current review UI supports one reviewer;
                  this gate cannot be continued here.
                </p>
              ) : (
                <label className="flex items-start gap-3 text-ink">
                  <input
                    type="checkbox"
                    data-testid="hil-review-confirm"
                    className="mt-1 accent-brand"
                    checked={confirmed}
                    disabled={!reviewReady || busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>
                    I have reviewed the saved data and authorize continuing this flow. This does not
                    approve or reject any requirements.
                  </span>
                </label>
              )}
              {!reviewReady && (
                <p className="mt-1 text-xs text-muted">
                  Open “Data at this point” and wait for the saved run data before continuing.
                </p>
              )}
              {error && (
                <p role="alert" className="mt-1 text-danger">
                  {error}
                </p>
              )}
            </div>
            <Button
              variant="primary"
              data-testid="hil-review-continue"
              disabled={busy || !reviewReady || !confirmed || approvalsNeeded !== 1}
              onClick={() => void runStore.getState().resume(run.id, block.id, confirmed)}
            >
              {busy ? "Continuing…" : "Continue flow"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
