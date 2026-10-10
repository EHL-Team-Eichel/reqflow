import {
  isBoundaryBlockKind,
  newId,
  Settings,
  validateGraph,
  withSplitterWorkplaces,
  WorkflowRun,
  type Actor,
  type AuditLogger,
  type FileStore,
  type LlmClient,
  type PipelineData,
  type ResearchCollector,
  type Workflow,
  type WorkflowGraph,
  type WebSearch,
} from "@reqflow/core";
import type { BlockContext, CarService } from "./block";
import type { BlockRegistry } from "./registry";
import {
  collectAllBlocks,
  EngineError,
  executeWorkflow,
  prepareWorkflowRun,
  usesInnerWorkplace,
  type WorkflowOutputs,
} from "./research-kernel";

// Both entry points execute the same kernel. Keep the original standalone API available.
export {
  collectAllBlocks,
  EngineError,
  executeWorkflow,
  getDownstreamBlockIds,
  topologicalSortBlocks,
  type ExecuteWorkflowOptions,
  type ExecuteWorkflowResult,
  type WorkflowOutputs,
} from "./research-kernel";

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
    audit: AuditLogger;
    files: FileStore;
    web: WebSearch | null;
    car: CarService;
    research?: (
      runId: string,
      blockId: string,
      settings: Settings,
    ) => ResearchCollector | undefined;
  };
  outputStore?: BlockOutputStore;
  /** Persist the snapshot and then push it. The executor awaits this callback. */
  onUpdate?: (run: WorkflowRun) => void | Promise<void>;
}

type RunSession = {
  run: WorkflowRun;
  settings: Settings;
  controller: AbortController;
  outputs: WorkflowOutputs;
  /** Only durable outputs are visible to getBlockOutput and update subscribers. */
  savedOutputs: WorkflowOutputs;
  savedReferences: Map<string, Record<string, PipelineData>>;
  busy: boolean;
  operation?: Promise<WorkflowRun>;
};
const terminal = new Set(["completed", "failed", "cancelled"]);
const now = () => new Date().toISOString();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Lifecycle adapter: admission, service wiring, durable outputs, audit, and persisted review resume. */
export class WorkflowExecutor {
  private readonly sessions = new Map<string, RunSession>();
  private readonly admissions = new Map<string, string>();

  constructor(private readonly options: WorkflowExecutorOptions) {}

  private session(runId: string): RunSession {
    const session = this.sessions.get(runId);
    if (!session) throw new EngineError(`Run not found: ${runId}`);
    return session;
  }

  private reserve(run: WorkflowRun): void {
    const active = this.admissions.get(run.workflowId);
    if (active && active !== run.id)
      throw new EngineError(`Workflow ${run.workflowId} already has an active run: ${active}`);
    if (!terminal.has(run.status)) this.admissions.set(run.workflowId, run.id);
  }

  private release(session: RunSession): void {
    session.busy = false;
    if (
      terminal.has(session.run.status) &&
      this.admissions.get(session.run.workflowId) === session.run.id
    )
      this.admissions.delete(session.run.workflowId);
  }

  createInitialRun(workflow: Workflow, startedBy: Actor): WorkflowRun {
    workflow = withSplitterWorkplaces(structuredClone(workflow));
    const run = WorkflowRun.parse({
      id: newId("run"),
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      graph: { blocks: workflow.blocks, edges: workflow.edges },
      scope: workflow.scope,
      status: "queued",
      startedBy,
      startedAt: now(),
      blockRuns: collectAllBlocks(workflow).map((block) => ({
        blockId: block.id,
        status: "pending",
        counts: {},
        logs: [],
      })),
    });
    return run;
  }

  validateBeforeRun(workflow: Workflow): void {
    workflow = withSplitterWorkplaces(workflow);
    const issues = validateGraph(workflow);
    if (issues.length)
      throw new EngineError(
        `Workflow validation failed: ${issues.map((issue) => issue.message).join("; ")}`,
        issues,
      );
    const visit = (graph: WorkflowGraph) => {
      for (const block of graph.blocks) {
        if (usesInnerWorkplace(block)) visit(block.inner!);
        else if (!isBoundaryBlockKind(block.kind) && !this.options.registry.has(block.kind))
          throw new EngineError(
            `Block "${block.label}" (${block.id}) has no implementation for kind "${block.kind}"`,
          );
      }
    };
    visit(workflow);
  }

  private admit(workflow: Workflow, startedBy: Actor, settings: Settings): RunSession {
    this.validateBeforeRun(workflow);
    const snapshot = Settings.parse(structuredClone(settings));
    const run = this.createInitialRun(workflow, startedBy);
    // Admission happens before the first await, including the queued persistence callback.
    this.reserve(run);
    const session: RunSession = {
      run,
      settings: snapshot,
      controller: new AbortController(),
      outputs: {},
      savedOutputs: {},
      savedReferences: new Map(),
      busy: true,
    };
    this.sessions.set(run.id, session);
    return session;
  }

  /** Register a persisted snapshot and its per-port outputs without restarting any block. */
  restore(
    run: WorkflowRun,
    settings: Settings,
    outputs: Record<string, Record<string, PipelineData>>,
  ): void {
    const existing = this.sessions.get(run.id);
    if (existing?.busy) throw new EngineError(`Run ${run.id} is already active`);
    const normalized = {
      ...structuredClone(run),
      graph: withSplitterWorkplaces(structuredClone(run.graph)),
    };
    const restoredOutputs = structuredClone(outputs);
    const restoredRun = prepareWorkflowRun(normalized, restoredOutputs);
    const restoredSettings = Settings.parse(structuredClone(settings));
    this.reserve(restoredRun);
    this.sessions.set(run.id, {
      run: restoredRun,
      settings: restoredSettings,
      outputs: restoredOutputs,
      savedOutputs: structuredClone(restoredOutputs),
      savedReferences: new Map(Object.entries(restoredOutputs)),
      controller: new AbortController(),
      busy: false,
    });
  }

  async getBlockOutput(
    runId: string,
    blockId: string,
  ): Promise<Record<string, PipelineData> | null> {
    const saved = this.sessions.get(runId)?.savedOutputs[blockId];
    if (saved) return structuredClone(saved);
    const stored = await this.options.outputStore?.getBlockOutput(runId, blockId);
    return stored ? structuredClone(stored) : null;
  }

  private async publish(session: RunSession, update: WorkflowRun): Promise<void> {
    // Install the operation promise before invoking a synchronous subscriber (which may cancel).
    await Promise.resolve();
    for (const state of update.blockRuns) {
      if (state.status !== "succeeded") continue;
      const outputs = session.outputs[state.blockId];
      if (!outputs || session.savedReferences.get(state.blockId) === outputs) continue;
      const snapshot = structuredClone(outputs);
      await this.options.outputStore?.saveBlockOutput(update.id, state.blockId, snapshot);
      session.savedOutputs[state.blockId] = structuredClone(snapshot);
      session.savedReferences.set(state.blockId, outputs);
    }
    session.run = WorkflowRun.parse(structuredClone(update));
    await this.options.onUpdate?.(structuredClone(session.run));
  }

  private async recordAudit(
    action:
      | "run.started"
      | "run.resumed"
      | "run.paused"
      | "run.completed"
      | "run.failed"
      | "run.cancelled",
    run: WorkflowRun,
  ): Promise<void> {
    await this.options.services.audit.record({
      actor: { type: "system", component: "engine" },
      action,
      entityType: "run",
      entityId: run.id,
      runId: run.id,
      ...(run.error ? { rationale: run.error } : {}),
    });
  }

  private context(session: RunSession, blockId: string): BlockContext {
    const services = this.options.services;
    const llm = services.llm;
    return {
      runId: session.run.id,
      blockId,
      scope: session.run.scope,
      settings: session.settings,
      llm:
        typeof llm === "function"
          ? {
              generateObject: async (request) =>
                (await llm(session.settings)).generateObject(request),
              generateText: async (request) => (await llm(session.settings)).generateText(request),
            }
          : llm,
      audit: services.audit,
      files: services.files,
      web: services.web,
      car: services.car,
      research: services.research?.(session.run.id, blockId, session.settings),
      signal: session.controller.signal,
      resumed: false,
      // The kernel owns logs and progress, including immutable ordered updates.
      log() {},
      progress() {},
    };
  }

  private async drive(
    session: RunSession,
    action?: "run.started" | "run.resumed",
  ): Promise<WorkflowRun> {
    if (action) await this.recordAudit(action, session.run);
    const audited = new Set<string>();
    await executeWorkflow({
      run: session.run,
      registry: this.options.registry,
      outputs: session.outputs,
      context: (blockId) => this.context(session, blockId),
      signal: session.controller.signal,
      onUpdate: async (update) => {
        await this.publish(session, update);
        if (update.status === "queued" || update.status === "running" || audited.has(update.status))
          return;
        // Pre-start cancellation and recursive skips can publish intermediate cancelled snapshots.
        if (
          update.status === "cancelled" &&
          update.blockRuns.some(
            (state) =>
              state.status === "pending" ||
              state.status === "running" ||
              state.status === "waiting_for_review",
          )
        )
          return;
        await this.recordAudit(
          update.status === "waiting_for_review"
            ? "run.paused"
            : update.status === "completed"
              ? "run.completed"
              : update.status === "cancelled"
                ? "run.cancelled"
                : "run.failed",
          update,
        );
        audited.add(update.status);
      },
    });
    return structuredClone(session.run);
  }

  private async fail(session: RunSession, error: unknown): Promise<never> {
    // Infrastructure failures must be observable, not mistaken for successful blocks or swallowed.
    const run = structuredClone(session.run);
    run.status = session.controller.signal.aborted ? "cancelled" : "failed";
    run.error = message(error);
    run.finishedAt = now();
    for (const state of run.blockRuns) {
      if (state.status === "succeeded" && session.savedOutputs[state.blockId]) continue;
      if (state.status === "failed" || state.status === "skipped") continue;
      state.status = state.status === "running" ? "failed" : "skipped";
      state.finishedAt = run.finishedAt;
      if (state.status === "failed") state.error = run.error;
    }
    session.run = run;
    try {
      await this.recordAudit(run.status === "cancelled" ? "run.cancelled" : "run.failed", run);
    } catch {
      // The original infrastructure error remains the operation's rejection.
    }
    // A failed persistence channel may fail again. Retain the failure in memory and reject the operation.
    try {
      await this.options.onUpdate?.(structuredClone(run));
    } catch {
      /* Original error is rethrown below. */
    }
    throw error;
  }

  private observe(session: RunSession, work: Promise<WorkflowRun>): Promise<WorkflowRun> {
    const operation = work
      .catch((error: unknown) => this.fail(session, error))
      .finally(() => this.release(session));
    session.operation = operation;
    // start is intentionally nonblocking. Its background rejection is reported by fail, then observed here.
    void operation.catch(() => {});
    return operation;
  }

  async execute(workflow: Workflow, startedBy: Actor, settings: Settings): Promise<WorkflowRun> {
    const session = this.admit(workflow, startedBy, settings);
    return this.observe(
      session,
      this.publish(session, session.run).then(() => this.drive(session, "run.started")),
    );
  }

  async start(workflow: Workflow, startedBy: Actor, settings: Settings): Promise<WorkflowRun> {
    const session = this.admit(workflow, startedBy, settings);
    const initial = structuredClone(session.run);
    const ready = this.publish(session, initial);
    this.observe(
      session,
      ready.then(() => this.drive(session, "run.started")),
    );
    await ready;
    return initial;
  }

  async resume(runId: string): Promise<WorkflowRun> {
    const session = this.session(runId);
    if (session.busy) throw new EngineError(`Run ${runId} is already active`);
    if (session.run.status !== "waiting_for_review")
      throw new EngineError(
        `Cannot resume run ${runId}: status is "${session.run.status}", expected "waiting_for_review"`,
      );
    session.busy = true;
    session.controller = new AbortController();
    const update = { ...structuredClone(session.run), status: "running" as const };
    return this.observe(
      session,
      this.publish(session, update).then(() => this.drive(session, "run.resumed")),
    );
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    const session = this.session(runId);
    if (!session.busy && terminal.has(session.run.status)) return structuredClone(session.run);
    session.controller.abort(new EngineError("Run cancelled"));
    if (session.busy && session.operation) {
      await session.operation;
      return structuredClone(session.run);
    }
    session.busy = true;
    // Paused/persisted runs take the kernel's cancellation path too; no second status machine.
    return this.observe(session, this.drive(session));
  }
}
