import { BLOCK_SPECS, isBoundaryBlockKind, type BlockKind } from "@reqflow/core";

/** SVG fills follow the same live light/dark tokens as the block tiles. */
export function minimapColor(kind: BlockKind): string {
  return isBoundaryBlockKind(kind)
    ? "var(--color-muted)"
    : `var(--color-group-${BLOCK_SPECS[kind].group})`;
}
