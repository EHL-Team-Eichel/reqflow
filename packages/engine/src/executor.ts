import {
  type Actor,
  type AuditLogger,
  countPipelineData,
  emptyPipelineData,
  type FileStore,
  type LlmClient,
  mergePipelineData,
  newId,
  type NodeRun,
  type PipelineData,
  type Requirement,
  type Settings,
  type WebSearch,
  type Workflow,
  type WorkflowGraph,
  WorkflowRun,
} from "@reqflow/core";
import type { NodeContext } from "./node";
import type { NodeRegistry } from "./registry";
import {
  getDownstreamNodeIds,
  GraphError,
  topologicalSort,
  validateWorkflowGraph,
} from "./validate";

export interface NodeOutputStore {
  saveNodeOutput(runId: string, nodeId: string, data: PipelineData): Promise<void>;
  getNodeOutput(runId: string, nodeId: string): Promise<PipelineData | null>;
}

export interface RequirementLoader {
  list(filter?: { runId?: string }): Promise<Requirement[]>;
}

export interface WorkflowExecutorOptions {
  registry: NodeRegistry;
  services: {
    llm: LlmClient;
    audit: AuditLogger;
    files: FileStore;
    web: WebSearch | null;
  };
  outputStore?: NodeOutputStore;
  requirementLoader?: RequirementLoader;
  onUpdate?: (run: WorkflowRun) => void;
}

export class WorkflowExecutor {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly nodeOutputs = new Map<string, Map<string, PipelineData>>();
  private readonly pausedStates = new Map<
    string,
    {
      topologicalOrder: string[];
      currentIndex: number;
      settings: Settings;
    }
  >();

  constructor(private readonly options: WorkflowExecutorOptions) {}

  private getRun(runId: string): WorkflowRun {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
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
      // audit failure must not crash engine
    }
  }

  private async saveOutput(runId: string, nodeId: string, data: PipelineData): Promise<void> {
    let runOutputs = this.nodeOutputs.get(runId);
    if (!runOutputs) {
      runOutputs = new Map();
      this.nodeOutputs.set(runId, runOutputs);
    }
    runOutputs.set(nodeId, data);

    if (this.options.outputStore) {
      await this.options.outputStore.saveNodeOutput(runId, nodeId, data);
    }
  }

  private async getOutput(runId: string, nodeId: string): Promise<PipelineData | null> {
    const runOutputs = this.nodeOutputs.get(runId);
    if (runOutputs?.has(nodeId)) {
      return runOutputs.get(nodeId)!;
    }
    if (this.options.outputStore) {
      return await this.options.outputStore.getNodeOutput(runId, nodeId);
    }
    return null;
  }

  createInitialRun(
    workflow: Workflow,
    startedBy: Actor,
    initialStatus: WorkflowRun["status"] = "running",
  ): WorkflowRun {
    const initialNodeRuns: NodeRun[] = workflow.nodes.map((n) => ({
      nodeId: n.id,
      status: "pending",
      counts: {},
      logs: [],
    }));

    const run: WorkflowRun = {
      id: newId("run"),
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      graph: { nodes: workflow.nodes, edges: workflow.edges },
      scope: workflow.scope,
      status: initialStatus,
      startedBy,
      startedAt: new Date().toISOString(),
      nodeRuns: initialNodeRuns,
    };

    this.runs.set(run.id, run);
    return run;
  }

  async execute(workflow: Workflow, startedBy: Actor, settings: Settings): Promise<WorkflowRun> {
    const validation = validateWorkflowGraph(workflow, this.options.registry);
    if (!validation.valid) {
      const run = this.createInitialRun(workflow, startedBy, "failed");
      run.finishedAt = new Date().toISOString();
      run.error = validation.errors.map((e) => e.message).join("; ");
      this.emitUpdate(run);
      await this.recordAudit("run.failed", run, run.error);
      throw new GraphError(`Invalid workflow graph: ${run.error}`, validation.errors);
    }

    const run = this.createInitialRun(workflow, startedBy, "running");
    const controller = new AbortController();
    this.activeControllers.set(run.id, controller);

    this.emitUpdate(run);
    await this.recordAudit("run.started", run);

    const order = topologicalSort(workflow);
    await this.runLoop(run, order, 0, settings, controller.signal);
    return this.getRun(run.id);
  }

  async start(workflow: Workflow, startedBy: Actor, settings: Settings): Promise<WorkflowRun> {
    const validation = validateWorkflowGraph(workflow, this.options.registry);
    if (!validation.valid) {
      const run = this.createInitialRun(workflow, startedBy, "failed");
      run.finishedAt = new Date().toISOString();
      run.error = validation.errors.map((e) => e.message).join("; ");
      this.emitUpdate(run);
      await this.recordAudit("run.failed", run, run.error);
      throw new GraphError(`Invalid workflow graph: ${run.error}`, validation.errors);
    }

    const run = this.createInitialRun(workflow, startedBy, "running");
    const controller = new AbortController();
    this.activeControllers.set(run.id, controller);

    this.emitUpdate(run);
    await this.recordAudit("run.started", run);

    const order = topologicalSort(workflow);
    // Background execution
    void this.runLoop(run, order, 0, settings, controller.signal).catch((err) => {
      console.error(`[engine] run ${run.id} unexpected error:`, err);
    });

    return run;
  }

  private async runLoop(
    run: WorkflowRun,
    order: string[],
    startIndex: number,
    settings: Settings,
    signal: AbortSignal,
    resumedAtStart = false,
  ): Promise<void> {
    const nodeMap = new Map(run.graph.nodes.map((n) => [n.id, n]));

    for (let i = startIndex; i < order.length; i++) {
      if (signal.aborted) {
        run.status = "cancelled";
        run.finishedAt = new Date().toISOString();
        this.emitUpdate(run);
        this.activeControllers.delete(run.id);
        return;
      }

      const nodeId = order[i]!;
      const nodeConfig = nodeMap.get(nodeId)!;
      const nodeRun = run.nodeRuns.find((nr) => nr.nodeId === nodeId)!;

      // Check incoming edges
      const incomingEdges = run.graph.edges.filter((e) => e.target === nodeId);
      const parentNodeRuns = incomingEdges.map((e) =>
        run.nodeRuns.find((nr) => nr.nodeId === e.source)!,
      );

      // If any parent node failed or skipped, this node is skipped
      if (parentNodeRuns.some((p) => p && (p.status === "failed" || p.status === "skipped"))) {
        nodeRun.status = "skipped";
        this.emitUpdate(run);
        continue;
      }

      // Merge inputs from parents
      const parentOutputs: PipelineData[] = [];
      for (const edge of incomingEdges) {
        const out = await this.getOutput(run.id, edge.source);
        if (out) parentOutputs.push(out);
      }

      let input =
        parentOutputs.length > 0 ? mergePipelineData(...parentOutputs) : emptyPipelineData();

      // If resuming at this node, check if latest requirements should replace input
      const isResumingThisNode = i === startIndex && resumedAtStart;
      if (isResumingThisNode && this.options.requirementLoader) {
        try {
          const latestReqs = await this.options.requirementLoader.list({
            runId: run.id,
          });
          if (latestReqs.length > 0) {
            input = {
              ...input,
              requirements: latestReqs,
            };
          }
        } catch {
          // ignore loader errors
        }
      }

      nodeRun.status = "running";
      nodeRun.startedAt = new Date().toISOString();
      this.emitUpdate(run);

      const nodeDef = this.options.registry.get(nodeConfig.type);
      const parsedConfig = nodeDef.configSchema.parse(nodeConfig.config);

      const ctx: NodeContext = {
        runId: run.id,
        nodeId: nodeConfig.id,
        scope: run.scope,
        settings,
        llm: this.options.services.llm,
        audit: this.options.services.audit,
        files: this.options.services.files,
        web: this.options.services.web,
        log: (msg: string) => {
          nodeRun.logs.push({ at: new Date().toISOString(), message: msg });
          this.emitUpdate(run);
        },
        progress: (fraction: number, message?: string) => {
          nodeRun.progress = Math.max(0, Math.min(1, fraction));
          if (message) {
            nodeRun.logs.push({ at: new Date().toISOString(), message });
          }
          this.emitUpdate(run);
        },
        signal,
        resumed: isResumingThisNode,
      };

      try {
        const result = await nodeDef.run(input, parsedConfig, ctx);

        if (signal.aborted) {
          run.status = "cancelled";
          run.finishedAt = new Date().toISOString();
          this.emitUpdate(run);
          this.activeControllers.delete(run.id);
          return;
        }

        if (result.status === "paused") {
          nodeRun.status = "waiting_for_review";
          nodeRun.logs.push({ at: new Date().toISOString(), message: result.message });
          run.status = "waiting_for_review";
          await this.saveOutput(run.id, nodeId, input);
          this.pausedStates.set(run.id, {
            topologicalOrder: order,
            currentIndex: i,
            settings,
          });
          this.emitUpdate(run);
          await this.recordAudit("run.paused", run, result.message);
          return;
        }

        // status === "ok"
        nodeRun.status = "succeeded";
        nodeRun.finishedAt = new Date().toISOString();
        nodeRun.progress = 1;
        nodeRun.counts = countPipelineData(result.data);
        await this.saveOutput(run.id, nodeId, result.data);
        this.emitUpdate(run);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        nodeRun.status = "failed";
        nodeRun.error = errMsg;
        nodeRun.finishedAt = new Date().toISOString();

        // Mark all downstream nodes as skipped
        const downstreamIds = getDownstreamNodeIds(run.graph, nodeId);
        for (const dnId of downstreamIds) {
          const dnRun = run.nodeRuns.find((nr) => nr.nodeId === dnId);
          if (dnRun && dnRun.status === "pending") {
            dnRun.status = "skipped";
          }
        }

        run.status = "failed";
        run.finishedAt = new Date().toISOString();
        run.error = `Node "${nodeId}" failed: ${errMsg}`;
        this.emitUpdate(run);
        await this.recordAudit("run.failed", run, run.error);
        this.activeControllers.delete(run.id);
        return;
      }
    }

    // All nodes finished
    run.status = "completed";
    run.finishedAt = new Date().toISOString();
    this.emitUpdate(run);
    await this.recordAudit("run.completed", run);
    this.activeControllers.delete(run.id);
  }

  async resume(runId: string): Promise<WorkflowRun> {
    const run = this.getRun(runId);
    if (run.status !== "waiting_for_review") {
      throw new Error(
        `Cannot resume run ${runId}: status is "${run.status}", expected "waiting_for_review"`,
      );
    }

    const paused = this.pausedStates.get(runId);
    if (!paused) {
      throw new Error(`No paused state recorded for run ${runId}`);
    }

    run.status = "running";
    this.emitUpdate(run);
    await this.recordAudit("run.resumed", run);

    const controller = new AbortController();
    this.activeControllers.set(run.id, controller);

    await this.runLoop(
      run,
      paused.topologicalOrder,
      paused.currentIndex,
      paused.settings,
      controller.signal,
      true, // resumedAtStart
    );

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
