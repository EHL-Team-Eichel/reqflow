import {
  blockPorts,
  countPipelineData,
  emptyPipelineData,
  isBoundaryBlockKind,
  mergePipelineData,
  parseBlockParams,
  PipelineData,
  SplitterReport,
  validateGraph,
  walkBlocks,
  WorkflowRun,
  type BlockRun,
  type WorkflowBlock,
  type WorkflowGraph,
} from "@reqflow/core";
import type { BlockContext, BlockInputs, BlockResult } from "./block";
import type { BlockRegistry } from "./registry";

export type WorkflowOutputs = Record<string, Record<string, PipelineData>>;
export interface ExecuteWorkflowOptions {
  run: WorkflowRun;
  registry: BlockRegistry;
  context: (blockId: string) => BlockContext;
  /** Explicit run signal also supports cancellation of empty workplaces. */
  signal?: AbortSignal;
  /** Pass the same output map back on resume. New outputs are written before their status update. */
  outputs?: WorkflowOutputs;
  onUpdate: (run: WorkflowRun) => void | Promise<void>;
}
export interface ExecuteWorkflowResult {
  run: WorkflowRun;
  outputs: WorkflowOutputs;
}

const now = () => new Date().toISOString();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const terminal = new Set(["completed", "failed", "cancelled"]);

/** Boundaries alone are the default placeholder, not a user-authored subflow. */
export function usesInnerWorkplace(block: WorkflowBlock): boolean {
  return (
    !!block.inner &&
    (block.kind === "custom" ||
      block.inner.edges.length > 0 ||
      block.inner.blocks.some((child) => !isBoundaryBlockKind(child.kind)))
  );
}

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export function topologicalSortBlocks(graph: WorkflowGraph): WorkflowBlock[] {
  const blockMap = new Map<string, WorkflowBlock>(graph.blocks.map((b) => [b.id, b]));
  const inDegree = new Map<string, number>(graph.blocks.map((b) => [b.id, 0]));

  for (const edge of graph.edges) {
    if (inDegree.has(edge.target)) {
      inDegree.set(edge.target, inDegree.get(edge.target)! + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const sorted: WorkflowBlock[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const block = blockMap.get(id);
    if (block) sorted.push(block);

    for (const edge of graph.edges.filter((e) => e.source === id)) {
      if (inDegree.has(edge.target)) {
        const deg = inDegree.get(edge.target)! - 1;
        inDegree.set(edge.target, deg);
        if (deg === 0) queue.push(edge.target);
      }
    }
  }

  if (sorted.length < graph.blocks.length) {
    throw new EngineError("The blocks on this workplace form a loop");
  }

  return sorted;
}

export function collectAllBlocks(graph: WorkflowGraph): WorkflowBlock[] {
  const blocks: WorkflowBlock[] = [];
  function recurse(g: WorkflowGraph) {
    for (const b of g.blocks) {
      blocks.push(b);
      if (b.inner) recurse(b.inner);
    }
  }
  recurse(graph);
  return blocks;
}

export function getDownstreamBlockIds(graph: WorkflowGraph, failedBlockId: string): Set<string> {
  const downstream = new Set<string>();
  const adj = new Map<string, string[]>();

  for (const b of graph.blocks) adj.set(b.id, []);
  for (const e of graph.edges) adj.get(e.source)?.push(e.target);

  const queue = [failedBlockId];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    const neighbors = adj.get(curr) ?? [];
    for (const next of neighbors) {
      if (!downstream.has(next)) {
        downstream.add(next);
        queue.push(next);
      }
    }
  }

  return downstream;
}

/** Validate without stripping ResearchRecord provenance extensions from the shared envelope. */
export function validateOutputs(
  block: WorkflowBlock,
  outputs: unknown,
): asserts outputs is Record<string, PipelineData> {
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    throw new Error(`Block "${block.id}" returned invalid outputs`);
  }
  const expected = blockPorts(block).outputs.map((port) => port.id);
  const actual = Object.keys(outputs);
  const missing = expected.filter((port) => !actual.includes(port));
  const extra = actual.filter((port) => !expected.includes(port));
  if (missing.length || extra.length) {
    throw new Error(
      `Block "${block.id}" output ports mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
    );
  }
  for (const [port, envelope] of Object.entries(outputs)) {
    const parsed = PipelineData.safeParse(envelope);
    if (!parsed.success)
      throw new Error(`Block "${block.id}" output "${port}" is invalid: ${parsed.error.message}`);
  }
}

/** Stop waiting even if an implementation ignores cancellation. Its late results are never published. */
async function cancellable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("Run cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work();
      }),
      stopped,
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Validate stored state without parsing away provenance from output envelopes. */
export function prepareWorkflowRun(initial: WorkflowRun, outputs: WorkflowOutputs): WorkflowRun {
  const issues = validateGraph(initial.graph);
  if (issues.length) {
    throw new Error(
      `Invalid workflow graph: ${issues.map((issue) => `${issue.blockId ?? issue.edgeId ?? issue.path.join("/")}: ${issue.message}`).join("; ")}`,
    );
  }
  const run = WorkflowRun.parse(structuredClone(initial));
  const allBlocks = [...walkBlocks(run.graph)].map(({ block }) => block);
  const states = new Map(run.blockRuns.map((state) => [state.blockId, state]));
  if (
    states.size !== run.blockRuns.length ||
    run.blockRuns.some((state) => !allBlocks.some((block) => block.id === state.blockId))
  ) {
    throw new Error("Run contains duplicate or unknown block states");
  }
  for (const block of allBlocks) {
    if (!states.has(block.id))
      states.set(block.id, { blockId: block.id, status: "pending", counts: {}, logs: [] });
    if (states.get(block.id)!.status === "succeeded") {
      if (!Object.hasOwn(outputs, block.id))
        throw new Error(`Cannot continue block "${block.id}" without stored outputs`);
      validateOutputs(block, outputs[block.id]);
    } else {
      // Failed or paused blocks must not accidentally route stale data from an earlier attempt.
      delete outputs[block.id];
    }
  }
  run.blockRuns = allBlocks.map((block) => states.get(block.id)!);
  return run;
}

/**
 * One executor for root and nested workplaces. Persistence, audit events, human decisions, and
 * ResearchCollector construction remain in main. Independent branches retain their successful data.
 */
export async function executeWorkflow(
  options: ExecuteWorkflowOptions,
): Promise<ExecuteWorkflowResult> {
  if (terminal.has(options.run.status))
    throw new Error(`Cannot execute a ${options.run.status} run`);
  const outputs = options.outputs ?? {};
  const run = prepareWorkflowRun(options.run, outputs);
  const allBlocks = collectAllBlocks(run.graph);
  const states = new Map(run.blockRuns.map((state) => [state.blockId, state]));
  const contexts = new Map<string, BlockContext>();
  const getContext = (id: string) => {
    let ctx = contexts.get(id);
    if (!ctx) {
      ctx = options.context(id);
      contexts.set(id, ctx);
    }
    return ctx;
  };
  // Main supplies one shared run AbortSignal. The first block also observes pre-start cancellation.
  const signal =
    options.signal ?? (allBlocks.length ? getContext(allBlocks[0]!.id).signal : undefined);
  let cancelled = signal?.aborted ?? false;
  let updates = Promise.resolve();
  let updateFailed = false;
  let updateError: unknown;
  const publish = () => {
    const snapshot = structuredClone(run);
    updates = updates
      .then(async () => {
        if (!updateFailed) await options.onUpdate(snapshot);
      })
      .catch((error: unknown) => {
        updateFailed = true;
        updateError = error;
      });
  };
  const flush = async () => {
    await updates;
    if (updateFailed) throw updateError;
  };
  const log = (state: BlockRun, text: string) => state.logs.push({ at: now(), message: text });
  const skip = (block: WorkflowBlock, reason: string) => {
    const state = states.get(block.id)!;
    if (state.status === "succeeded" || state.status === "failed" || state.status === "skipped")
      return;
    state.status = "skipped";
    state.finishedAt = now();
    log(state, reason);
    if (block.inner) for (const child of block.inner.blocks) skip(child, reason);
    publish();
  };
  const inputsFor = (graph: WorkflowGraph, block: WorkflowBlock): BlockInputs =>
    Object.fromEntries(
      blockPorts(block).inputs.map((port) => [
        port.id,
        structuredClone(
          mergePipelineData(
            ...graph.edges
              .filter((edge) => edge.target === block.id && edge.targetPort === port.id)
              .map((edge) => {
                const data = outputs[edge.source]?.[edge.sourcePort];
                if (!data)
                  throw new Error(`Stored output "${edge.source}.${edge.sourcePort}" is missing`);
                return data;
              }),
          ),
        ),
      ]),
    );

  type Outcome = "ok" | "failed" | "paused" | "cancelled";
  async function workplace(graph: WorkflowGraph, parentInputs: BlockInputs = {}): Promise<Outcome> {
    for (const block of topologicalSortBlocks(graph)) {
      if (cancelled || signal?.aborted) {
        cancelled = true;
        break;
      }
      const state = states.get(block.id)!;
      if (state.status === "succeeded" || state.status === "failed" || state.status === "skipped")
        continue;
      const upstream = graph.edges
        .filter((edge) => edge.target === block.id)
        .map((edge) => states.get(edge.source)!);
      if (upstream.some((source) => source.status === "failed" || source.status === "skipped")) {
        skip(block, "Skipped because an upstream block failed or was skipped");
        await flush();
        continue;
      }
      if (upstream.some((source) => source.status !== "succeeded")) continue;
      const resumed = state.status === "waiting_for_review" && block.kind === "hil";
      state.status = "running";
      state.startedAt ??= now();
      delete state.finishedAt;
      delete state.error;
      state.progress = 0;
      // Empty Research/AI Filter workplaces are placeholders; their boundaries are not executed.
      if (block.inner && !usesInnerWorkplace(block)) {
        for (const child of block.inner.blocks)
          skip(child, "Inner workplace unused; built-in implementation selected");
      }
      publish();
      await flush();
      let active = true;
      try {
        const inputs = inputsFor(graph, block);
        let result: BlockResult;
        if (block.kind === "block_input") {
          result = {
            status: "ok",
            outputs: { out: parentInputs[String(block.params.port)] ?? emptyPipelineData() },
          };
        } else if (block.kind === "block_output") {
          result = { status: "ok", outputs: {} };
        } else if (usesInnerWorkplace(block)) {
          const outcome = await workplace(block.inner!, inputs);
          if (outcome === "cancelled") {
            cancelled = true;
            break;
          }
          if (outcome === "failed") throw new Error(`Inner workplace of "${block.id}" failed`);
          if (outcome === "paused") {
            state.status = "waiting_for_review";
            log(state, "Waiting for human review in inner workplace");
            publish();
            await flush();
            continue;
          }
          const routed = Object.fromEntries(
            block
              .inner!.blocks.filter((child) => child.kind === "block_output")
              .map((child) => [String(child.params.port), inputsFor(block.inner!, child).in!]),
          );
          result = { status: "ok", outputs: routed };
        } else {
          const base = getContext(block.id);
          const ctx: BlockContext = {
            ...base,
            resumed,
            log(text) {
              if (!active || cancelled || base.signal.aborted) return;
              log(state, text);
              base.log(text);
              publish();
            },
            progress(fraction, text) {
              if (!active || cancelled || base.signal.aborted) return;
              if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
                throw new Error("Block progress must be between 0 and 1");
              state.progress = fraction;
              if (text !== undefined) log(state, text);
              base.progress(fraction, text);
              publish();
            },
          };
          result = await cancellable(
            () =>
              options.registry
                .get(block.kind as Exclude<WorkflowBlock["kind"], "block_input" | "block_output">)
                .run(inputs, parseBlockParams(block.kind, block.params), ctx),
            base.signal,
          );
        }
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        if (result.status === "paused") {
          if (block.kind !== "hil")
            throw new Error("Only HIL implementations may pause for review");
          if (typeof result.message !== "string")
            throw new Error("HIL pause must include a review message");
          state.status = "waiting_for_review";
          log(state, result.message);
        } else {
          if (result.status !== "ok")
            throw new Error(`Block "${block.id}" returned an unknown result status`);
          validateOutputs(block, result.outputs);
          outputs[block.id] = structuredClone(result.outputs);
          state.counts = countPipelineData(mergePipelineData(...Object.values(result.outputs)));
          if (result.splitterReport) {
            const report = SplitterReport.parse(result.splitterReport);
            if (
              block.kind !== "ai_splitter" ||
              report.runId !== run.id ||
              report.blockId !== block.id
            )
              throw new EngineError("Analytical report does not match the executing block/run.");
            state.splitterReport = report;
          }
          state.status = "succeeded";
          state.progress = 1;
          state.finishedAt = now();
        }
      } catch (error) {
        if (signal?.aborted || contexts.get(block.id)?.signal.aborted) {
          cancelled = true;
          break;
        }
        // Subscriber failures are infrastructure failures, not block implementation failures.
        if (updateFailed) throw updateError;
        state.status = "failed";
        state.error = message(error);
        state.finishedAt = now();
        delete outputs[block.id];
        log(state, state.error);
      } finally {
        active = false;
      }
      publish();
      await flush();
    }
    if (cancelled || signal?.aborted) {
      cancelled = true;
      return "cancelled";
    }
    const statuses = graph.blocks.map((block) => states.get(block.id)!.status);
    // A failed independent branch does not prevent another branch from reaching human review.
    if (statuses.some((status) => status === "waiting_for_review" || status === "pending"))
      return "paused";
    return statuses.some((status) => status === "failed" || status === "skipped") ? "failed" : "ok";
  }

  const cancelRun = () => {
    cancelled = true;
    run.status = "cancelled";
    run.finishedAt = now();
    for (const block of allBlocks) skip(block, "Run cancelled");
  };
  run.status = signal?.aborted ? "cancelled" : "running";
  delete run.finishedAt;
  delete run.error;
  publish();
  await flush();
  const outcome = await workplace(run.graph);
  if (outcome === "cancelled") {
    cancelRun();
  } else {
    run.status =
      outcome === "paused" ? "waiting_for_review" : outcome === "failed" ? "failed" : "completed";
  }
  const failures = run.blockRuns.filter((state) => state.status === "failed");
  if (failures.length)
    run.error = failures.map((state) => `${state.blockId}: ${state.error}`).join("; ");
  if (run.status !== "waiting_for_review") run.finishedAt = now();
  publish();
  await flush();
  // Cancellation during the last awaited persistence callback must not resurrect completion/review.
  if (signal?.aborted && run.status !== "cancelled") {
    cancelRun();
    publish();
    await flush();
  }
  return { run, outputs };
}
