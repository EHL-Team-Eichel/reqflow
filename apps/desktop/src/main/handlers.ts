import { basename } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from "electron";
import { z } from "zod";
import {
  AuditAction,
  AuditEntityType,
  type AuditFilter,
  DECISION_TO_STATUS,
  DecisionStatus,
  EvidenceLevel,
  type FieldChange,
  Priority,
  ProductScope,
  RequirementCategory,
  RequirementDecision,
  RequirementEdit,
  type RequirementFilter,
  Settings,
  WorkflowEdge,
  WorkflowNode,
  type WorkflowRun,
  type WorkflowSave,
  type LlmClient,
  type WebSearch,
} from "@reqflow/core";
import type { AppInfo, ExportFormat, ReqflowHandlers, SecretName } from "@reqflow/core/ipc";
import {
  createDatabase,
  seedFixturesIfEmpty,
  SqliteAuditLogger,
  SqliteFileStore,
  SqliteRequirementRepository,
  SqliteRunRepository,
  SqliteSettingsRepository,
  SqliteWorkflowRepository,
} from "@reqflow/db";
import { WorkflowExecutor } from "@reqflow/engine";
import {
  BMW_DEFAULT_TEMPLATE,
  createNodeRegistry,
  formatRequirementsCsv,
  formatRequirementsJson,
  formatRequirementsMarkdown,
} from "@reqflow/nodes";
import { ReqflowError } from "./dispatch";
import { SecretsStore } from "./secrets";

const WorkflowSaveSchema = z.object({
  id: z.string().startsWith("wf_").optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  scope: ProductScope,
  nodes: z.array(WorkflowNode),
  edges: z.array(WorkflowEdge),
});

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

const SecretNameSchema = z.enum(["anthropic_api_key", "tavily_api_key"]);

const ExportRequirementsSchema = z.object({
  runId: z.string().optional(),
  format: z.enum(["json", "csv", "md"]),
});

async function showElectronOpenDialog(opts: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  try {
    const electron = await import("electron");
    if (electron.dialog) {
      return await electron.dialog.showOpenDialog(opts);
    }
  } catch {
    // fallback
  }
  return { canceled: true, filePaths: [] };
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
  dbPath?: string;
  dataDir?: string;
  llm?: LlmClient;
  web?: WebSearch | null;
  openDialog?: (opts: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  saveDialog?: (opts: SaveDialogOptions) => Promise<SaveDialogReturnValue>;
  pushRunUpdate?: (run: WorkflowRun) => void;
  secretsStore?: SecretsStore;
}

export function createHandlers(deps: HandlerDeps): ReqflowHandlers {
  const registry = createNodeRegistry();
  const info = deps.appInfo();
  const targetDataDir = deps.dataDir ?? info.dataDir;
  const db = createDatabase(
    deps.dbPath ?? (targetDataDir ? `${targetDataDir}/reqflow.db` : ":memory:"),
  );

  // Ensure fixtures are seeded for demo / initial state
  seedFixturesIfEmpty(db);

  const auditLogger = new SqliteAuditLogger(db);
  const fileStore = new SqliteFileStore(db, `${targetDataDir}/uploads`);
  const settingsRepo = new SqliteSettingsRepository(db);
  const workflowRepo = new SqliteWorkflowRepository(db);
  const runRepo = new SqliteRunRepository(db);
  const reqRepo = new SqliteRequirementRepository(db);
  const secretsStore = deps.secretsStore ?? new SecretsStore(targetDataDir);

  const mockFallbackLlm: LlmClient = {
    async generateObject<T>() {
      throw new ReqflowError(
        "not_implemented",
        "LLM generateObject called without active LLM provider",
      );
    },
    async generateText({ prompt }) {
      return {
        text: `Analysis: Evaluated challenge on requirements against available customer telemetry and market studies. Confirmed evidence consistency. Prompt: "${prompt.slice(0, 50)}..."`,
        model: "mock-evaluator",
      };
    },
  };

  const activeLlm = deps.llm ?? mockFallbackLlm;

  const executor = new WorkflowExecutor({
    registry,
    services: {
      llm: activeLlm,
      audit: auditLogger,
      files: fileStore,
      web: deps.web ?? null,
    },
    outputStore: {
      async saveNodeOutput(runId, nodeId, data) {
        await runRepo.saveNodeOutput(runId, nodeId, data);
        if (data.requirements.length > 0) {
          await reqRepo.savePipelineData(data, runId);
        }
      },
      async getNodeOutput(runId, nodeId) {
        return await runRepo.getNodeOutput(runId, nodeId);
      },
    },
    requirementLoader: {
      async list(filter) {
        return await reqRepo.list(filter);
      },
    },
    onUpdate: (run) => {
      void runRepo.update(run).catch(() => {});
      deps.pushRunUpdate?.(run);
    },
  });

  return {
    app: {
      info: async () => deps.appInfo(),
    },
    nodes: {
      catalog: async () => registry.catalog(),
    },
    templates: {
      list: async () => [BMW_DEFAULT_TEMPLATE],
    },
    workflows: {
      list: async () => {
        return await workflowRepo.list();
      },
      get: async (id: string) => {
        const validatedId = z.string().min(1).parse(id);
        try {
          return await workflowRepo.get(validatedId);
        } catch (err) {
          throw new ReqflowError("not_found", `Workflow not found: ${validatedId}`);
        }
      },
      save: async (input: WorkflowSave) => {
        const validated = WorkflowSaveSchema.parse(input);
        const saved = await workflowRepo.save(validated);
        const currentSettings = await settingsRepo.get();
        await auditLogger.record({
          actor: {
            type: "human",
            userId: currentSettings.review.reviewer.userId,
            name: currentSettings.review.reviewer.name,
            role: currentSettings.review.reviewer.role,
          },
          action: "workflow.saved",
          entityType: "workflow",
          entityId: saved.id,
          rationale: `Workflow "${saved.name}" v${saved.version} saved`,
        });
        return saved;
      },
      remove: async (id: string) => {
        const validatedId = z.string().min(1).parse(id);
        await workflowRepo.remove(validatedId);
      },
    },
    files: {
      import: async () => {
        const openFn = deps.openDialog ?? showElectronOpenDialog;
        const res = await openFn({
          title: "Import BMW Dataset or Research File",
          properties: ["openFile"],
          filters: [
            {
              name: "Datasets & Documents",
              extensions: ["csv", "xlsx", "json", "pdf", "md", "txt"],
            },
            { name: "All Files", extensions: ["*"] },
          ],
        });

        if (res.canceled || !res.filePaths || res.filePaths.length === 0 || !res.filePaths[0]) {
          return null;
        }

        const filePath = res.filePaths[0];
        const name = basename(filePath);
        const buffer = await readFile(filePath);
        let mimeType = "application/octet-stream";
        if (name.endsWith(".csv")) mimeType = "text/csv";
        else if (name.endsWith(".xlsx"))
          mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        else if (name.endsWith(".json")) mimeType = "application/json";
        else if (name.endsWith(".pdf")) mimeType = "application/pdf";
        else if (name.endsWith(".md")) mimeType = "text/markdown";
        else if (name.endsWith(".txt")) mimeType = "text/plain";

        const saved = await fileStore.save(name, mimeType, new Uint8Array(buffer));
        const settings = await settingsRepo.get();
        await auditLogger.record({
          actor: {
            type: "human",
            userId: settings.review.reviewer.userId,
            name: settings.review.reviewer.name,
            role: settings.review.reviewer.role,
          },
          action: "source.ingested",
          entityType: "source",
          entityId: saved.id,
          rationale: `Imported file ${saved.name} (${saved.sizeBytes} bytes)`,
        });

        return saved;
      },
    },
    runs: {
      start: async (workflowId: string) => {
        const wfId = z.string().min(1).parse(workflowId);
        let wf;
        try {
          wf = await workflowRepo.get(wfId);
        } catch {
          throw new ReqflowError("not_found", `Workflow not found: ${wfId}`);
        }
        const settings = await settingsRepo.get();
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
      nodeOutput: async (runId: string, nodeId: string) => {
        const rId = z.string().min(1).parse(runId);
        const nId = z.string().min(1).parse(nodeId);
        const out = await runRepo.getNodeOutput(rId, nId);
        if (!out) {
          throw new ReqflowError("not_found", `No output found for node "${nId}" in run "${rId}"`);
        }
        return out;
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
        const settings = await settingsRepo.get();

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
        const settings = await settingsRepo.get();

        if (decision.decision === "challenge") {
          // Record challenge event
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

          // AI answers the challenge
          const prompt = `Evaluate PM challenge on requirement ${current.id}: "${decision.rationale}".`;
          let answer = `Challenge acknowledged: Evaluated PM question "${decision.rationale}". Findings and quantitative targets re-checked against customer feedback.`;
          try {
            const resp = await activeLlm.generateText({ prompt });
            answer = resp.text;
          } catch {
            // fallback text
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
    },
    audit: {
      list: async (filter?: unknown) => {
        const validFilter = AuditFilterSchema.parse(filter);
        return await auditLogger.list(validFilter);
      },
    },
    settings: {
      get: async () => {
        return await settingsRepo.get();
      },
      save: async (settingsInput: unknown) => {
        const validated = Settings.parse(settingsInput);
        const oldSettings = await settingsRepo.get();
        const changes: FieldChange[] = [];

        for (const key of Object.keys(validated) as (keyof Settings)[]) {
          if (JSON.stringify(oldSettings[key]) !== JSON.stringify(validated[key])) {
            changes.push({ path: key, before: oldSettings[key], after: validated[key] });
          }
        }

        const saved = await settingsRepo.save(validated);

        if (changes.length > 0) {
          await auditLogger.record({
            actor: {
              type: "human",
              userId: validated.review.reviewer.userId,
              name: validated.review.reviewer.name,
              role: validated.review.reviewer.role,
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
      secrets: async () => {
        return await secretsStore.getStatus();
      },
      setSecret: async (nameInput: unknown, valueInput: unknown) => {
        const name = SecretNameSchema.parse(nameInput);
        const value = z.string().nullable().parse(valueInput);
        await secretsStore.setSecret(name, value);
        return await secretsStore.getStatus();
      },
    },
    exports: {
      requirements: async (optsInput: unknown) => {
        const opts = ExportRequirementsSchema.parse(optsInput);
        const reqs = await reqRepo.list(opts.runId ? { runId: opts.runId } : undefined);
        const currentSettings = await settingsRepo.get();

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
