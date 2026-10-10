import { isPaletteBlockKind, PALETTE_BLOCK_KINDS, type PaletteBlockKind } from "@reqflow/core";
import type { BlockImplementation } from "./block";

/**
 * Block kinds that never need an implementation: a custom block only runs its inner workplace.
 * (Specs, ports and params of every kind live in `@reqflow/core` → BLOCK_SPECS.)
 */
export const SUBFLOW_ONLY_KINDS: readonly PaletteBlockKind[] = ["custom"];

export class BlockRegistry {
  private readonly impls = new Map<PaletteBlockKind, BlockImplementation>();

  constructor(impls: readonly BlockImplementation[] = []) {
    for (const impl of impls) this.register(impl);
  }

  register(impl: BlockImplementation): void {
    if (!isPaletteBlockKind(impl.kind)) throw new Error(`Unknown block kind "${impl.kind}"`);
    if (SUBFLOW_ONLY_KINDS.includes(impl.kind)) {
      throw new Error(`"${impl.kind}" blocks only run their inner workplace`);
    }
    if (this.impls.has(impl.kind)) {
      throw new Error(`Block kind "${impl.kind}" is already registered`);
    }
    this.impls.set(impl.kind, impl);
  }

  get(kind: PaletteBlockKind): BlockImplementation {
    const impl = this.impls.get(kind);
    if (!impl) throw new Error(`Block kind "${kind}" has no implementation yet`);
    return impl;
  }

  has(kind: PaletteBlockKind): boolean {
    return this.impls.has(kind);
  }

  /** Kinds that still need an implementation, for status reporting. */
  missing(): PaletteBlockKind[] {
    return PALETTE_BLOCK_KINDS.filter((k) => !SUBFLOW_ONLY_KINDS.includes(k) && !this.has(k));
  }
}
