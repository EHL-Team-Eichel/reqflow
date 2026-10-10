import type { WorkflowBlock } from "@reqflow/core";

/** Asks before deleting blocks (Settings → App → "Ask before deleting blocks"). */
export function confirmDelete(blocks: readonly WorkflowBlock[]): boolean {
  if (blocks.length === 0) return true;
  const what = blocks.length === 1 ? `“${blocks[0]!.label}”` : `${blocks.length} blocks`;
  const inside = blocks.some((b) =>
    b.inner?.blocks.some((x) => x.kind !== "block_input" && x.kind !== "block_output"),
  )
    ? " and everything inside their workplaces"
    : "";
  return window.confirm(`Delete ${what}? Their connections${inside} are deleted too.`);
}
