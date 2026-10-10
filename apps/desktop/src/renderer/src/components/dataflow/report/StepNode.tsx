import { memo } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import {
  type LineageStep,
  isPaletteBlockKind,
  BLOCK_SPECS,
  isBoundaryBlockKind,
} from "@reqflow/core";
import { BlockIcon } from "../BlockIcon";
import { GROUP_STYLE } from "../groups";
import { TableIcon, ExpandIcon } from "@/components/ui/icons";
import { useSettings } from "@/lib/settings";
import { cx } from "@/lib/cx";
import { summarizeParams } from "../summary";

export type StepNodeData = {
  step: LineageStep;
  isTarget: boolean;
  isSelected: boolean;
  workplaceLabel?: string;
  onShowData: (id: string) => void;
  onReveal: (step: LineageStep) => void;
};

export const StepNode = memo(function StepNode({ data }: NodeProps<Node<StepNodeData>>) {
  const { step, isTarget, isSelected, workplaceLabel, onShowData, onReveal } = data;
  const scope = useSettings((s) => s.settings.defaultScope);

  const spec = isPaletteBlockKind(step.block.kind) ? BLOCK_SPECS[step.block.kind] : undefined;
  const style = spec ? GROUP_STYLE[spec.group] : undefined;

  const tileClass = style ? style.tile : "bg-panel-2 text-muted";

  let subtitle = "";
  if (spec && style) {
    subtitle = step.block.label !== spec.label ? spec.label : style.name;
  } else if (step.block.kind === "block_input") {
    subtitle = `Into ${workplaceLabel || "workplace"}`;
  } else if (step.block.kind === "block_output") {
    subtitle = `Out of ${workplaceLabel || "workplace"}`;
  }

  const summaryLabels = spec ? summarizeParams(step.block, scope, spec.params) : [];

  return (
    <div
      data-testid="lineage-step"
      data-step-id={step.block.id}
      className={cx(
        "w-60 rounded-xl border bg-panel shadow-sm",
        isTarget
          ? "border-group-human ring-2 ring-group-human/30"
          : isSelected
            ? "border-brand ring-2 ring-brand/30"
            : "border-line",
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="!opacity-0" />

      {isTarget && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-group-human px-2 py-0.5 text-[10px] font-semibold text-white shadow-sm">
          Data at this point
        </div>
      )}

      <div className="p-3">
        <div className="flex items-start gap-3">
          <div
            className={cx("flex size-8 shrink-0 items-center justify-center rounded-lg", tileClass)}
          >
            <BlockIcon kind={step.block.kind} className="size-5" />
          </div>
          <div className="flex flex-col overflow-hidden">
            <span className="truncate text-sm font-medium text-ink" title={step.block.label}>
              {step.block.label}
            </span>
            <span className="truncate text-xs text-muted" title={subtitle}>
              {subtitle}
            </span>
          </div>
        </div>

        {workplaceLabel && !isBoundaryBlockKind(step.block.kind) && (
          <div className="mt-2 text-[10px] text-muted font-medium bg-panel-2 rounded px-1.5 py-0.5 inline-block">
            inside {workplaceLabel}
          </div>
        )}

        {summaryLabels.length > 0 && (
          <div className="mt-2 text-xs text-muted truncate">{summaryLabels.join(" · ")}</div>
        )}

        <div className="mt-3 flex gap-2">
          <button
            type="button"
            data-testid="step-data"
            className="nodrag flex flex-1 items-center justify-center gap-1.5 rounded bg-panel-2 py-1 text-xs font-medium text-ink hover:bg-line"
            aria-label={`See ${step.block.kind === "ai_splitter" ? "scores, routing and data" : "the data"} at ${step.block.label}`}
            onClick={(e) => {
              e.stopPropagation();
              onShowData(step.block.id);
            }}
          >
            <TableIcon className="size-4" />
            {step.block.kind === "ai_splitter" ? "Scores / data" : "Data"}
          </button>
          <button
            type="button"
            className="nodrag flex flex-1 items-center justify-center gap-1.5 rounded bg-panel-2 py-1 text-xs font-medium text-ink hover:bg-line"
            aria-label={`Show ${step.block.label} in workplace`}
            onClick={(e) => {
              e.stopPropagation();
              onReveal(step);
            }}
          >
            <ExpandIcon className="size-4" />
            Workplace
          </button>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="!opacity-0"
      />
    </div>
  );
});
