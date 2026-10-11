import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { BlockFlowNode } from "./flow";
import { BlockIcon } from "./BlockIcon";
import { GROUP_STYLE } from "./groups";
import { dataflowStore } from "./store";
import {
  isBoundaryBlockKind,
  isPaletteBlockKind,
  MAX_ANALYTICS_INPUTS,
  type ParamSpec,
} from "@reqflow/core";
import { ChartIcon, ExpandIcon, PlusIcon, ReportIcon, ThoughtIcon } from "@/components/ui/icons";
import { useSettings } from "@/lib/settings";
import { cx } from "@/lib/cx";
import { summarizeParams } from "./summary";

export const BlockNode = memo(function BlockNode({ data, selected }: NodeProps<BlockFlowNode>) {
  const { block, ports, spec } = data;
  const scope = useSettings((s) => s.settings.defaultScope);

  if (!spec || !isPaletteBlockKind(block.kind)) return null; // boundary blocks use BoundaryNode

  const style = GROUP_STYLE[spec.group];
  const isRenamed = block.label !== spec.label;

  const innerBlocks = block.inner?.blocks.filter((b) => !isBoundaryBlockKind(b.kind)) ?? [];
  const innerCountText =
    innerBlocks.length === 0
      ? "Empty inside"
      : `${innerBlocks.length} block${innerBlocks.length === 1 ? "" : "s"} inside`;

  // One-line param summary: the current values of the first two select params.
  const summaryLabels = summarizeParams(block, scope, spec.params);

  const numRows = Math.max(ports.inputs.length, ports.outputs.length);

  return (
    <div
      data-testid={`block-${block.kind}`}
      data-block-id={block.id}
      className={cx(
        "w-56 rounded-xl border bg-panel shadow-sm transition-shadow",
        selected ? "border-brand ring-2 ring-brand/30" : "border-line",
      )}
    >
      <div className="flex items-start justify-between p-3 pb-2">
        <div className="flex items-center gap-3 overflow-hidden">
          <div
            className={cx(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              style.tile,
            )}
          >
            <BlockIcon kind={block.kind} className="size-5" />
          </div>
          <div className="flex flex-col overflow-hidden">
            <span className="truncate text-sm font-medium text-ink" title={block.label}>
              {block.label}
            </span>
            <span
              className="truncate text-xs text-muted"
              title={isRenamed ? spec.label : style.name}
            >
              {isRenamed ? spec.label : style.name}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {block.kind === "add_to_car" && (
            <button
              type="button"
              data-testid="block-reasoning"
              className="nodrag shrink-0 rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink"
              aria-label={`Open the thought process of ${block.label}`}
              onClick={(e) => {
                e.stopPropagation();
                dataflowStore.getState().openReasoning(block.id);
              }}
            >
              <ThoughtIcon className="size-4" />
            </button>
          )}

          {block.kind === "analytics" && (
            <button
              type="button"
              data-testid="analytics-open"
              className="nodrag shrink-0 rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink"
              aria-label={`Open the analytics of ${block.label} full screen`}
              title="Open analytics (full screen)"
              onClick={(e) => {
                e.stopPropagation();
                dataflowStore.getState().openAnalytics(block.id);
              }}
            >
              <ChartIcon className="size-4" />
            </button>
          )}

          {(block.kind === "hil" || block.kind === "ai_splitter") && (
            <button
              type="button"
              data-testid="block-report"
              className="nodrag shrink-0 rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink"
              aria-label={`Open the ${block.kind === "ai_splitter" ? "scores and routing" : "review"} report of ${block.label}`}
              onClick={(e) => {
                e.stopPropagation();
                dataflowStore.getState().openReport(block.id);
              }}
            >
              <ReportIcon className="size-4" />
            </button>
          )}

          {spec.hasInnerWorkplace && (
            <button
              type="button"
              data-testid="block-expand"
              className="nodrag shrink-0 rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink"
              aria-label={`Open the inside of ${block.label}`}
              onClick={(e) => {
                e.stopPropagation();
                dataflowStore.getState().openInner(block.id);
              }}
            >
              <ExpandIcon className="size-4" />
            </button>
          )}
        </div>
      </div>

      {(spec.hasInnerWorkplace || summaryLabels.length > 0) && (
        <div className="px-3 pb-2 text-xs text-muted">
          {spec.hasInnerWorkplace && <div>{innerCountText}</div>}
          {summaryLabels.length > 0 && <div className="truncate">{summaryLabels.join(" · ")}</div>}
        </div>
      )}

      {numRows > 0 && (
        <div className="flex flex-col py-2 border-t border-line">
          {Array.from({ length: numRows }).map((_, i) => {
            const input = ports.inputs[i];
            const output = ports.outputs[i];

            const isContext = input?.id.startsWith("ctx-");
            const isFirstContext = isContext && !ports.inputs[i - 1]?.id.startsWith("ctx-");

            return (
              <div key={i} className="flex flex-col">
                {isFirstContext && (
                  <div className="mt-2 mb-1 flex items-center gap-2 px-3">
                    <div className="h-px flex-1 bg-line" />
                    <span className="text-[10px] font-semibold tracking-wider text-muted uppercase">
                      Context
                    </span>
                    <div className="h-px flex-1 bg-line" />
                  </div>
                )}
                <div className="relative flex h-7 w-full items-center justify-between px-3 text-xs text-ink">
                  {input ? (
                    <>
                      <Handle
                        type="target"
                        position={Position.Left}
                        id={input.id}
                        className={cx(
                          "!size-2.5 !bg-panel",
                          isContext
                            ? "!border !border-dashed !border-muted !bg-panel-2"
                            : cx("!border-2", style.border),
                          "-ml-px",
                        )}
                      />
                      <span className="truncate pr-2">{input.label}</span>
                    </>
                  ) : (
                    <span />
                  )}

                  {output ? (
                    <>
                      <span className="truncate pl-2 text-right">{output.label}</span>
                      <Handle
                        type="source"
                        position={Position.Right}
                        id={output.id}
                        className={cx("!size-2.5 !border-2 !bg-panel", style.border, "-mr-px")}
                      />
                    </>
                  ) : (
                    <span />
                  )}
                </div>
              </div>
            );
          })}
          {block.kind === "analytics" && ports.inputs.length < MAX_ANALYTICS_INPUTS && (
            <button
              type="button"
              data-testid="analytics-add-input"
              className="nodrag mx-3 mt-1 flex h-6 items-center gap-1 rounded-md px-1 text-xs text-muted hover:bg-panel-2 hover:text-ink"
              aria-label={`Add an input to ${block.label}`}
              onClick={(e) => {
                e.stopPropagation();
                const error = dataflowStore.getState().addAnalyticsInput(block.id);
                if (error) dataflowStore.getState().notify("error", error);
              }}
            >
              <PlusIcon className="size-3.5" />
              Add input
            </button>
          )}
        </div>
      )}
    </div>
  );
});
