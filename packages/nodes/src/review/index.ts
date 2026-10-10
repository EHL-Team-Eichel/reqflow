import type { NodeDefinition } from "@reqflow/engine";
import { pmGateNode } from "./pm-gate";

export * from "./pm-gate";

export const reviewNodes: NodeDefinition[] = [pmGateNode];
