// @reqflow/blocks — implementations of the building blocks, one folder per block.
// Specs, ports and params of every block live in @reqflow/core (BLOCK_SPECS).
import { BlockRegistry, type BlockImplementation } from "@reqflow/engine";
import { addToCarImplementations } from "./add-to-car";
import { aiFilterImplementations } from "./ai-filter";
import { aiSplitterImplementations } from "./ai-splitter";
import { hilImplementations } from "./hil";
import { rawImplementations } from "./raw";
import { researchImplementations } from "./research";

export const allBlockImplementations: readonly BlockImplementation[] = [
  ...rawImplementations,
  ...researchImplementations,
  ...aiFilterImplementations,
  ...aiSplitterImplementations,
  ...hilImplementations,
  ...addToCarImplementations,
];

export function createBlockRegistry(): BlockRegistry {
  return new BlockRegistry(allBlockImplementations);
}

export { BMW_DEFAULT_TEMPLATE } from "./templates/bmw-default";
