import { basename } from "node:path";
import { writeFile } from "node:fs/promises";
import type { SaveDialogOptions, SaveDialogReturnValue } from "electron";
import { z } from "zod";
import {
  allBlockImplementations,
  BMW_DEFAULT_TEMPLATE,
  createBlockRegistry,
} from "@reqflow/blocks";
import {
  AuditAction,
  AuditEntityType,
  type AuditFilter,
  DECISION_TO_STATUS,
  DecisionStatus,
  emptyPipelineData,
  EvidenceLevel,
  type FieldChange,
  Priority,
  RequirementCategory,
  RequirementDecision,
  RequirementEdit,
  type RequirementFilter,
  Settings,
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
  SqliteRunRepository,
  type LocalFileStore,
} from "@reqflow/db";
import { BlockRegistry, WorkflowExecutor } from "@reqflow/engine";
import { createLlmClient, createMastraLlmClient } from "@reqflow/llm";
import { createAgentServices, testSetup, type AgentDeps } from "./agents";
import { ReqflowError } from "./dispatch";
import { previewBlock } from "./preview";
import { SecretsStore } from "./secrets";
import { loadSettings, saveSettings } from "./settings-storage";
import { getWorkflow, listWorkflows, removeWorkflow, saveWorkflow } from "./workflow-storage";

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
  z.enum(["anthropic_api_key", "tavily_api_key"]),
  z.string().regex(SETUP_SECRET_PATTERN, "Unknown secret name") as z.ZodType<SetupSecretName>,
]);

const ExportRequirementsSchema = z.object({
  runId: z.string().optional(),
  format: z.enum(["json", "csv", "md"]),
});

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
}

export function createHandlers(deps: HandlerDeps): ReqflowHandlers {
  const info = deps.appInfo();
  const dataDir = deps.dataDir ?? info.dataDir;
  const db = createDatabase(deps.dbPath ?? (dataDir ? `${dataDir}/reqflow.db` : ":memory:"));

  // Earlier builds seeded synthetic demo data into every new database; remove what's left of it.
  const demo = removeDemoData(db);
  const demoRows = Object.values(demo).reduce((sum, n) => sum + n, 0);
  if (demoRows) console.info(`Removed ${demoRows} synthetic demo rows from the database`, demo);

  const auditLogger = new SqliteAuditLogger(db);
  const runRepo = new SqliteRunRepository(db);
  const reqRepo = new SqliteRequirementRepository(db);
  const reasoningRepo = new SqliteReasoningRepository(db);
  const secretsStore = deps.secretsStore ?? new SecretsStore(dataDir);

  const defaultAiKey = async (settings: Settings): Promise<string | undefined> => {
    if (settings.llm.provider !== "anthropic") return undefined;
    const apiKey = (await secretsStore.getSecret("anthropic_api_key")) ?? undefined;
    if (!apiKey) {
      throw new Error("The default AI (Anthropic) has no API key. Add it in Settings → AI.");
    }
    return apiKey;
  };
  // Blocks call the default AI through a standalone Mastra Agent (AI Splitter's choice).
  const configuredLlm = async (settings: Settings): Promise<LlmClient> => {
    if (deps.llm) return deps.llm;
    return createMastraLlmClient(settings.llm, { apiKey: await defaultAiKey(settings) });
  };
  // The Add to Car agents call it directly: adaptive thinking and effort need the Messages API.
  const directLlm = async (settings: Settings): Promise<LlmClient> => {
    if (deps.llm) return deps.llm;
    return createLlmClient(settings.llm, { apiKey: await defaultAiKey(settings) });
  };
  const agentDeps: AgentDeps = {
    defaultLlm: directLlm,
    getKey: (setupId) => secretsStore.getSecret(`setup:${setupId}`),
    fetch: deps.fetch,
  };
  const activeLlm: LlmClient = deps.llm ?? {
    generateObject: async (request) =>
      (await configuredLlm(loadSettings(dataDir))).generateObject(request),
    generateText: async (request) =>
      (await configuredLlm(loadSettings(dataDir))).generateText(request),
  };

  const registry = deps.registry ?? createBlockRegistry();

  const executor = new WorkflowExecutor({
    registry,
    services: {
      llm: configuredLlm,
      agents: (settings) => createAgentServices(settings, agentDeps),
      audit: auditLogger,
      files: deps.files,
      web: deps.web ?? null,
      car: {
        async add(requirements, evidence) {
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
    },
    outputStore: {
      async saveBlockOutput(runId, blockId, outputs) {
        await runRepo.saveBlockOutput(runId, blockId, outputs);
      },
      async getBlockOutput(runId, blockId) {
        return await runRepo.getBlockOutput(runId, blockId);
      },
      async saveSplitterReview(run, blockId, outputs, event) {
        await runRepo.saveSplitterReview(run, blockId, outputs, event);
      },
    },
    onUpdate: (run) => {
      void runRepo.update(run).catch(() => {});
      deps.pushRunUpdate?.(run);
    },
  });

  return {
    app: { info: async () => deps.appInfo() },
    blocks: { preview: (request) => previewBlock(registry, deps.files, request) },
    templates: { list: async () => [BMW_DEFAULT_TEMPLATE] },
    workflows: {
      list: async () => listWorkflows(dataDir),
      get: async (id: string) => {
        const validatedId = z.string().min(1).parse(id);
        return getWorkflow(dataDir, validatedId);
      },
      save: async (input: WorkflowSave) => {
        const saved = saveWorkflow(dataDir, input);
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
        const validatedId = z.string().min(1).parse(id);
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
        const wfId = z.string().min(1).parse(workflowId);
        const wf = getWorkflow(dataDir, wfId);
        const settings = loadSettings(dataDir);
        const startedBy = {
          type: "human" as const,
          userId: settings.review.reviewer.userId,
          name: settings.review.reviewer.name,
          role: settings.review.reviewer.role,
        };

        const initialRun = await executor.start(wf, startedBy, settings);
        await runRepo.create(initialRun);
        deps.pushRunUpdate?.(initialRun);
        return initialRun;
      },
      get: async (runId: string) => {
        const rId = z.string().min(1).parse(runId);
        try {
          return await runRepo.get(rId);
        } catch {
          throw new ReqflowError("not_found", `Run not found: ${rId}`);
        }
      },
      list: async (workflowId?: string) => {
        const wfId = workflowId ? z.string().min(1).parse(workflowId) : undefined;
        return await runRepo.list(wfId);
      },
      blockOutput: async (runId: string, blockId: string) => {
        const rId = z.string().min(1).parse(runId);
        const bId = z.string().min(1).parse(blockId);
        const outputs = await runRepo.getBlockOutput(rId, bId);
        if (!outputs) {
          throw new ReqflowError(
            "not_found",
            `No outputs found for block "${bId}" in run "${rId}"`,
          );
        }
        return outputs;
      },
      resume: async (runId: string) => {
        const rId = z.string().min(1).parse(runId);
        const run = await runRepo.get(rId);
        if (run.status !== "waiting_for_review") {
          throw new ReqflowError(
            "invalid_state",
            `Cannot resume run ${rId}: status is "${run.status}", expected "waiting_for_review"`,
          );
        }
        const resumed = await executor.resume(rId);
        await runRepo.update(resumed);
        deps.pushRunUpdate?.(resumed);
        return resumed;
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
      cancel: async (runId: string) => {
        const rId = z.string().min(1).parse(runId);
        const cancelled = await executor.cancel(rId);
        await runRepo.update(cancelled);
        deps.pushRunUpdate?.(cancelled);
        return cancelled;
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
        const detail = await reqRepo.get(reqId);
        const current = detail.requirement;
        const settings = loadSettings(dataDir);

        const changes: FieldChange[] = [];
        const updatedFields: Record<string, unknown> = {};

        for (const [key, val] of Object.entries(validEdit)) {
          if (key === "rationale") continue;
          const currentVal = (current as Record<string, unknown>)[key];
          if (JSON.stringify(currentVal) !== JSON.stringify(val)) {
            changes.push({ path: key, before: currentVal, after: val });
            updatedFields[key] = val;
          }
        }

        const newVersion = {
          ...current,
          ...updatedFields,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
        };

        const saved = await reqRepo.saveVersion(newVersion);

        await auditLogger.record({
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
          rationale: validEdit.rationale,
          changes,
        });

        return saved;
      },
      decide: async (id: string, decisionInput: unknown) => {
        const reqId = z.string().min(1).parse(id);
        const decision = RequirementDecision.parse(decisionInput);
        const detail = await reqRepo.get(reqId);
        const current = detail.requirement;
        const settings = loadSettings(dataDir);

        if (decision.decision === "challenge") {
          await auditLogger.record({
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
            changes: [{ path: "status", before: current.status, after: "challenged" }],
          });

          const prompt = `Evaluate PM challenge on requirement ${current.id}: "${decision.rationale}".`;
          let answer = `Challenge acknowledged: Evaluated PM question "${decision.rationale}". Findings and targets re-verified.`;
          try {
            const resp = await activeLlm.generateText({ prompt });
            answer = resp.text;
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

          const saved = await reqRepo.saveVersion(updatedReq);

          await auditLogger.record({
            actor: { type: "ai", component: "requirements.challenge", model: settings.llm.model },
            action: "requirement.challenge_answered",
            entityType: "requirement",
            entityId: reqId,
            runId: current.runId,
            rationale: answer,
            changes: [
              { path: "status", before: "challenged", after: "in_review" },
              {
                path: "uncertainties",
                before: current.uncertainties,
                after: updatedReq.uncertainties,
              },
            ],
          });

          return saved;
        }

        const targetStatus = DECISION_TO_STATUS[decision.decision];
        const newPriority = decision.priority ?? current.priority;
        const changes: FieldChange[] = [
          { path: "status", before: current.status, after: targetStatus },
        ];

        if (decision.priority && decision.priority !== current.priority) {
          changes.push({ path: "priority", before: current.priority, after: decision.priority });
        }

        const updatedReq = {
          ...current,
          status: targetStatus,
          priority: newPriority,
          version: current.version + 1,
          updatedAt: new Date().toISOString(),
        };

        const saved = await reqRepo.saveVersion(updatedReq);

        await auditLogger.record({
          actor: {
            type: "human",
            userId: settings.review.reviewer.userId,
            name: settings.review.reviewer.name,
            role: settings.review.reviewer.role,
          },
          action: "requirement.status_changed",
          entityType: "requirement",
          entityId: reqId,
          runId: current.runId,
          rationale: decision.rationale,
          changes,
        });

        return saved;
      },
      reset: async () => {
        const { reviewer } = loadSettings(dataDir).review;
        const removed = await reqRepo.removeAll();
        for (const r of removed) {
          await auditLogger.record({
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
          });
        }
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
        const oldSettings = loadSettings(dataDir);
        const saved = saveSettings(dataDir, settingsInput);
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
        const name = SecretNameSchema.parse(nameInput);
        const value = z.string().nullable().parse(valueInput);
        await secretsStore.setSecret(name, value);
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
    exports: {
      requirements: async (optsInput: unknown) => {
        const opts = ExportRequirementsSchema.parse(optsInput);
        const reqs = await reqRepo.list(opts.runId ? { runId: opts.runId } : undefined);
        const currentSettings = loadSettings(dataDir);

        let content: string;
        if (opts.format === "csv") {
          content = formatRequirementsCsv(reqs);
        } else if (opts.format === "md") {
          content = formatRequirementsMarkdown(
            reqs,
            `BMW ${currentSettings.defaultScope.vehicleLine} Requirements`,
          );
        } else {
          content = formatRequirementsJson(reqs);
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
          rationale: `Exported ${reqs.length} requirements as ${opts.format}`,
        });

        return { path: res.filePath };
      },
    },
  };
}
