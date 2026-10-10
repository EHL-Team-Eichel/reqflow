import { useRef } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { BlockPalette } from "@/components/dataflow/BlockPalette";
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

  return (
    <ReactFlowProvider>
      <div className="flex h-full flex-col gap-2">
        <RunControls />
        <div className="flex min-h-0 flex-1 gap-2">
          <h1 className="sr-only">Data Flow</h1>
          <Panel title="Building Blocks" className="w-1/4 min-w-64 max-w-sm" testId="palette">
            <BlockPalette canvasRef={canvasRef} />
          </Panel>
          <Panel
            title={<Breadcrumb />}
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
