import { useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { WorkflowSidebar } from "@/components/dataflow/WorkflowSidebar";
import { Breadcrumb } from "@/components/dataflow/Breadcrumb";
import { dataflowStore, useDataflow } from "@/components/dataflow/store";
import { Workplace } from "@/components/dataflow/Workplace";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { RunControls } from "@/components/dataflow/RunControls";
import { WorkflowControls } from "@/components/dataflow/WorkflowControls";
import { EditorActions } from "@/components/dataflow/EditorActions";
import { EditorShortcuts } from "@/components/dataflow/EditorShortcuts";
import { ProblemsPanel } from "@/components/dataflow/ProblemsPanel";
import { workflowProblems } from "@/components/dataflow/problems";

function WorkplaceActions() {
  const path = useDataflow((s) => s.path);
  const { fitView } = useReactFlow();

  return (
    <>
      {path.length > 0 && (
        <Button variant="secondary" onClick={() => dataflowStore.getState().goTo(path.length - 1)}>
          Back
        </Button>
      )}
      <Button
        variant="secondary"
        onClick={() => fitView({ maxZoom: 1, padding: 0.3, duration: 200 })}
      >
        Fit view
      </Button>
    </>
  );
}

import { HilReport } from "@/components/dataflow/report/HilReport";
import { AnalyticsHost } from "@/components/analytics/AnalyticsView";
import { ReasoningDialog } from "@/components/reasoning/ReasoningDialog";
import { walkBlocks } from "@reqflow/core";
import { runStore } from "@/components/dataflow/run-session";
import { api } from "@/lib/api";
import { useCallback } from "react";

function ReasoningDialogHost() {
  const reasoning = useDataflow((s) => s.reasoning);
  const block = useDataflow((s) =>
    reasoning ? [...walkBlocks(s.root)].find((b) => b.block.id === reasoning.blockId)?.block : null,
  );

  const load = useCallback(() => {
    if (!block) return Promise.resolve(null);
    const run = runStore.getState().run;
    if (run && [...walkBlocks(run.graph)].some((b) => b.block.id === block.id)) {
      return api.reasoning.forRun(run.id, block.id);
    }
    const workflowId = runStore.getState().workflowId;
    if (workflowId) {
      return api.reasoning.latest(workflowId, block.id);
    }
    return Promise.resolve(null);
  }, [block]);

  if (!reasoning || !block) return null;

  return (
    <ReasoningDialog
      title={`Thought process · ${block.label}`}
      load={load}
      onClose={() => dataflowStore.getState().closeReasoning()}
    />
  );
}

export function DataflowPage() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const name = useDataflow((s) => s.name);
  const root = useDataflow((s) => s.root);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const problems = useMemo(() => workflowProblems(root), [root]);

  return (
    <ReactFlowProvider>
      <EditorShortcuts />
      <div className="flex h-full flex-col gap-2">
        <WorkflowControls>
          <EditorActions
            problemCount={problems.length}
            problemsOpen={problemsOpen}
            onProblems={() => setProblemsOpen((open) => !open)}
          />
        </WorkflowControls>
        <RunControls />
        <div className="flex min-h-0 flex-1 gap-2">
          <h1 className="sr-only">Data Flow</h1>
          <WorkflowSidebar canvasRef={canvasRef} />
          <Panel
            title={
              <span className="flex min-w-0 items-center gap-3">
                <Breadcrumb />
                {name !== "Data Flow" && (
                  <span className="truncate text-sm font-normal text-muted" title={name}>
                    {name}
                  </span>
                )}
              </span>
            }
            actions={<WorkplaceActions />}
            className="flex-1"
            testId="workplace"
          >
            <Workplace canvasRef={canvasRef} />
          </Panel>
        </div>
      </div>
      <HilReport />
      <AnalyticsHost />
      <ReasoningDialogHost />
      <ProblemsPanel open={problemsOpen} onClose={() => setProblemsOpen(false)} />
    </ReactFlowProvider>
  );
}
