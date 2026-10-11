import { memo, useMemo } from "react";
import { useStore } from "zustand";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { BlockFlowNode } from "./flow";
import { BlockIcon } from "./BlockIcon";
import { useDataflow } from "./store";
import { workflowProblems } from "./problems";
import { runStore } from "./run-session";
import { BLOCK_STATUS_LABELS } from "./run-view";

export const BoundaryNode = memo(function BoundaryNode({ data }: NodeProps<BlockFlowNode>) {
  const { block, ports } = data;
  const isInput = block.kind === "block_input";
  const root = useDataflow((state) => state.root);
  const problems = useMemo(
    () => workflowProblems(root).filter((problem) => problem.blockId === block.id),
    [root, block.id],
  );
  const status = useStore(
    runStore,
    (state) => state.run?.blockRuns.find((entry) => entry.blockId === block.id)?.status,
  );

  return (
    <div
      data-testid={`boundary-${isInput ? "input" : "output"}`}
      data-block-id={block.id}
      title={problems.map((problem) => problem.message).join("\n")}
      className={`flex items-center gap-2 rounded-full border-2 border-dashed ${problems.length ? "border-warn" : "border-line-strong"} bg-panel px-4 py-2 shadow-sm`}
    >
      {isInput && (
        <Handle
          type="source"
          position={Position.Right}
          id={ports.outputs[0]?.id || "out"}
          className="!size-2.5 !border-2 !border-line-strong !bg-panel"
        />
      )}
      {!isInput && (
        <Handle
          type="target"
          position={Position.Left}
          id={ports.inputs[0]?.id || "in"}
          className="!size-2.5 !border-2 !border-line-strong !bg-panel"
        />
      )}

      <BlockIcon kind={isInput ? "block_input" : "block_output"} className="size-5 text-muted" />
      <div className="flex flex-col">
        <span className="text-sm font-medium text-ink">{block.label}</span>
        <span className="text-xs text-muted">{isInput ? "From outside" : "To outside"}</span>
        {!!problems.length && (
          <span className="text-[10px] text-warn">Output needs a connection</span>
        )}
        {status && <span className="text-[10px] text-muted">{BLOCK_STATUS_LABELS[status]}</span>}
      </div>
    </div>
  );
});
