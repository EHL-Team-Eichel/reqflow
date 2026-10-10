import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { graphAt, traceLineage, type WorkflowBlock, type WorkflowGraph } from "@reqflow/core";
import { useDataflow, dataflowStore } from "../store";
import { BlockIcon } from "../BlockIcon";
import { GROUP_STYLE } from "../groups";
import { MStripe } from "@/components/ui/MStripe";
import { Button } from "@/components/ui/Button";
import { TableIcon, XIcon } from "@/components/ui/icons";
import { LineageChart } from "./LineageChart";
import { DataPanel } from "./DataPanel";
import { cx } from "@/lib/cx";

const REVIEWER_LABELS: Record<string, string> = {
  pm: "Product manager",
  expert: "Domain expert",
  anyone: "Any team member",
};

/** The HIL review report: lineage flow chart + the data at each step. Opened by double-click. */
export function HilReport() {
  const report = useDataflow((s) => s.report);
  const root = useDataflow((s) => s.root);
  const block = useMemo(() => {
    if (!report) return null;
    try {
      return graphAt(root, report.path).blocks.find((b) => b.id === report.blockId) ?? null;
    } catch {
      return null; // its workplace was deleted
    }
  }, [root, report]);

  useEffect(() => {
    if (report && !block) dataflowStore.getState().closeReport();
  }, [report, block]);

  if (!report || !block) return null;
  // Keyed by block: selection and sample toggle start fresh for every report.
  return <ReportDialog key={block.id} root={root} path={report.path} block={block} />;
}

function ReportDialog({
  root,
  path,
  block,
}: {
  root: WorkflowGraph;
  path: string[];
  block: WorkflowBlock;
}) {
  const lineage = useMemo(() => traceLineage(root, path, block.id), [root, path, block.id]);
  const [selectedStepId, setSelectedStepId] = useState(block.id);
  const [showSample, setShowSample] = useState(false);
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
  const style = GROUP_STYLE.human;
  const instructions = String(block.params.instructions ?? "").trim();
  const reviewerLabel =
    REVIEWER_LABELS[String(block.params.reviewer)] ?? String(block.params.reviewer);
  const approvalsNeeded = Number(block.params.approvals);
  const mayEdit = block.params.allowEdits === true;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hil-report-title"
      data-testid="hil-report"
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-6"
      onClick={handleBackdropClick}
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        className="relative h-full w-full max-w-[1400px] flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl outline-none"
      >
        <MStripe />

        {/* Header */}
        <div className="flex flex-col border-b border-line p-6">
          <div className="flex items-start justify-between">
            <div className="flex gap-4">
              <div
                className={cx(
                  "flex size-12 shrink-0 items-center justify-center rounded-xl",
                  style.tile,
                )}
              >
                <BlockIcon kind={block.kind} className="size-6" />
              </div>
              <div>
                <h2 id="hil-report-title" className="text-xl font-semibold text-ink">
                  Review report · {block.label}
                </h2>
                <div className="mt-1 flex items-center gap-2 text-sm text-muted">
                  <span>Human in the loop</span>
                  <span className="w-1 h-1 rounded-full bg-line" />
                  <span>Reviewer: {reviewerLabel}</span>
                  <span className="w-1 h-1 rounded-full bg-line" />
                  <span>Approvals needed: {approvalsNeeded}</span>
                  <span className="w-1 h-1 rounded-full bg-line" />
                  <span>Reviewer may edit: {mayEdit ? "yes" : "no"}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4">
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

          <div className="mt-6 text-sm">
            {instructions ? (
              <div className="rounded-lg bg-panel-2 p-4 text-ink">{instructions}</div>
            ) : (
              <div className="text-muted">
                No instructions for the reviewer yet — add them in the block's parameters.
              </div>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(380px,42%)]">
          <div className="flex flex-col h-full bg-panel-2">
            <div className="p-6 pb-2">
              <h3 className="font-semibold text-ink">How the data was collected</h3>
              <p className="text-sm text-muted mt-1">
                Every step the data passed through on its way here. Click a step's table icon to see
                its data.
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
              step={currentStep}
              isTarget={currentStep.block.id === lineage.targetId}
              showSample={showSample}
              onShowSample={setShowSample}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
