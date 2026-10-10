import {
  countPipelineData,
  emptyPipelineData,
  isBoundaryBlockKind,
  mergePipelineData,
  newId,
  parseBlockParams,
  validateGraph,
  withSplitterWorkplaces,
  WorkflowRun,
  type Actor,
  type AgentServices,
  type AuditLogger,
  type BlockParams,
  type BlockRun,
  type FileStore,
  type LlmClient,
  type PipelineData,
  type Requirement,
  type Settings,
  type WebSearch,
  type Workflow,
  type WorkflowBlock,
  type WorkflowGraph,
} from "@reqflow/core";
import type { BlockContext, CarService } from "./block";
import type { BlockRegistry } from "./registry";

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface BlockOutputStore {
  saveBlockOutput(
    runId: string,
    blockId: string,
    outputs: Record<string, PipelineData>,
  ): Promise<void>;
  getBlockOutput(runId: string, blockId: string): Promise<Record<string, PipelineData> | null>;
}

export interface WorkflowExecutorOptions {
  registry: BlockRegistry;
  services: {
    llm: LlmClient | ((settings: Settings) => Promise<LlmClient>);
    /** Absent: blocks that need agents (Add to Car) fail with a clear message. */
    agents?: AgentServices | ((settings: Settings) => AgentServices);
    audit: AuditLogger;
    files: FileStore;
    web: WebSearch | null;
    car: CarService;
  };
  outputStore?: BlockOutputStore;
  onUpdate?: (run: WorkflowRun) => void;
}

/** Stand-in when the app wires no agent services: every use fails with a readable error. */
export const NO_AGENT_SERVICES: AgentServices = {
  writer: async () => {
    throw new EngineError("AI agents aren't set up in this build, so Add to Car can't run.");
  },
  judge: async () => {
    throw new EngineError("AI agents aren't set up in this build, so Add to Car can't run.");
  },
};

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

/** Splitters keep editable boundaries even when the built-in AI implementation runs. */
function usesInnerWorkplace(block: WorkflowBlock): boolean {
  return (
    !!block.inner &&
    block.inner.blocks.length > 0 &&
    (block.kind !== "ai_splitter" ||
      block.inner.edges.length > 0 ||
      block.inner.blocks.some((b) => !isBoundaryBlockKind(b.kind)))
  );
}

function executableBlocks(graph: WorkflowGraph): WorkflowBlock[] {
  return graph.blocks.flatMap((block) => [
    block,
    ...(usesInnerWorkplace(block) ? executableBlocks(block.inner!) : []),
  ]);
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

export class WorkflowExecutor {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly memoryOutputs = new Map<string, Map<string, Record<string, PipelineData>>>();
  private readonly pausedRuns = new Map<
    string,
    {
      settings: Settings;
      pausedBlockId: string;
    }
  >();

  constructor(private readonly options: WorkflowExecutorOptions) {}

  private getRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (!run) throw new EngineError(`Run not found: ${runId}`);
    return run;
  }

  private emitUpdate(run: WorkflowRun): void {
    const clone = WorkflowRun.parse(JSON.parse(JSON.stringify(run)));
    this.runs.set(run.id, clone);
    this.options.onUpdate?.(clone);
  }

  private async recordAudit(
    action: "run.started" | "run.paused" | "run.resumed" | "run.completed" | "run.failed",
    run: WorkflowRun,
    rationale?: string,
  ): Promise<void> {
    try {
      await this.options.services.audit.record({
        actor: { type: "system", component: "engine" },
        action,
        entityType: "run",
        entityId: run.id,
        runId: run.id,
        rationale,
      });
    } catch {
      // audit errors must not crash execution
    }
  }

  private async saveOutput(
    runId: string,
    blockId: string,
    outputs: Record<string, PipelineData>,
  ): Promise<void> {
    let runMap = this.memoryOutputs.get(runId);
    if (!runMap) {
      runMap = new Map();
      this.memoryOutputs.set(runId, runMap);
    }
    runMap.set(blockId, outputs);

    if (this.options.outputStore) {
      await this.options.outputStore.saveBlockOutput(runId, blockId, outputs);
    }
  }

  async getBlockOutput(
    runId: string,
    blockId: string,
  ): Promise<Record<string, PipelineData> | null> {
    const runMap = this.memoryOutputs.get(runId);
    if (runMap?.has(blockId)) return runMap.get(blockId)!;
    if (this.options.outputStore) {
      return await this.options.outputStore.getBlockOutput(runId, blockId);
    }
    return null;
  }

  createInitialRun(workflow: Workflow, startedBy: Actor): WorkflowRun {
    workflow = withSplitterWorkplaces(workflow);
    const allBlocks = executableBlocks(workflow);
    const initialBlockRuns: BlockRun[] = allBlocks.map((b) => ({
      blockId: b.id,
      status: "pending",
      counts: {},
      logs: [],
    }));

    const run: WorkflowRun = {
      id: newId("run"),
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      graph: { blocks: workflow.blocks, edges: workflow.edges },
      scope: workflow.scope,
      status: "running",
      startedBy,
      startedAt: new Date().toISOString(),
      blockRuns: initialBlockRuns,
    };

    this.runs.set(run.id, run);
    return run;
  }

  validateBeforeRun(workflow: Workflow): void {
    workflow = withSplitterWorkplaces(workflow);
    const issues = validateGraph(workflow);
    if (issues.length > 0) {
      throw new EngineError(
        `Workflow validation failed: ${issues.map((i) => i.message).join("; ")}`,
        issues,
      );
    }

    const allBlocks = executableBlocks(workflow);
    for (const block of allBlocks) {
      if (block.kind === "custom") continue;
      if (isBoundaryBlockKind(block.kind)) continue;
      if (usesInnerWorkplace(block)) continue;
      if (!this.options.registry.has(block.kind)) {
        throw new EngineError(
          `Block "${block.label}" (${block.id}) has no implementation for kind "${block.kind}"`,
        );
      }
    }
  }

  async execute(workflow: Workflow, startedBy: Actor, settings: Settings): Promise<WorkflowRun> {
    this.validateBeforeRun(workflow);
    const run = this.createInitialRun(workflow, startedBy);
    const controller = new AbortController();
    this.activeControllers.set(run.id, controller);

    this.emitUpdate(run);
    await this.recordAudit("run.started", run);

    await this.executeWorkplace(run, run.graph, {}, settings, controller.signal, false);
    return this.getRun(run.id);
  }

  async start(workflow: Workflow, startedBy: Actor, settings: Settings): Promise<WorkflowRun> {
    this.validateBeforeRun(workflow);
    const run = this.createInitialRun(workflow, startedBy);
    const controller = new AbortController();
    this.activeControllers.set(run.id, controller);

    this.emitUpdate(run);
    await this.recordAudit("run.started", run);

    void this.executeWorkplace(run, run.graph, {}, settings, controller.signal, false).catch(
      (err) => {
        console.error(`[engine] run ${run.id} error:`, err);
      },
    );

    return run;
  }

  private async executeWorkplace(
    run: WorkflowRun,
    graph: WorkflowGraph,
    parentInputs: Record<string, PipelineData>,
    settings: Settings,
    signal: AbortSignal,
    resumedExecution: boolean,
  ): Promise<{ status: "ok"; outputs: Record<string, PipelineData> } | { status: "paused" }> {
    const sorted = topologicalSortBlocks(graph);

    for (let i = 0; i < sorted.length; i++) {
      if (signal.aborted) {
        run.status = "cancelled";
        run.finishedAt = new Date().toISOString();
        this.emitUpdate(run);
        return { status: "paused" };
      }

      const block = sorted[i]!;
      const blockRun = run.blockRuns.find((br) => br.blockId === block.id)!;

      if (resumedExecution && blockRun.status === "succeeded") {
        continue;
      }

      const incomingEdges = graph.edges.filter((e) => e.target === block.id);
      const parentRuns = incomingEdges.map((e) =>
        run.blockRuns.find((br) => br.blockId === e.source),
      );
      if (parentRuns.some((p) => p && (p.status === "failed" || p.status === "skipped"))) {
        blockRun.status = "skipped";
        this.emitUpdate(run);
        continue;
      }

      const blockInputs: Record<string, PipelineData> = {};

      if (block.kind === "block_input") {
        const portId = (block.params as { port?: string }).port ?? "in";
        const incomingData = parentInputs[portId] ?? emptyPipelineData();
        blockInputs.in = incomingData;
      } else {
        for (const edge of incomingEdges) {
          const sourceOutputs = (await this.getBlockOutput(run.id, edge.source)) ?? {};
          const carriedData = sourceOutputs[edge.sourcePort] ?? emptyPipelineData();
          if (!blockInputs[edge.targetPort]) {
            blockInputs[edge.targetPort] = carriedData;
          } else {
            blockInputs[edge.targetPort] = mergePipelineData(
              blockInputs[edge.targetPort]!,
              carriedData,
            );
          }
        }
      }

      const isResumingThisBlock = resumedExecution && blockRun.status === "waiting_for_review";

      blockRun.status = "running";
      blockRun.startedAt = blockRun.startedAt ?? new Date().toISOString();
      this.emitUpdate(run);

      const llmService = this.options.services.llm;
      const agentService = this.options.services.agents ?? NO_AGENT_SERVICES;
      const ctx: BlockContext = {
        runId: run.id,
        blockId: block.id,
        scope: run.scope,
        settings,
        llm:
          typeof llmService === "function"
            ? {
                generateObject: async (request) =>
                  (await llmService(settings)).generateObject(request),
                generateText: async (request) => (await llmService(settings)).generateText(request),
              }
            : llmService,
        agents: typeof agentService === "function" ? agentService(settings) : agentService,
        audit: this.options.services.audit,
        files: this.options.services.files,
        web: this.options.services.web,
        car: this.options.services.car,
        log: (msg) => {
          blockRun.logs.push({ at: new Date().toISOString(), message: msg });
          this.emitUpdate(run);
        },
        progress: (frac, msg) => {
          blockRun.progress = Math.max(0, Math.min(1, frac));
          if (msg) blockRun.logs.push({ at: new Date().toISOString(), message: msg });
          this.emitUpdate(run);
        },
        signal,
        resumed: isResumingThisBlock,
      };

      try {
        let blockOutputs: Record<string, PipelineData> = {};

        if (block.kind === "block_input") {
          blockOutputs = { out: blockInputs.in ?? emptyPipelineData() };
        } else if (block.kind === "block_output") {
          blockOutputs = { in: blockInputs.in ?? emptyPipelineData() };
        } else if (usesInnerWorkplace(block)) {
          const subflowRes = await this.executeWorkplace(
            run,
            block.inner!,
            blockInputs,
            settings,
            signal,
            resumedExecution,
          );
          if (subflowRes.status === "paused") {
            return { status: "paused" };
          }
          blockOutputs = subflowRes.outputs;
        } else {
          const impl = this.options.registry.get(block.kind);
          const validatedParams = parseBlockParams(block.kind, block.params);
          const result = await impl.run(blockInputs, validatedParams as BlockParams, ctx);

          if (signal.aborted) {
            run.status = "cancelled";
            run.finishedAt = new Date().toISOString();
            this.emitUpdate(run);
            return { status: "paused" };
          }

          if (result.status === "paused") {
            blockRun.status = "waiting_for_review";
            blockRun.logs.push({ at: new Date().toISOString(), message: result.message });
            run.status = "waiting_for_review";
            this.pausedRuns.set(run.id, { settings, pausedBlockId: block.id });
            this.emitUpdate(run);
            await this.recordAudit("run.paused", run, result.message);
            return { status: "paused" };
          }

          blockOutputs = result.outputs;
        }

        blockRun.status = "succeeded";
        blockRun.finishedAt = new Date().toISOString();
        blockRun.progress = 1;

        const totalCounts: Record<string, number> = {};
        for (const data of Object.values(blockOutputs)) {
          const c = countPipelineData(data);
          for (const [k, v] of Object.entries(c)) {
            totalCounts[k] = (totalCounts[k] ?? 0) + v;
          }
        }
        blockRun.counts = totalCounts;

        await this.saveOutput(run.id, block.id, blockOutputs);
        this.emitUpdate(run);
      } catch (err) {
        if (signal.aborted) {
          blockRun.status = "skipped";
          blockRun.finishedAt = new Date().toISOString();
          run.status = "cancelled";
          run.finishedAt = blockRun.finishedAt;
          this.emitUpdate(run);
          return { status: "paused" };
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        blockRun.status = "failed";
        blockRun.error = errMsg;
        blockRun.finishedAt = new Date().toISOString();

        const downstream = getDownstreamBlockIds(graph, block.id);
        for (const dnId of downstream) {
          const dnRun = run.blockRuns.find((br) => br.blockId === dnId);
          if (dnRun && dnRun.status === "pending") dnRun.status = "skipped";
        }

        run.status = "failed";
        run.finishedAt = new Date().toISOString();
        run.error = `Block "${block.label}" (${block.id}) failed: ${errMsg}`;
        this.emitUpdate(run);
        await this.recordAudit("run.failed", run, run.error);
        return { status: "paused" };
      }
    }

    const outputsToParent: Record<string, PipelineData> = {};
    for (const b of graph.blocks) {
      if (b.kind === "block_output") {
        const portId = (b.params as { port?: string }).port ?? "out";
        const bOut = await this.getBlockOutput(run.id, b.id);
        outputsToParent[portId] = bOut?.in ?? emptyPipelineData();
      }
    }

    if (graph === run.graph && run.status === "running") {
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
      this.emitUpdate(run);
      await this.recordAudit("run.completed", run);
    }

    return { status: "ok", outputs: outputsToParent };
  }

  async resume(runId: string): Promise<WorkflowRun> {
    const run = this.getRun(runId);
    if (run.status !== "waiting_for_review") {
      throw new EngineError(
        `Cannot resume run ${runId}: status is "${run.status}", expected "waiting_for_review"`,
      );
    }

    const pausedInfo = this.pausedRuns.get(runId);
    if (!pausedInfo) throw new EngineError(`No paused state recorded for run ${runId}`);

    run.status = "running";
    this.emitUpdate(run);
    await this.recordAudit("run.resumed", run);

    const controller = new AbortController();
    this.activeControllers.set(run.id, controller);

    await this.executeWorkplace(run, run.graph, {}, pausedInfo.settings, controller.signal, true);

    return this.getRun(runId);
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    const run = this.getRun(runId);
    const controller = this.activeControllers.get(runId);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(runId);
    }
    run.status = "cancelled";
    run.finishedAt = new Date().toISOString();
    this.emitUpdate(run);
    return run;
  }
}
