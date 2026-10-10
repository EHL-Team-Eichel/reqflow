import type { WorkflowGraph } from "@reqflow/core";
import { NODE_TYPES } from "../types";

export interface WorkflowTemplate {
  name: string;
  description: string;
  graph: WorkflowGraph;
}

const COL = 300; // horizontal spacing on the canvas
const ROW = 140;

/**
 * The end-to-end pipeline we demo, laid out like the BMW process slide:
 * situation analysis → structure & context → requirements definition → prioritization → review → documentation.
 * Node configs only pre-fill what distinguishes the nodes; owners extend them when they define configSchema.
 */
export const BMW_DEFAULT_TEMPLATE: WorkflowTemplate = {
  name: "BMW successor requirements — default pipeline",
  description:
    "Ingest BMW data + web research, extract evidence-linked findings, derive and prioritize requirements, then pause for PM review before publishing.",
  graph: {
    nodes: [
      {
        id: "feedback",
        type: NODE_TYPES.bmwDataset,
        label: "Customer feedback",
        position: { x: 0, y: 0 },
        config: { datasetKind: "customer_feedback" },
      },
      {
        id: "study",
        type: NODE_TYPES.bmwDataset,
        label: "Customer study",
        position: { x: 0, y: ROW },
        config: { datasetKind: "customer_study" },
      },
      {
        id: "equipment",
        type: NODE_TYPES.bmwDataset,
        label: "Equipment data",
        position: { x: 0, y: ROW * 2 },
        config: { datasetKind: "equipment_data" },
      },
      {
        id: "sales",
        type: NODE_TYPES.bmwDataset,
        label: "Sales volumes",
        position: { x: 0, y: ROW * 3 },
        config: { datasetKind: "sales_volume" },
      },
      {
        id: "web",
        type: NODE_TYPES.webResearch,
        label: "Web research",
        position: { x: 0, y: ROW * 4 },
        config: {},
      },
      {
        id: "extract",
        type: NODE_TYPES.extractSignals,
        position: { x: COL, y: ROW * 2 },
        config: {},
      },
      {
        id: "scope",
        type: NODE_TYPES.scopeFilter,
        position: { x: COL * 2, y: ROW * 2 },
        config: {},
      },
      {
        id: "cluster",
        type: NODE_TYPES.clusterThemes,
        position: { x: COL * 3, y: ROW * 2 },
        config: {},
      },
      {
        id: "derive",
        type: NODE_TYPES.deriveRequirements,
        position: { x: COL * 4, y: ROW * 2 },
        config: {},
      },
      {
        id: "specify",
        type: NODE_TYPES.specifyTargets,
        position: { x: COL * 5, y: ROW * 2 },
        config: {},
      },
      {
        id: "score",
        type: NODE_TYPES.score,
        position: { x: COL * 6, y: ROW * 2 },
        config: {},
      },
      {
        id: "review",
        type: NODE_TYPES.pmGate,
        label: "PM review",
        position: { x: COL * 7, y: ROW * 2 },
        config: {},
      },
      {
        id: "publish",
        type: NODE_TYPES.publish,
        position: { x: COL * 8, y: ROW * 2 },
        config: {},
      },
    ],
    edges: [
      { id: "e-feedback-extract", source: "feedback", target: "extract" },
      { id: "e-study-extract", source: "study", target: "extract" },
      { id: "e-equipment-extract", source: "equipment", target: "extract" },
      { id: "e-sales-extract", source: "sales", target: "extract" },
      { id: "e-web-extract", source: "web", target: "extract" },
      { id: "e-extract-scope", source: "extract", target: "scope" },
      { id: "e-scope-cluster", source: "scope", target: "cluster" },
      { id: "e-cluster-derive", source: "cluster", target: "derive" },
      { id: "e-derive-specify", source: "derive", target: "specify" },
      { id: "e-specify-score", source: "specify", target: "score" },
      { id: "e-score-review", source: "score", target: "review" },
      { id: "e-review-publish", source: "review", target: "publish" },
    ],
  },
};
