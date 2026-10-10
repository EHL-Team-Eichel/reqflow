import type { RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  PALETTE_BLOCK_KINDS,
  BLOCK_SPECS,
  defaultBlockParams,
  type PaletteBlockKind,
} from "@reqflow/core";
import { BlockIcon } from "./BlockIcon";
import { GROUP_STYLE } from "./groups";
import { findFreePosition } from "./layout";
import { dataflowStore, selectWorkplace } from "./store";
import { cx } from "@/lib/cx";

export function BlockPalette({ canvasRef }: { canvasRef: RefObject<HTMLDivElement | null> }) {
  const { screenToFlowPosition } = useReactFlow();
  // Click to add: the free spot nearest to the centre of the visible workplace.
  const handleAdd = (kind: PaletteBlockKind) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const center = screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    const state = dataflowStore.getState();
    state.addBlock(kind, findFreePosition(selectWorkplace(state), state.measured, center));
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {PALETTE_BLOCK_KINDS.map((kind) => {
          const spec = BLOCK_SPECS[kind];
          const style = GROUP_STYLE[spec.group];
          const params = defaultBlockParams(kind);
          const ports = spec.ports(params);

          const inCount = ports.inputs.length;
          const outCount = ports.outputs.length;

          const inStr = inCount === 0 ? "no input" : `${inCount} in`;
          const outStr = outCount === 0 ? "no output" : `${outCount} out`;
          const portSummary = `${inStr} · ${outStr}`;

          return (
            <button
              key={kind}
              draggable
              data-testid={`palette-item-${kind}`}
              className="flex w-full cursor-grab items-start gap-3 rounded-lg border border-transparent p-3 text-left transition-colors hover:bg-panel-2 active:cursor-grabbing"
              onDragStart={(e) => {
                e.dataTransfer.setData("application/reqflow-block", kind);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => handleAdd(kind)}
            >
              <div
                className={cx(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg mt-0.5",
                  style.tile,
                )}
              >
                <BlockIcon kind={kind} className="size-5" />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-ink">{spec.label}</span>
                <span className="line-clamp-2 text-xs text-muted mt-0.5">{spec.description}</span>
                <div className="mt-1.5 flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted">
                  {spec.hasInnerWorkplace && <span>Workplace inside</span>}
                  {spec.hasInnerWorkplace && <span>·</span>}
                  <span>{portSummary}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="border-t border-line p-3 text-center text-xs text-muted">
        Drag onto the workplace or click to add.
      </div>
    </div>
  );
}
