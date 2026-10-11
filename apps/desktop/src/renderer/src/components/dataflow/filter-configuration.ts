import { FILTER_PRESETS, isBoundaryBlockKind, type WorkflowBlock } from "@reqflow/core";

export type FilterPreset = "customer-facing" | "all-relevant" | "custom";

/** Called only by Apply preset; custom is deliberately a no-op. */
export function applyFilterPreset(
  params: WorkflowBlock["params"],
  preset: FilterPreset,
): WorkflowBlock["params"] {
  return preset === "custom" ? { ...params } : { ...params, ...FILTER_PRESETS[preset] };
}

export function filterBypassed(block: WorkflowBlock): boolean {
  return (
    !!block.inner &&
    (block.inner.edges.length > 0 ||
      block.inner.blocks.some((child) => !isBoundaryBlockKind(child.kind)))
  );
}
