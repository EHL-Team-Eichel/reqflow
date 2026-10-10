import type {
  AuditLogger,
  DataKey,
  FileStore,
  LlmClient,
  NodeCategory,
  PipelineData,
  ProductScope,
  Settings,
  WebSearch,
} from "@reqflow/core";
import type { z } from "zod";

/** Everything a node may touch while running. Nodes must not import DB/env/server code. */
export interface NodeContext {
  runId: string;
  nodeId: string;
  scope: ProductScope;
  settings: Settings; // snapshot taken when the run started
  llm: LlmClient;
  audit: AuditLogger; // record what the node created/changed, with actor { type: "ai", component: <node type> }
  files: FileStore;
  web: WebSearch | null; // null when Settings.research.provider === "off"
  log(message: string): void; // shown in the run panel of the editor
  progress(fraction: number, message?: string): void; // 0–1
  signal: AbortSignal; // run cancelled → stop promptly
  resumed: boolean; // true when a review node is re-entered after the PM resumed the run
}

export type NodeResult =
  | { status: "ok"; data: PipelineData }
  /** Only review.* nodes pause. The engine marks the run `waiting_for_review` and re-invokes the node on resume. */
  | { status: "paused"; message: string };

export interface NodeDefinition<C extends z.ZodType = z.ZodType> {
  type: string; // unique, stable registry key: "<category>.<name>", e.g. "analysis.extract_signals"
  label: string; // palette / canvas title
  description: string; // one or two sentences for the palette tooltip
  category: NodeCategory;
  consumes: DataKey[]; // editor warns if no upstream node produces these
  produces: DataKey[];
  configSchema: C; // drives the config form (served as JSON Schema by api.nodes.catalog())
  /** Must be deterministic given (input, config, LLM output) and must throw on bad input — no silent skips. */
  run(input: PipelineData, config: z.infer<C>, ctx: NodeContext): Promise<NodeResult>;
}

/** Identity helper that keeps `config` typed from `configSchema`. */
export function defineNode<C extends z.ZodType>(def: NodeDefinition<C>): NodeDefinition<C> {
  return def;
}
