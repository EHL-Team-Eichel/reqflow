import type {
  AuditLogger,
  BlockParams,
  FileStore,
  LlmClient,
  PaletteBlockKind,
  PipelineData,
  ProductScope,
  Requirement,
  Settings,
  WebSearch,
  ResearchCollector,
} from "@reqflow/core";

/** Evidence behind requirements, stored with them so the Car page can show it. */
export type CarEvidence = Partial<
  Pick<PipelineData, "sources" | "records" | "findings" | "themes">
>;

/** Where Add to Car hands its requirements (WS1 wires this to the database). */
export interface CarService {
  add(requirements: Requirement[], evidence?: CarEvidence): Promise<void>;
  /** Next unused requirement number for the scope (ids are never reused). Absent = start at 1. */
  nextSeq?(scope: ProductScope): Promise<number>;
}

/** Everything a block may touch while running. Blocks must not import DB, env or Electron code. */
export interface BlockContext {
  runId: string;
  blockId: string;
  scope: ProductScope; // the run's scope; params set to "From Settings" resolve to it
  settings: Settings; // snapshot taken when the run started
  llm: LlmClient;
  audit: AuditLogger; // record what the block created or changed, actor { type: "ai", component: <kind> }
  files: FileStore;
  web: WebSearch | null; // null when Settings.research.provider === "off"
  /** Requirements handed to the Car page (Add to Car). WS1 wires this to the database. */
  car: CarService;
  log(message: string): void; // shown on the block in the editor
  progress(fraction: number, message?: string): void; // 0–1
  signal: AbortSignal; // run cancelled → stop promptly
  resumed: boolean; // true when a HIL block is re-entered after the reviewer finished
  research?: ResearchCollector; // Raw-only research service wired in Electron main.
}

/** What arrived, per input port id. Several edges into one port are merged with `mergePipelineData`. */
export type BlockInputs = Record<string, PipelineData>;

export type BlockResult =
  /** Exactly one entry per output port id (`blockPorts(block).outputs`). Sinks return `{}`. */
  | { status: "ok"; outputs: Record<string, PipelineData> }
  /** Only HIL pauses. The engine marks the run `waiting_for_review` and re-runs the block on resume. */
  | { status: "paused"; message: string };

export interface BlockImplementation<K extends PaletteBlockKind = PaletteBlockKind> {
  kind: K;
  /**
   * `params` are already validated with `parseBlockParams(kind, …)`. Must be deterministic given
   * (inputs, params, LLM output) and must throw on bad input: no silent skips.
   */
  run(inputs: BlockInputs, params: BlockParams, ctx: BlockContext): Promise<BlockResult>;
}

/** Identity helper that keeps `kind` literal. */
export function defineBlock<K extends PaletteBlockKind>(
  impl: BlockImplementation<K>,
): BlockImplementation<K> {
  return impl;
}
