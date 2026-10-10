import { useRef } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { WorkflowSidebar } from "@/components/dataflow/WorkflowSidebar";
import { Breadcrumb } from "@/components/dataflow/Breadcrumb";
import { dataflowStore, useDataflow } from "@/components/dataflow/store";
import { Workplace } from "@/components/dataflow/Workplace";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { RunControls } from "@/components/dataflow/RunControls";

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

export function DataflowPage() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const name = useDataflow((s) => s.name);

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col gap-2">
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
    </ReactFlowProvider>
  );
}
