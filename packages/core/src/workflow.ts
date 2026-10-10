import { z } from "zod";
import { Actor } from "./audit";
import { BlockKind } from "./blocks";
import { DataKey } from "./pipeline";
import { ProductScope } from "./scope";

/**
 * A block placed on a workplace. `id` is unique across the whole workflow, inner workplaces
 * included, so run status and outputs can be keyed by id alone.
 */
export interface WorkflowBlock {
  id: string;
  kind: BlockKind;
  label: string;
  position: { x: number; y: number };
  params: Record<string, unknown>; // validated per kind: parseBlockParams (blocks.ts)
  /** The block's own workplace. Present exactly when the kind has one (BLOCK_SPECS.hasInnerWorkplace). */
  inner?: WorkflowGraph;
}

/** Connects an output port of one block to an input port of another, on the same workplace. */
export const WorkflowEdge = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourcePort: z.string().min(1),
  target: z.string().min(1),
  targetPort: z.string().min(1),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

/** One workplace: the top level of a workflow, or the inside of an expandable block. */
export interface WorkflowGraph {
  blocks: WorkflowBlock[];
  edges: WorkflowEdge[];
}

export const BlockId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);

export const WorkflowBlock: z.ZodType<WorkflowBlock> = z.object({
  id: BlockId,
  kind: BlockKind,
  label: z.string().trim().min(1).max(80),
  position: z.object({ x: z.number(), y: z.number() }),
  params: z.record(z.string(), z.unknown()),
  get inner() {
    return WorkflowGraph.optional();
  },
});

/** Shape only. `validateGraph` (graph.ts) checks ports, params, cycles and unique ids. */
export const WorkflowGraph = z.object({
  blocks: z.array(WorkflowBlock),
  edges: z.array(WorkflowEdge),
});

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
  "waiting_for_review", // paused at a HIL block until a person has reviewed
  "completed",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const BlockRunStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped", // an upstream block failed
  "waiting_for_review",
]);
export type BlockRunStatus = z.infer<typeof BlockRunStatus>;

export const BlockRunLog = z.object({ at: z.iso.datetime(), message: z.string() });
export type BlockRunLog = z.infer<typeof BlockRunLog>;

/** Status shown on each block. Full block output is stored separately (see ARCHITECTURE.md). */
export const BlockRun = z.object({
  blockId: BlockId, // ids are unique across inner workplaces too
  status: BlockRunStatus,
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  progress: z.number().min(0).max(1).optional(),
  counts: z.partialRecord(DataKey, z.number().int().nonnegative()), // output size per data key
  logs: z.array(BlockRunLog),
  error: z.string().optional(),
});
export type BlockRun = z.infer<typeof BlockRun>;

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
  blockRuns: z.array(BlockRun),
  error: z.string().optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRun>;

/** A ready-made workflow the editor can instantiate ("New from template"). */
export interface WorkflowTemplate {
  name: string;
  description: string;
  graph: WorkflowGraph;
}
