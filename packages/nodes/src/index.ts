// @reqflow/nodes — all workflow node implementations, grouped by owning workstream.
import { NodeRegistry, type NodeDefinition } from "@reqflow/engine";
import { analysisNodes } from "./analysis";
import { ingestNodes } from "./ingest";
import { outputNodes } from "./output";
import { prioritizationNodes } from "./prioritization";
import { requirementNodes } from "./requirements";
import { researchNodes } from "./research";
import { reviewNodes } from "./review";

export const allNodes: readonly NodeDefinition[] = [
  ...ingestNodes,
  ...researchNodes,
  ...analysisNodes,
  ...requirementNodes,
  ...prioritizationNodes,
  ...reviewNodes,
  ...outputNodes,
];

export function createNodeRegistry(): NodeRegistry {
  return new NodeRegistry(allNodes);
}

export { ALL_NODE_TYPES, NODE_TYPES, type NodeType } from "./types";
export { BMW_DEFAULT_TEMPLATE } from "./templates/bmw-default";
