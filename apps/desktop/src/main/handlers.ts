import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import type { SaveDialogOptions, SaveDialogReturnValue } from "electron";
import { z } from "zod";
import { exportHilReportPdf } from "./hil-exporter";
import {
  redactSecrets,
  assertJsonByteBudget,
  PERSISTED_JSON_MAX_BYTES,
  BMW_DEFAULT_TEMPLATE,
  createBlockRegistry,
} from "@reqflow/blocks";
import {
  aiProposalProblem,
  AuditAction,
  AuditEntityType,
  type AuditFilter,
  type AuditEventInput,
  DECISION_TO_STATUS,
  decisionProblem,
  DecisionStatus,
  emptyPipelineData,
  EvidenceLevel,
  type FieldChange,
  parseBlockParams,
  Priority,
  rescoreBreakdown,
  RequirementCategory,
  RequirementDecision,
  RequirementEdit,
  Requirement,
  type RequirementFilter,
  ScoreFactor,
  Settings,
  LLM_SECRET_NAMES,
  SecretName,
  SECRET_NAMES,
  Workflow,
  PipelineData,
  BlockId,
  FilterReview,
  FilterReport,
  walkBlocks,
  type WorkflowRun,
  type WorkflowSave,
  type LlmClient,
  type WebSearch,
} from "@reqflow/core";
import {
  SETUP_SECRET_PATTERN,
  type AppInfo,
  type ReqflowHandlers,
  type SetupSecretName,
} from "@reqflow/core/ipc";
import {
  createDatabase,
  formatRequirementsCsv,
  formatRequirementsJson,
  formatRequirementsMarkdown,
  removeDemoData,
  SqliteAuditLogger,
  SqliteReasoningRepository,
  SqliteRequirementRepository,
  RequirementConflictError,
  FilterOverrideRepository,
  FilterOverrideConflictError,
  FilterOverrideValidationError,
  FilterOverrideStateError,
  SqliteRunRepository,
  type LocalFileStore,
  type RequirementExport,
} from "@reqflow/db";
import { BlockRegistry, WorkflowExecutor } from "@reqflow/engine";
import { createLlmClient, createMastraLlmClient } from "@reqflow/llm";
import { createAgentServices, directDefaultLlm, testSetup, type AgentDeps } from "./agents";
import { ReqflowError } from "./dispatch";
import { previewBlock } from "./preview";
import { SecretsStore } from "./secrets";
import { getSettingsFilePath, mergeWithDefaultSettings, saveSettings } from "./settings-storage";
import { getWorkflow, listWorkflows, removeWorkflow, saveWorkflow } from "./workflow-storage";
import { createResearchService, type ResearchOptions } from "./research/runtime";
import { migrateLegacyResearch } from "./research/migration";
import { recoverInterruptedRun } from "./research/recovery";
import { ResearchDatasetRepository } from "../../../../packages/db/src/research";

const RequirementFilterSchema = z
  .object({
    runId: z.string().optional(),
    status: z.array(DecisionStatus).optional(),
    category: z.array(RequirementCategory).optional(),
    priority: z.array(Priority).optional(),
    evidenceLevel: z.array(EvidenceLevel).optional(),
  })
  .optional();

const AuditFilterSchema = z
  .object({
    entityId: z.string().optional(),
    entityType: AuditEntityType.optional(),
    actorType: z.enum(["ai", "human", "system"]).optional(),
    action: AuditAction.optional(),
    runId: z.string().optional(),
    limit: z.number().int().positive().optional(),
  })
  .optional();

const SecretNameSchema = z.union([
  SecretName,
  z.string().regex(SETUP_SECRET_PATTERN, "Unknown secret name") as z.ZodType<SetupSecretName>,
]);
const WorkflowId = z.string().regex(/^wf_[A-Za-z0-9_-]{1,100}$/);
const RunId = z.string().regex(/^run_[A-Za-z0-9_-]{1,100}$/);

const ExportRequirementsSchema = z.object({
  runId: z.string().optional(),
  format: z.enum(["json", "csv", "md"]),
});

/**
 * Four-eyes rule: the latest of these events on a requirement decides whether an approval is the
 * first or the second. Any content or status change after a first approval resets the count.
 */
const FOUR_EYES_ACTIONS = new Set<AuditAction>([
  "requirement.approval_recorded",
  "requirement.status_changed",
  "requirement.edited",
  "requirement.prioritized",
  "requirement.challenged",
  "requirement.challenge_answered",
]);

/** "Dr. Anna Müller" → "user-dr-anna-muller"; undefined when the name has no letters or digits. */
export function reviewerIdFor(name: string): string | undefined {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug ? `user-${slug}` : undefined;
}

const RunIdSchema = z.string().startsWith("run_");
const WorkflowIdSchema = z.string().startsWith("wf_");
const NonEmptySchema = z.string().min(1);

/** Parses an IPC argument; bad input → ReqflowError("invalid_input") naming the argument. */
function parseArg<T>(schema: z.ZodType<T>, value: unknown, name: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ReqflowError("invalid_input", `Invalid ${name}`, parsed.error.issues);
  }
  return parsed.data;
}

async function showElectronSaveDialog(opts: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  try {
    const electron = await import("electron");
    if (electron.dialog) {
      return await electron.dialog.showSaveDialog(opts);
    }
  } catch {
    // fallback
  }
  return { canceled: true, filePath: "" };
}

export interface HandlerDeps {
  appInfo: () => AppInfo;
  files: LocalFileStore;
  /** Shows the native open dialog; resolves to the chosen path, or null when cancelled. */
  pickFile: () => Promise<string | null>;
  dataDir?: string;
  dbPath?: string;
  registry?: BlockRegistry;
  llm?: LlmClient;
  web?: WebSearch | null;
  saveDialog?: (opts: SaveDialogOptions) => Promise<SaveDialogReturnValue>;
  pushRunUpdate?: (run: WorkflowRun) => void;
  secretsStore?: SecretsStore;
  /** Injectable transport for API setups (tests); defaults to the global fetch. */
  fetch?: typeof fetch;
  researchOptions?: ResearchOptions;
}

export function createHandlers(deps: HandlerDeps): ReqflowHandlers {
  const info = deps.appInfo();
  const dataDir = deps.dataDir ?? info.dataDir;
  const db = createDatabase(deps.dbPath ?? (dataDir ? join(dataDir, "reqflow.db") : ":memory:"));

  // Earlier builds seeded synthetic demo data into every new database; remove what's left of it.
  const demo = removeDemoData(db);
  const demoRows = Object.values(demo).reduce((sum, n) => sum + n, 0);
  if (demoRows) console.info(`Removed ${demoRows} synthetic demo rows from the database`, demo);

  const sqliteAudit = new SqliteAuditLogger(db);
  const sensitive = new Set<string>();
  const safe = (text: string) => redactSecrets(text, [...sensitive]);
  const auditLogger = {
    list: sqliteAudit.list.bind(sqliteAudit),
    record: (event: Parameters<typeof sqliteAudit.record>[0]) =>
      sqliteAudit.record({
        ...event,
        rationale: event.rationale === undefined ? undefined : safe(event.rationale),
      }),
  };
  const loadSettings = (_dir: string): Settings => {
    const path = getSettingsFilePath(dataDir);
    if (!existsSync(path)) return mergeWithDefaultSettings({});
    try {
      if (statSync(path).size > PERSISTED_JSON_MAX_BYTES) throw new Error("size");
      return mergeWithDefaultSettings(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      throw new ReqflowError("storage_error", "Settings could not be read or failed validation.");
    }
  };
  const runRepo = new SqliteRunRepository(db);
  const reqRepo = new SqliteRequirementRepository(db);
  const reasoningRepo = new SqliteReasoningRepository(db);
  const secretsStore = deps.secretsStore ?? new SecretsStore(dataDir);

  const defaultAiKey = async (settings: Settings): Promise<string | undefined> => {
    if (settings.llm.provider === "mock") return undefined;
    const apiKey =
      (await secretsStore.getSecret(LLM_SECRET_NAMES[settings.llm.provider])) ?? undefined;
    if (!apiKey) {
      throw new Error(
        `The default AI (${settings.llm.provider}) has no API key. Add it in Settings → AI.`,
      );
    }
    sensitive.add(apiKey);
    return apiKey;
  };
  // Blocks call the default AI through a standalone Mastra Agent (AI Splitter's choice).
  const configuredLlm = async (settings: Settings): Promise<LlmClient> => {
    if (deps.llm) return deps.llm;
    const options = { apiKey: await defaultAiKey(settings) };
    return settings.llm.provider === "anthropic"
      ? createMastraLlmClient(settings.llm, options)
      : createLlmClient(settings.llm, options);
  };
  // The Add to Car agents call it directly: adaptive thinking and effort need the Messages API.
  const directLlm = async (settings: Settings): Promise<LlmClient> => {
    if (deps.llm) return deps.llm;
    return directDefaultLlm(settings, await defaultAiKey(settings), deps.fetch);
  };
  const agentDeps: AgentDeps = {
    defaultLlm: directLlm,
    getKey: async (setupId) => {
      const key = await secretsStore.getSecret(`setup:${setupId}`);
      if (key) sensitive.add(key);
      return key;
    },
    fetch: deps.fetch,
  };
  const requirementAudit = (event: AuditEventInput): AuditEventInput =>
    JSON.parse(
      JSON.stringify(event, (_key, value: unknown) =>
        typeof value === "string" ? safe(value) : value,
      ),
    ) as AuditEventInput;
  const requirementMutation = <T>(write: () => T): T => {
    try {
      return write();
    } catch (error) {
      if (error instanceof RequirementConflictError)
        throw new ReqflowError("conflict", error.message);
      throw new ReqflowError("storage_error", "Requirement change and audit could not be saved.");
    }
  };
  const commitRequirement = (
    req: Requirement,
    expectedVersion: number,
    events: AuditEventInput[],
  ) =>
    requirementMutation(() =>
      reqRepo.saveVersionWithAudit(req, expectedVersion, events.map(requirementAudit)),
    );
  /**
   * New versions of the requirements whose score changes under new Settings weights or
   * thresholds. Factor values and notes stay; priority and status are left to the input rank and
   * the PM. Throws RangeError when the weights can't score anything (all zero).
   */
  const rescoredVersions = (
    requirements: Requirement[],
    scoring: Settings["scoring"],
    changedBy: string,
  ) => {
    const now = new Date().toISOString();
    return requirements.flatMap((req) => {
      const before = req.score;
      if (!before) return [];
      const after = rescoreBreakdown(before, scoring, req.evidenceLevel, now);
      const changed =
        after.total !== before.total ||
        after.suggestedPriority !== before.suggestedPriority ||
        JSON.stringify(after.flags ?? []) !== JSON.stringify(before.flags ?? []) ||
        ScoreFactor.options.some((f) => after.factors[f].weight !== before.factors[f].weight);
      if (!changed) return [];
      const event: AuditEventInput = {
        actor: { type: "system", component: "settings.rescore" },
        action: "requirement.scored",
        entityType: "requirement",
        entityId: req.id,
        runId: req.runId,
        rationale: `Scoring settings changed by ${changedBy}: ${before.total} → ${after.total} (${after.suggestedPriority}).`,
        changes: [{ path: "score", before, after }],
      };
      return [{ next: { ...req, score: after, version: req.version + 1, updatedAt: now }, event }];
    });
  };
  /** A run's paused HIL gates: approvals each needs, and who approved it so far in this run. */
  const pausedGates = async (run: WorkflowRun) => {
    const blocks = new Map([...walkBlocks(run.graph)].map(({ block }) => [block.id, block]));
    // An inner workplace's container waits too; only the HIL blocks themselves are gates.
    const gates = run.blockRuns.flatMap((state) => {
      const block = blocks.get(state.blockId);
      return state.status === "waiting_for_review" && block?.kind === "hil" ? [block] : [];
    });
    if (!gates.length)
      throw new ReqflowError(
        "invalid_state",
        `Run ${run.id} is waiting for review, but no paused HIL gate was found to approve.`,
      );
    const approvals = await auditLogger.list({
      entityType: "run",
      entityId: run.id,
      action: "run.review_approved",
    });
    return gates.map((block) => {
      let needed: number;
      try {
        needed = Number(parseBlockParams("hil", block.params).approvals);
      } catch {
        throw new ReqflowError(
          "invalid_state",
          `HIL gate "${block.label}" has invalid settings, so it can't be approved.`,
        );
      }
      const approvers = new Set(
        approvals.flatMap((e) =>
          e.blockId === block.id && e.actor.type === "human" ? [e.actor.userId] : [],
        ),
      );
      return { block, needed, approvers };
    });
  };
  const datasets = new ResearchDatasetRepository(db);
  const filterRepo = new FilterOverrideRepository(db);
  const research = createResearchService({
    ...deps.researchOptions,
    files: deps.files,
    secrets: secretsStore,
    datasets,
    audit: auditLogger,
    settings: () => loadSettings(dataDir),
    saveSettings: (settings) => saveSettings(dataDir, settings),
    getRun: (id) => runRepo.get(id),
    async chooseExport(format, runId) {
      const choice = await (deps.saveDialog ?? showElectronSaveDialog)({
        title: "Export raw research",
        defaultPath: `${runId}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      return choice.canceled ? null : (choice.filePath ?? null);
    },
  });
  const ready = (async () => {
    await migrateLegacyResearch(dataDir, db, deps.files, datasets);
    for (const run of await runRepo.list())
      if (run.status === "running" || run.status === "queued") {
        const recovered = recoverInterruptedRun(run);
        // Unlike active-run updates, startup owns this connection exclusively:
        // every IPC entry awaits ready, so the async repository facades cannot
        // interleave unrelated writes inside this recovery savepoint.
        db.exec("SAVEPOINT startup_recovery");
        try {
          await runRepo.update(recovered);
          await auditLogger.record({
            actor: { type: "system", component: "startup.recovery" },
            action: "run.failed",
            entityType: "run",
            entityId: run.id,
            runId: run.id,
            rationale: recovered.error,
            changes: [{ path: "status", before: run.status, after: recovered.status }],
          });
          db.exec("RELEASE startup_recovery");
        } catch (error) {
          db.exec("ROLLBACK TO startup_recovery; RELEASE startup_recovery");
          throw new ReqflowError(
            "storage_error",
            "Interrupted run recovery could not be persisted.",
          );
        }
      }
  })();
  // Keep startup rejection observed until an IPC request receives it.
  void ready.catch(() => {});
  const registry = deps.registry ?? createBlockRegistry();

  const knownRuns = new Set<string>();
  const starting = new Set<string>();
  const startingSettings = new Map<string, Settings>();
  const restoring = new Set<string>();
  const executor = new WorkflowExecutor({
    registry,
    services: {
      llm: configuredLlm,
      agents: (settings) => createAgentServices(settings, agentDeps),
      audit: auditLogger,
      files: deps.files,
      web: deps.web ?? null,
      research: research.collector,
      car: {
        async add(requirements, evidence) {
          // AI output may only propose. One requirement claiming more fails the block; none is saved.
          const problems = requirements.flatMap((r) => {
            const valid = Requirement.safeParse(r);
            const problem = valid.success
              ? aiProposalProblem(valid.data)
              : `${r.id}: is not a valid requirement (${valid.error.issues[0]?.message})`;
            return problem ? [problem] : [];
          });
          if (problems.length)
            throw new Error(
              `Add to Car may only propose new requirements, so nothing was saved: ${problems.join("; ")}`,
            );
          await reqRepo.savePipelineData({
            ...emptyPipelineData(),
            ...evidence,
            requirements,
          });
        },
        async nextSeq(scope) {
          // Counts deleted requirements too (via the audit trail): ids are never reused.
          return (await reqRepo.maxSeq(`REQ-${scope.vehicleCode}-${scope.market}-`)) + 1;
        },
        async saveReasoning(trace) {
          await reasoningRepo.save(trace);
        },
      },
      filterOverrides: async (workflowId, blockId) => {
        const state = await filterRepo.get(workflowId, blockId);
        return state.overrides;
      },
    },
    outputStore: {
      async saveBlockOutput(runId, blockId, outputs) {
        assertJsonByteBudget(outputs, PERSISTED_JSON_MAX_BYTES);
        z.record(z.string(), PipelineData).parse(outputs); // Validate without stripping raw provenance.
        await runRepo.saveBlockOutput(runId, blockId, outputs);
      },
      async getBlockOutput(runId, blockId) {
        return await runRepo.getBlockOutput(runId, blockId);
      },
      async saveSplitterReview(run, blockId, outputs, event) {
        await runRepo.saveSplitterReview(run, blockId, outputs, event);
      },
    },
    onUpdate: async (input) => {
      if (!["queued", "running"].includes(input.status)) await research.settle(input.id);
      const run = research.sanitize(input);
      if (run.error) run.error = safe(run.error);
      for (const block of run.blockRuns) {
        if (block.error) block.error = safe(block.error);
        for (const log of block.logs) log.message = safe(log.message);
      }
      if (!knownRuns.has(run.id)) {
        const snapshot = startingSettings.get(run.workflowId) ?? loadSettings(dataDir);
        // SqliteRunRepository's async facade executes its SQL synchronously. Do not
        // yield while this savepoint is open: unrelated runs/audit writes share this DB.
        // Observe its promise even if the snapshot write fails and rolls the row back.
        db.exec("SAVEPOINT initial_run");
        let created: Promise<WorkflowRun>;
        try {
          if (db.prepare("SELECT id FROM runs WHERE id = ?").get(run.id))
            throw new ReqflowError("storage_error", "Run already exists in the persistent store.");
          created = runRepo.create(run);
          void created.catch(() => {});
          // Also detects a rejected create before attempting to commit its snapshot.
          if (!db.prepare("SELECT id FROM runs WHERE id = ?").get(run.id))
            throw new ReqflowError("storage_error", "Initial run could not be persisted.");
          datasets.saveSettings(run.id, snapshot);
          db.exec("RELEASE initial_run");
        } catch (error) {
          db.exec("ROLLBACK TO initial_run; RELEASE initial_run");
          throw error;
        }
        await created;
        knownRuns.add(run.id);
      } else await runRepo.update(run);
      deps.pushRunUpdate?.(structuredClone(run));
      if (["completed", "failed", "cancelled"].includes(run.status)) research.release(run.id);
    },
  });

  const restore = async (runId: string) => {
    if (knownRuns.has(runId)) return;
    if (restoring.has(runId))
      throw new ReqflowError("run_busy", "Run is already resuming or active.");
    restoring.add(runId);
    try {
      const run = await runRepo.get(runId);
      const snapshot = datasets.settings(runId);
      if (!snapshot)
        throw new ReqflowError(
          "invalid_state",
          "Run has no persisted settings snapshot; it cannot safely resume.",
        );
      const outputs: Record<string, Record<string, PipelineData>> = {};
      for (const block of run.blockRuns) {
        const value = await runRepo.getBlockOutput(runId, block.blockId);
        if (value) {
          z.record(z.string(), PipelineData).parse(value);
          outputs[block.blockId] = value;
        }
      }
      executor.restore(run, snapshot, outputs);
      knownRuns.add(runId);
    } finally {
      restoring.delete(runId);
    }
  };
  const filterSource = async (runId: string, blockId: string) => {
    const persisted = await runRepo.get(runId).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith("Run not found:"))
        throw new ReqflowError("not_found", `Run not found: ${runId}`);
      throw new ReqflowError("storage_error", "Filter source run could not be read.");
    });
    let current = persisted;
    try {
      current = executor.getRun(runId);
    } catch {
      // Historical runs need no live executor session to review their reports.
    }
    for (const run of [current, persisted]) {
      if (!["completed", "waiting_for_review"].includes(run.status))
        throw new ReqflowError(
          "invalid_state",
          "Cannot restore filter items on run unless completed or waiting_for_review.",
        );
      const block = [...walkBlocks(run.graph)].find(({ block }) => block.id === blockId)?.block;
      const state = run.blockRuns.find((state) => state.blockId === blockId);
      if (!block || !state) throw new ReqflowError("not_found", "Filter block not found in run.");
      const report = FilterReport.safeParse(state.filterReport);
      if (
        block.kind !== "ai_filter" ||
        state.status !== "succeeded" ||
        !report.success ||
        report.data.runId !== runId ||
        report.data.blockId !== blockId
      )
        throw new ReqflowError(
          "invalid_state",
          "Block has no valid completed filter report for this run.",
        );
    }
    const report = current.blockRuns.find((state) => state.blockId === blockId)!.filterReport!;
    const storedReport = persisted.blockRuns.find(
      (state) => state.blockId === blockId,
    )!.filterReport!;
    if (
      current.workflowId !== persisted.workflowId ||
      !isDeepStrictEqual(JSON.parse(JSON.stringify(report)), storedReport)
    )
      throw new ReqflowError("invalid_state", "Filter report does not match persisted run.");
    if (executor.isRunActive(runId) || restoring.has(runId))
      throw new ReqflowError(
        "invalid_state",
        "Filter review requires a stopped or HIL-paused run.",
      );
    return { workflowId: persisted.workflowId, report };
  };
  const handlers: ReqflowHandlers = {
    app: { info: async () => deps.appInfo() },
    blocks: {
      preview: async (request) => {
        const settings = loadSettings(dataDir);
        const lazyLlm: LlmClient = {
          generateText: async (options) => {
            const client = await configuredLlm(settings);
            return client.generateText(options);
          },
          generateObject: async (options) => {
            const client = await configuredLlm(settings);
            return client.generateObject(options);
          },
        };
        return previewBlock(registry, deps.files, request, { settings, llm: lazyLlm });
      },
    },
    templates: { list: async () => [BMW_DEFAULT_TEMPLATE] },
    workflows: {
      list: async () => listWorkflows(dataDir),
      get: async (id: string) => {
        const validatedId = WorkflowId.parse(id);
        return getWorkflow(dataDir, validatedId);
      },
      save: async (input: WorkflowSave) => {
        assertJsonByteBudget(input, PERSISTED_JSON_MAX_BYTES);
        const shape = Workflow.omit({ id: true, version: true, createdAt: true, updatedAt: true })
          .extend({ id: WorkflowId.optional() })
          .parse(input);
        const saved = saveWorkflow(dataDir, shape);
        const settings = loadSettings(dataDir);
        await auditLogger.record({
          actor: {
            type: "human",
            userId: settings.review.reviewer.userId,
            name: settings.review.reviewer.name,
            role: settings.review.reviewer.role,
          },
          action: "workflow.saved",
          entityType: "workflow",
          entityId: saved.id,
          rationale: `Saved workflow "${saved.name}" v${saved.version}`,
        });
        return saved;
      },
      remove: async (id: string) => {
        const validatedId = WorkflowId.parse(id);
        removeWorkflow(dataDir, validatedId);
      },
    },
    files: {
      import: async () => {
        const path = await deps.pickFile();
        return path ? deps.files.importFile(path) : null;
      },
    },
    runs: {
      start: async (workflowId: string) => {
        const wfId = WorkflowId.parse(workflowId);
        if (
          starting.has(wfId) ||
          (await runRepo.list(wfId)).some((run) =>
            ["queued", "running", "waiting_for_review"].includes(run.status),
          )
        )
          throw new ReqflowError("run_busy", "This workflow already has an active run.");
        // Admission must be synchronous after ready: reserve before reading credentials or DB.
        if (starting.has(wfId))
          throw new ReqflowError("run_busy", "This workflow is already starting.");
        starting.add(wfId);
        try {
          const wf = getWorkflow(dataDir, wfId),
            settings = loadSettings(dataDir);
          startingSettings.set(wfId, settings);
          for (const name of SECRET_NAMES) {
            const key = await secretsStore.getSecret(name);
            if (key) sensitive.add(key);
          }
          const startedBy = { type: "human" as const, ...settings.review.reviewer };
          return await executor.start(wf, startedBy, settings);
        } finally {
          starting.delete(wfId);
          startingSettings.delete(wfId);
        }
      },
      get: async (runId: string) => {
        const rId = RunId.parse(runId);
        try {
          return await runRepo.get(rId);
        } catch {
          throw new ReqflowError("not_found", `Run not found: ${rId}`);
        }
      },
      list: async (workflowId?: string) => {
        const wfId = workflowId === undefined ? undefined : WorkflowId.parse(workflowId);
        return await runRepo.list(wfId);
      },
      blockOutput: async (runId: string, blockId: string) => {
        const rId = RunId.parse(runId);
        const bId = BlockId.parse(blockId);
        const outputs = await runRepo.getBlockOutput(rId, bId);
        if (!outputs) {
          throw new ReqflowError(
            "not_found",
            `No outputs found for block "${bId}" in run "${rId}"`,
          );
        }
        z.record(z.string(), PipelineData).parse(outputs);
        return outputs;
      },
      resume: async (runId: string) => {
        const rId = RunId.parse(runId);
        const run = await runRepo.get(rId);
        if (run.status !== "waiting_for_review") {
          throw new ReqflowError(
            "invalid_state",
            `Cannot resume run ${rId}: status is "${run.status}", expected "waiting_for_review"`,
          );
        }
        // Each call is one reviewer's approval of every paused gate they haven't approved yet.
        // A gate needing several approvals keeps the run paused until enough reviewers gave theirs.
        const { reviewer } = loadSettings(dataDir).review;
        const open = (await pausedGates(run)).filter((g) => g.approvers.size < g.needed);
        const mine = open.filter((g) => !g.approvers.has(reviewer.userId));
        if (open.length && !mine.length)
          throw new ReqflowError(
            "invalid_state",
            `${reviewer.name} already approved this gate; it needs ${open[0]!.needed} approvals from different reviewers.`,
          );
        // No open gate left means a previous final approval was recorded but its resume failed.
        const complete =
          mine.length === open.length && mine.every((g) => g.approvers.size + 1 >= g.needed);
        // Restore first, so a run that can't resume doesn't collect the deciding approval.
        if (complete) await restore(rId);
        for (const { block, needed, approvers } of mine) {
          await auditLogger.record({
            actor: { type: "human", ...reviewer },
            action: "run.review_approved",
            entityType: "run",
            entityId: rId,
            runId: rId,
            blockId: block.id,
            rationale: `Approved "${block.label}" (${approvers.size + 1} of ${needed}).`,
            changes: [{ path: "approvals", before: approvers.size, after: approvers.size + 1 }],
          });
        }
        if (!complete) {
          // The run itself is unchanged; the push lets the UI refresh the gate's approvals.
          deps.pushRunUpdate?.(structuredClone(run));
          return run;
        }
        await executor.resume(rId);
        return runRepo.get(rId);
      },
      reviewSplitter: async (runId, blockId, review) => {
        const reviewer = loadSettings(dataDir).review.reviewer;
        return executor.reviewSplitter(
          z.string().startsWith("run_").parse(runId),
          z.string().min(1).parse(blockId),
          review,
          { type: "human", ...reviewer },
        );
      },
      filterReviewState: async (runId: string, blockId: string) => {
        await ready;
        const rId = parseArg(RunId, runId, "runId");
        const bId = parseArg(BlockId, blockId, "blockId");
        const source = await filterSource(rId, bId);
        try {
          return await filterRepo.get(source.workflowId, bId);
        } catch {
          throw new ReqflowError("storage_error", "Filter review state could not be read.");
        }
      },
      reviewFilter: async (runId: string, blockId: string, reviewInput: unknown) => {
        await ready;
        const rId = parseArg(RunId, runId, "runId");
        const bId = parseArg(BlockId, blockId, "blockId");
        const review = parseArg(FilterReview, reviewInput, "review");
        const source = await filterSource(rId, bId);

        const reviewer = loadSettings(dataDir).review.reviewer;
        const actor = {
          type: "human" as const,
          userId: reviewer.userId,
          name: reviewer.name,
          role: reviewer.role,
        };

        try {
          // Resume reserves the executor synchronously, even before its status reaches SQLite.
          if (executor.isRunActive(rId) || restoring.has(rId))
            throw new ReqflowError(
              "invalid_state",
              "Filter review requires a stopped or HIL-paused run.",
            );
          return await filterRepo.restore(source.workflowId, bId, source.report, review, actor);
        } catch (error) {
          if (error instanceof FilterOverrideConflictError) {
            throw new ReqflowError("conflict", error.message);
          }
          if (error instanceof ReqflowError) {
            throw error;
          }
          if (error instanceof z.ZodError) {
            throw new ReqflowError("invalid_input", "Input failed validation", error.issues);
          }
          if (error instanceof FilterOverrideValidationError)
            throw new ReqflowError("invalid_input", error.message);
          if (error instanceof FilterOverrideStateError)
            throw new ReqflowError("invalid_state", error.message);
          throw new ReqflowError("storage_error", "Failed to restore filter items");
        }
      },
      cancel: async (runId: string) => {
        const rId = RunId.parse(runId);
        const run = await runRepo.get(rId);
        if (["completed", "failed", "cancelled"].includes(run.status)) return run;
        await restore(rId);
        await executor.cancel(rId);
        return runRepo.get(rId);
      },
    },
    requirements: {
      list: async (filter?: RequirementFilter) => {
        const validFilter = RequirementFilterSchema.parse(filter);
        return await reqRepo.list(validFilter);
      },
      get: async (id: string) => {
        const reqId = z.string().min(1).parse(id);
        try {
          return await reqRepo.get(reqId);
        } catch {
          throw new ReqflowError("not_found", `Requirement not found: ${reqId}`);
        }
      },
      edit: async (id: string, edit: unknown) => {
        const reqId = z.string().min(1).parse(id);
        const validEdit = RequirementEdit.parse(edit);
        let detail;
        try {
          detail = await reqRepo.get(reqId);
        } catch {
          throw new ReqflowError("not_found", `Requirement not found: ${reqId}`);
        }
        const current = detail.requirement;
        const settings = loadSettings(dataDir);

        const changes: FieldChange[] = [];
        const updatedFields: Partial<Requirement> = {};

        for (const [key, val] of Object.entries(validEdit)) {
          if (key === "rationale" || val === undefined) continue;
          const currentVal = (current as Record<string, unknown>)[key];
          if (JSON.stringify(currentVal) !== JSON.stringify(val)) {
            changes.push({ path: key, before: currentVal, after: val });
            (updatedFields as Record<string, unknown>)[key] = val;
          }
        }
        if (!changes.length) throw new ReqflowError("invalid_input", "The edit changes nothing.");

        // Linked findings must exist; the sources follow the supporting findings' evidence.
        const linked = [
          ...(updatedFields.findingIds ?? []),
          ...(updatedFields.conflictingFindingIds ?? []),
        ];
        if (linked.length) {
          const found = new Map((await reqRepo.findingsByIds(linked)).map((f) => [f.id, f]));
          const missing = [...new Set(linked.filter((fid) => !found.has(fid)))];
          if (missing.length)
            throw new ReqflowError(
              "invalid_input",
              `These findings don't exist, so they can't be linked: ${missing.join(", ")}.`,
            );
          if (updatedFields.findingIds) {
            const sourceIds = [
              ...new Set(
                updatedFields.findingIds.flatMap((fid) =>
                  found.get(fid)!.evidence.map((e) => e.sourceId),
                ),
              ),
            ];
            if (JSON.stringify(sourceIds) !== JSON.stringify(current.sourceIds)) {
              changes.push({ path: "sourceIds", before: current.sourceIds, after: sourceIds });
              updatedFields.sourceIds = sourceIds;
            }
          }
        }

        let rationale = validEdit.rationale;
        if (current.status === "approved") {
          // The approval covered the earlier content; the changed requirement needs a new decision.
          changes.push({ path: "status", before: current.status, after: "in_review" });
          updatedFields.status = "in_review";
          rationale += " (Edited after approval, so it is back in review.)";
        }

        const newVersion = {
          ...current,
          ...updatedFields,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
        };

        return commitRequirement(newVersion, current.version, [
          {
            actor: {
              type: "human",
              userId: settings.review.reviewer.userId,
              name: settings.review.reviewer.name,
              role: settings.review.reviewer.role,
            },
            action: "requirement.edited",
            entityType: "requirement",
            entityId: reqId,
            runId: current.runId,
            rationale,
            changes,
          },
        ]);
      },
      decide: async (id: string, decisionInput: unknown) => {
        const reqId = z.string().min(1).parse(id);
        const decision = RequirementDecision.parse(decisionInput);
        let detail;
        try {
          detail = await reqRepo.get(reqId);
        } catch {
          throw new ReqflowError("not_found", `Requirement not found: ${reqId}`);
        }
        const current = detail.requirement;
        const problem = decisionProblem(current.status, decision.decision);
        if (problem) throw new ReqflowError("invalid_state", problem);
        const settings = loadSettings(dataDir);

        if (decision.decision === "challenge") {
          const challengeEvent: AuditEventInput = {
            actor: {
              type: "human",
              userId: settings.review.reviewer.userId,
              name: settings.review.reviewer.name,
              role: settings.review.reviewer.role,
            },
            action: "requirement.challenged",
            entityType: "requirement",
            entityId: reqId,
            runId: current.runId,
            rationale: decision.rationale,
            // This records the human request, not a fictitious persisted intermediate status.
            changes: [],
          };

          const prompt = `Evaluate PM challenge on requirement ${current.id}: "${decision.rationale}".`;
          let answer = "Challenge could not be answered. No findings or targets were re-verified.";
          let answerModel = settings.llm.model;
          try {
            const resp = z
              .object({ text: z.string(), model: z.string().min(1) })
              .parse(await (await configuredLlm(settings)).generateText({ prompt }));
            answer = resp.text;
            answerModel = resp.model;
          } catch {
            // fallback
          }

          const updatedReq = {
            ...current,
            status: "in_review" as const,
            uncertainties: Array.from(
              new Set([...current.uncertainties, `PM Challenge noted: ${decision.rationale}`]),
            ),
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
          };

          // The repository revalidates the originally read version atomically after
          // the LLM await. Neither a newer human decision nor deletion can be undone.
          // Both challenge events commit with the version, or none of them do.
          return commitRequirement(updatedReq, current.version, [
            challengeEvent,
            {
              actor: { type: "ai", component: "requirements.challenge", model: answerModel },
              action: "requirement.challenge_answered",
              entityType: "requirement",
              entityId: reqId,
              runId: current.runId,
              rationale: answer,
              changes: [
                { path: "status", before: current.status, after: "in_review" },
                {
                  path: "uncertainties",
                  before: current.uncertainties,
                  after: updatedReq.uncertainties,
                },
              ],
            },
          ]);
        }

        const { reviewer } = settings.review;
        const event = (
          action: AuditAction,
          rationale: string,
          changes: FieldChange[],
        ): AuditEventInput => ({
          actor: {
            type: "human",
            userId: reviewer.userId,
            name: reviewer.name,
            role: reviewer.role,
          },
          action,
          entityType: "requirement",
          entityId: reqId,
          runId: current.runId,
          rationale,
          changes,
        });
        const updatedReq: Requirement = {
          ...current,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
        };
        // A PM priority override (approve only) is its own audited change, before the decision.
        const events: AuditEventInput[] = [];
        const override =
          decision.priority !== undefined && decision.priority !== current.priority
            ? decision.priority
            : undefined;
        if (override) {
          updatedReq.priority = override;
          updatedReq.priorityRationale = `PM override: ${current.priority ?? "none"} → ${override}. ${decision.rationale}`;
          events.push(
            event("requirement.prioritized", decision.rationale, [
              { path: "priority", before: current.priority ?? null, after: override },
              {
                path: "priorityRationale",
                before: current.priorityRationale ?? null,
                after: updatedReq.priorityRationale,
              },
            ]),
          );
        }

        let rationale = decision.rationale;
        if (decision.decision === "approve" && settings.collaboration.requireSecondApproval) {
          const history = await auditLogger.list({ entityType: "requirement", entityId: reqId });
          const last = history.filter((e) => FOUR_EYES_ACTIONS.has(e.action)).at(-1);
          const first =
            last?.action === "requirement.approval_recorded" && last.actor.type === "human"
              ? last.actor
              : undefined;
          if (first?.userId === reviewer.userId)
            throw new ReqflowError(
              "invalid_state",
              `Four-eyes rule: ${first.name} already approved; a different reviewer must give the second approval (Settings → Collaboration → your name).`,
            );
          // An override changes what the first reviewer approved, so it starts the count again.
          if (!first || override) {
            updatedReq.status = "in_review";
            const changes: FieldChange[] =
              current.status === "in_review"
                ? []
                : [{ path: "status", before: current.status, after: "in_review" }];
            changes.push({ path: "approvals", before: [], after: [reviewer.userId] });
            return commitRequirement(updatedReq, current.version, [
              ...events,
              event(
                "requirement.approval_recorded",
                `${decision.rationale} (First approval under the four-eyes rule; a different reviewer must approve too.)`,
                changes,
              ),
            ]);
          }
          rationale = `${decision.rationale} (Second approval after ${first.name}; four-eyes rule.)`;
        }

        const targetStatus = DECISION_TO_STATUS[decision.decision];
        updatedReq.status = targetStatus;
        return commitRequirement(updatedReq, current.version, [
          ...events,
          event("requirement.status_changed", rationale, [
            { path: "status", before: current.status, after: targetStatus },
          ]),
        ]);
      },
      reset: async () => {
        const { reviewer } = loadSettings(dataDir).review;
        const expected = await reqRepo.list();
        const events: AuditEventInput[] = expected.map((r) =>
          requirementAudit({
            actor: {
              type: "human",
              userId: reviewer.userId,
              name: reviewer.name,
              role: reviewer.role,
            },
            action: "requirement.deleted",
            entityType: "requirement",
            entityId: r.id,
            runId: r.runId,
            rationale: "Removed with Reset on the Car page.",
            changes: [{ path: "status", before: r.status, after: null }],
          }),
        );
        const removed = requirementMutation(() => reqRepo.removeAllWithAudit(expected, events));
        return { removed: removed.length };
      },
    },
    audit: {
      list: async (filter?: unknown) => {
        const validFilter = AuditFilterSchema.parse(filter);
        return await auditLogger.list(validFilter);
      },
    },
    settings: {
      get: async () => loadSettings(dataDir),
      save: async (settingsInput) => {
        const validated = Settings.parse(settingsInput);
        // The Settings page edits only the reviewer's name. A new name under the old id is someone
        // else, so it gets its own id: the four-eyes rule and HIL approvals tell reviewers apart by id.
        const previousReviewer = loadSettings(dataDir).review.reviewer;
        const reviewer = validated.review.reviewer;
        if (
          reviewer.name.trim() !== previousReviewer.name.trim() &&
          reviewer.userId === previousReviewer.userId
        )
          reviewer.userId = reviewerIdFor(reviewer.name) ?? reviewer.userId;
        const scoringChanged = (s: Settings) =>
          JSON.stringify(s.scoring) !== JSON.stringify(validated.scoring);
        // Read the requirements before the old settings: from there on nothing yields until the
        // settings file and the rescored requirement versions are both written, or neither is.
        const requirements = scoringChanged(loadSettings(dataDir)) ? await reqRepo.list() : [];
        const oldSettings = loadSettings(dataDir);
        // Dedicated configure owns access flags; a stale autosave cannot undo revocation.
        validated.research.apis = structuredClone(oldSettings.research.apis);
        let rescored: ReturnType<typeof rescoredVersions> = [];
        if (scoringChanged(oldSettings)) {
          try {
            rescored = rescoredVersions(
              requirements,
              validated.scoring,
              validated.review.reviewer.name,
            );
          } catch (error) {
            throw new ReqflowError(
              "invalid_input",
              `Settings were not saved: ${error instanceof Error ? error.message : "the new scoring can't score requirements"}.`,
            );
          }
        }
        const saved = saveSettings(dataDir, validated);
        if (rescored.length) {
          // All requirements are rescored together, or the previous settings come back.
          db.exec("SAVEPOINT settings_rescore");
          try {
            for (const { next, event } of rescored)
              commitRequirement(next, next.version - 1, [event]);
            db.exec("RELEASE settings_rescore");
          } catch {
            db.exec("ROLLBACK TO settings_rescore; RELEASE settings_rescore");
            try {
              saveSettings(dataDir, oldSettings);
            } catch {
              throw new ReqflowError(
                "storage_error",
                "Requirements could not be rescored, and the previous settings could not be restored.",
              );
            }
            throw new ReqflowError(
              "storage_error",
              "Settings were not saved: requirements could not be rescored.",
            );
          }
        }
        research.settingsChanged(oldSettings, saved);
        const changes: FieldChange[] = [];

        for (const key of Object.keys(saved) as (keyof Settings)[]) {
          if (JSON.stringify(oldSettings[key]) !== JSON.stringify(saved[key])) {
            changes.push({ path: key, before: oldSettings[key], after: saved[key] });
          }
        }
        const oldSetups = oldSettings.agents?.setups || [];
        const newSetups = saved.agents?.setups || [];
        const newSetupIds = new Set(newSetups.map((s) => s.id));
        for (const oldSetup of oldSetups) {
          if (!newSetupIds.has(oldSetup.id)) {
            try {
              await secretsStore.setSecret(`setup:${oldSetup.id}` as SetupSecretName, null);
            } catch (err) {
              console.warn(`Failed to delete secret for removed API setup: ${err}`);
            }
          }
        }

        if (changes.length > 0) {
          await auditLogger.record({
            actor: {
              type: "human",
              userId: saved.review.reviewer.userId,
              name: saved.review.reviewer.name,
              role: saved.review.reviewer.role,
            },
            action: "settings.changed",
            entityType: "settings",
            entityId: "default",
            rationale: "Settings updated via Settings page",
            changes,
          });
        }

        return saved;
      },
      secrets: async () => secretsStore.getStatus(),
      setSecret: async (nameInput: unknown, valueInput: unknown) => {
        const name = parseArg(SecretNameSchema, nameInput, "secret name");
        const value = z.string().nullable().parse(valueInput);
        await secretsStore.setSecret(name, value);
        if (value) sensitive.add(value);
        if (SecretName.safeParse(name).success) research.invalidateSecret(name as SecretName);
        await auditLogger.record({
          actor: { type: "human", ...loadSettings(dataDir).review.reviewer },
          action: "settings.changed",
          entityType: "settings",
          entityId: `credential:${name}`,
          rationale:
            value === null
              ? "Credential removed."
              : "Credential stored using OS-backed encryption.",
        });
        return await secretsStore.getStatus();
      },
      testSetup: async (setupIdInput: unknown) => {
        const setupId = parseArg(NonEmptySchema, setupIdInput, "setupId");
        return await testSetup(loadSettings(dataDir), setupId, agentDeps);
      },
    },
    reasoning: {
      forRun: async (runIdInput: unknown, blockIdInput: unknown) => {
        const runId = parseArg(RunIdSchema, runIdInput, "runId");
        const blockId = parseArg(NonEmptySchema, blockIdInput, "blockId");
        return await reasoningRepo.forRun(runId, blockId);
      },
      latest: async (workflowIdInput: unknown, blockIdInput: unknown) => {
        const workflowId = parseArg(WorkflowIdSchema, workflowIdInput, "workflowId");
        const blockId = parseArg(NonEmptySchema, blockIdInput, "blockId");
        return await reasoningRepo.latest(workflowId, blockId);
      },
      forRequirement: async (requirementIdInput: unknown) => {
        const reqId = parseArg(NonEmptySchema, requirementIdInput, "requirementId");
        return await reasoningRepo.forRequirement(reqId);
      },
    },
    research: research.handlers,
    exports: {
      research: research.export,
      requirements: async (optsInput: unknown) => {
        const opts = ExportRequirementsSchema.parse(optsInput);
        const reqs = await reqRepo.list(opts.runId ? { runId: opts.runId } : undefined);
        const currentSettings = loadSettings(dataDir);
        // Each requirement with its findings, sources and records, so the file stands on its own.
        const items: RequirementExport[] = [];
        for (const req of reqs) {
          try {
            items.push(await reqRepo.get(req.id));
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("Requirement not found"))
              throw new ReqflowError(
                "conflict",
                `Requirement ${req.id} was removed during the export; export again.`,
              );
            throw new ReqflowError(
              "storage_error",
              `Requirement ${req.id} could not be read for the export.`,
            );
          }
        }

        let content: string;
        if (opts.format === "csv") {
          content = formatRequirementsCsv(items);
        } else if (opts.format === "md") {
          content = formatRequirementsMarkdown(
            items,
            `BMW ${currentSettings.defaultScope.vehicleLine} Requirements`,
          );
        } else {
          content = formatRequirementsJson(items);
        }

        const saveFn = deps.saveDialog ?? showElectronSaveDialog;
        const res = await saveFn({
          title: "Export Requirements",
          defaultPath: `bmw_requirements_${opts.runId ?? "all"}.${opts.format}`,
          filters: [
            { name: opts.format.toUpperCase(), extensions: [opts.format] },
            { name: "All Files", extensions: ["*"] },
          ],
        });

        if (res.canceled || !res.filePath) {
          return null;
        }

        await writeFile(res.filePath, content, "utf8");

        await auditLogger.record({
          actor: {
            type: "human",
            userId: currentSettings.review.reviewer.userId,
            name: currentSettings.review.reviewer.name,
            role: currentSettings.review.reviewer.role,
          },
          action: "export.created",
          entityType: "export",
          entityId: basename(res.filePath),
          runId: opts.runId,
          rationale: `Exported ${items.length} requirements as ${opts.format}`,
        });

        return { path: res.filePath };
      },
      hilReport: async (reqInput: unknown) => {
        return exportHilReportPdf(reqInput, deps.saveDialog);
      },
    },
  };
  // Every namespace waits for migration, without exporting another mutable application store.
  for (const namespace of Object.values(handlers)) {
    for (const [name, method] of Object.entries(namespace)) {
      (namespace as Record<string, (...args: unknown[]) => Promise<unknown>>)[name] = async (
        ...args
      ) => {
        await ready;
        return (method as (...args: unknown[]) => Promise<unknown>)(...args);
      };
    }
  }
  return handlers;
}
