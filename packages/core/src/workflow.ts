import { z } from "zod";
import { Actor } from "./audit";
import { DataKey } from "./pipeline";
import { ProductScope } from "./scope";

/** Palette groups in the editor; mirror the BMW process columns. */
export const NodeCategory = z.enum([
  "source", // situation analysis: BMW data + web
  "analysis", // structure & context: extract, filter, cluster
  "requirements", // requirements definition: derive, specify targets
  "prioritization",
  "review", // human-in-the-loop gates
  "output", // documentation / publish / export
]);
export type NodeCategory = z.infer<typeof NodeCategory>;

export const WorkflowNode = z.object({
  id: z.string().min(1), // unique within the workflow, e.g. "extract-1"
  type: z.string().regex(/^[a-z]+\.[a-z_]+$/), // registry key, e.g. "analysis.extract_signals"
  label: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.unknown()), // validated against the node's configSchema at run time
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

/** Nodes have exactly one input and one output port, so an edge is just source → target. */
export const WorkflowEdge = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

export const WorkflowGraph = z.object({
  nodes: z.array(WorkflowNode),
  edges: z.array(WorkflowEdge),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraph>;

export const Workflow = WorkflowGraph.extend({
  id: z.string().startsWith("wf_"),
  name: z.string().min(1),
  description: z.string().optional(),
  scope: ProductScope,
  version: z.number().int().positive(), // +1 on every save
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Workflow = z.infer<typeof Workflow>;

export const RunStatus = z.enum([
  "queued",
  "running",
  "waiting_for_review", // paused at a review.* node until the PM resumes
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const NodeRunStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped", // an upstream node failed
  "waiting_for_review",
]);
export type NodeRunStatus = z.infer<typeof NodeRunStatus>;

export const NodeRunLog = z.object({ at: z.iso.datetime(), message: z.string() });
export type NodeRunLog = z.infer<typeof NodeRunLog>;

/** Status shown on each canvas node. Full node output is stored separately (see ARCHITECTURE.md). */
export const NodeRun = z.object({
  nodeId: z.string().min(1),
  status: NodeRunStatus,
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  progress: z.number().min(0).max(1).optional(),
  counts: z.partialRecord(DataKey, z.number().int().nonnegative()), // output size per data key
  logs: z.array(NodeRunLog),
  error: z.string().optional(),
});
export type NodeRun = z.infer<typeof NodeRun>;

export const WorkflowRun = z.object({
  id: z.string().startsWith("run_"),
  workflowId: z.string().startsWith("wf_"),
  workflowVersion: z.number().int().positive(),
  graph: WorkflowGraph, // snapshot, so a run stays reproducible after the workflow is edited
  scope: ProductScope,
  status: RunStatus,
  startedBy: Actor,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  nodeRuns: z.array(NodeRun),
  error: z.string().optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;
