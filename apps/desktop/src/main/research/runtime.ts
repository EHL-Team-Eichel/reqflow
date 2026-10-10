import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AuditEvent,
  BlockId,
  ConnectionReport,
  PipelineData,
  ResearchDataset,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchProviderId,
  SECRET_NAMES,
  SecretName,
  Settings,
  Workflow,
  WorkflowRun,
  validateGraph,
  walkBlocks,
  type AuditEventInput,
  type ResearchProviderStatus,
} from "@reqflow/core";
import type { AuditFilter, ReqflowHandlers, StoredFileInfo } from "@reqflow/core/ipc";
import { BlockRegistry, executeWorkflow, type BlockContext } from "@reqflow/engine";
import {
  allBlockImplementations,
  RESEARCH_AGENTS,
  PROVIDER_SECRETS,
  createLocalDocumentReader,
  createProviderHttp,
  createResearchAdapters,
  createResearchCollector,
  exportResearchCsv,
  exportResearchJson,
  exportResearchXlsx,
  mergeResearchDatasets,
  ProviderError,
  redactSecrets,
} from "@reqflow/blocks";
import { ReqflowError } from "../dispatch";
import { SecretStore, type SecureStorage } from "./secrets";
import { ResearchStore, validRun } from "./storage";

type ResearchHandlers = Pick<
  ReqflowHandlers,
  "settings" | "workflows" | "runs" | "research" | "files" | "audit"
> & { exports: Pick<ReqflowHandlers["exports"], "research"> };
export interface RuntimeDeps {
  dir: string;
  secureStorage: SecureStorage;
  platform?: NodeJS.Platform;
  chooseImport(): Promise<string | null>;
  chooseExport(format: "json" | "xlsx" | "csv", runId: string): Promise<string | null>;
  publish(run: WorkflowRun): void;
  fetchImpl?: typeof fetch;
  xlsxWorkerPath?: string;
}
const FileInfo = z.object({
  id: z.string().regex(/^file_[A-Za-z0-9_-]+$/),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().nonnegative(),
  importedAt: z.iso.datetime(),
  extension: z.enum([".xlsx", ".txt", ".pdf", ".docx", ".pptx"]),
});
const FILE_TYPES: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export async function createResearchRuntime(
  deps: RuntimeDeps,
): Promise<{ handlers: ResearchHandlers; shutdown(): Promise<void> }> {
  const store = new ResearchStore(deps.dir);
  const secrets = new SecretStore(deps.dir, deps.secureStorage, deps.platform);
  await store.load();
  await secrets.load();
  const registry = new BlockRegistry();
  for (const implementation of allBlockImplementations) registry.register(implementation);
  const adapters = createResearchAdapters();
  const reports = new Map<ResearchProviderId, ConnectionReport>();
  const versions = new Map<ResearchProviderId, number>();
  const jobs = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<unknown>;
      outputs: Record<string, Record<string, PipelineData>>;
    }
  >();
  const tests = new Map<ResearchProviderId, Promise<ResearchProviderStatus>>();
  const startingWorkflows = new Set<string>();
  const launchingRuns = new Set<string>();
  const resumingRuns = new Set<string>();
  const fileQueue = { promise: Promise.resolve() as Promise<unknown> };
  const clone = <T>(value: T): T => structuredClone(value);
  const actor = () => ({ type: "human" as const, ...store.state.settings.review.reviewer });
  const credentials = () =>
    Object.fromEntries(SECRET_NAMES.map((name) => [name, secrets.get(name)]));
  const configured = (id: ResearchProviderId) => {
    const status = secrets.status();
    return Object.fromEntries(PROVIDER_SECRETS[id].map((name) => [name, status[name].configured]));
  };
  function status(id: ResearchProviderId): ResearchProviderStatus {
    const flags = configured(id);
    const required = id === "openalex" ? [] : PROVIDER_SECRETS[id];
    return {
      id,
      config: clone(store.state.settings.research.apis[id]),
      credentialsConfigured: flags,
      connection: reports.get(id) ?? {
        state: required.some((key) => !flags[key]) ? "not_configured" : "untested",
        message: required.some((key) => !flags[key])
          ? "Required credentials are missing."
          : "Configured but not tested. No provider request has been made.",
        capabilities: [],
        limitations: [],
      },
    };
  }
  function invalidate(id: ResearchProviderId): void {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    reports.delete(id);
  }
  const audit = async (input: AuditEventInput) => {
    const event = AuditEvent.parse({
      ...input,
      id: `aud_${randomUUID()}`,
      at: new Date().toISOString(),
      changes: input.changes ?? [],
    });
    await store.audit(event);
    return event;
  };
  const resolveFile = async (id: string) => {
    FileInfo.shape.id.parse(id);
    const list = await store.read("files.json", z.array(FileInfo));
    const entry = list.find((file) => file.id === id);
    if (!entry) throw new ReqflowError("not_found", "Imported document is not available.");
    return {
      path: join(deps.dir, "uploads", `${entry.id}${entry.extension}`),
      name: entry.name,
      entry,
    };
  };
  const documents = createLocalDocumentReader({ resolveFile, xlsxWorkerPath: deps.xlsxWorkerPath });
  const getRun = (id: string) => {
    validRun(id);
    const run = store.state.runs.find((value) => value.id === id);
    if (!run) throw new ReqflowError("not_found", "Workflow run not found.");
    return run;
  };
  function publish(run: WorkflowRun): void {
    deps.publish(clone(run));
  }
  async function launch(
    input: WorkflowRun,
    outputs: Record<string, Record<string, PipelineData>>,
  ): Promise<WorkflowRun> {
    if (jobs.has(input.id) || launchingRuns.has(input.id))
      throw new ReqflowError("run_busy", "Run is already active.");
    launchingRuns.add(input.id);
    try {
      if (getRun(input.id).status === "cancelled") return clone(getRun(input.id));
      const snapshot = Settings.parse(clone(store.state.settings));
      const keys = credentials();
      const secretValues = Object.values(keys).filter((s): s is string => !!s);
      const safe = (message: string) => redactSecrets(message, secretValues);
      const controller = new AbortController();
      const datasets = new Map<string, ResearchDataset>();
      try {
        datasets.set("previous", await store.dataset(input.id));
      } catch (error) {
        if (!(error instanceof ReqflowError) || error.code !== "not_found") throw error;
      }
      if (getRun(input.id).status === "cancelled") return clone(getRun(input.id));
      const localCache = new Map<string, Promise<import("@reqflow/core").CollectedItem[]>>();
      const cachedDocuments = {
        ...documents,
        read(id: string, maxPages: number, signal: AbortSignal) {
          const key = `${id}:${maxPages}`;
          let result = localCache.get(key);
          if (!result) {
            result = documents.read(id, maxPages, signal);
            localCache.set(key, result);
            result.catch(() => localCache.delete(key));
          }
          return result;
        },
      };
      const pending = new Set<Promise<unknown>>();
      const saveDataset = async (blockId: string, value: ResearchDataset) => {
        datasets.set(blockId, value);
        const aggregate = mergeResearchDatasets(...datasets.values());
        await store.write(`${input.id}.research.json`, aggregate);
        await store.write(`${input.id}.${BlockId.parse(blockId)}.research.json`, value);
      };
      const execute = async () => {
        try {
          await executeWorkflow({
            run: input,
            registry,
            outputs,
            context: (blockId): BlockContext => ({
              runId: input.id,
              blockId,
              scope: input.scope,
              settings: snapshot,
              signal: controller.signal,
              resumed: false,
              llm: {
                generateObject: async () => {
                  throw new ReqflowError(
                    "not_implemented",
                    "Analytical LLM blocks are owned by their workstreams; raw Research does not analyze source content.",
                  );
                },
                generateText: async () => {
                  throw new ReqflowError(
                    "not_implemented",
                    "LLM text generation is not configured for this block.",
                  );
                },
              },
              audit: { record: audit },
              files: {
                get: async (id) => {
                  const file = await resolveFile(id);
                  return {
                    id,
                    name: file.name,
                    mimeType: file.entry.mimeType,
                    bytes: new Uint8Array(await readFile(file.path)),
                  };
                },
              },
              web: null,
              car: {
                add: async () => {
                  throw new ReqflowError(
                    "not_implemented",
                    "Requirements persistence is not configured in the Research runtime.",
                  );
                },
              },
              log: () => {},
              progress: () => {},
              research: {
                collect(request, ctx) {
                  const collector = createResearchCollector({
                    settings: snapshot,
                    credentials: keys,
                    documents: cachedDocuments,
                    fetchImpl: deps.fetchImpl,
                    save: (value) => saveDataset(blockId, value),
                  });
                  const promise = collector.collect(request, ctx);
                  pending.add(promise);
                  void promise.then(
                    () => pending.delete(promise),
                    () => pending.delete(promise),
                  );
                  return promise;
                },
              },
            }),
            onUpdate: async (value) => {
              if (!["running", "queued"].includes(value.status))
                await Promise.allSettled([...pending]);
              const run = clone(value);
              for (const block of run.blockRuns) {
                if (block.error) block.error = safe(block.error);
                for (const log of block.logs) log.message = safe(log.message);
              }
              if (run.error) run.error = safe(run.error);
              const index = store.state.runs.findIndex((r) => r.id === run.id);
              store.state.runs[index] = run;
              await store.write(`${run.id}.outputs.json`, outputs);
              await store.saveState();
              publish(run);
            },
          });
          const run = getRun(input.id);
          await audit({
            actor: { type: "system", component: "engine" },
            action:
              run.status === "completed"
                ? "run.completed"
                : run.status === "waiting_for_review"
                  ? "run.paused"
                  : run.status === "cancelled"
                    ? "run.cancelled"
                    : "run.failed",
            entityType: "run",
            entityId: run.id,
            runId: run.id,
            rationale: `Workflow execution ${run.status}. Raw collection outcomes are recorded separately.`,
          });
        } catch {
          const run = getRun(input.id);
          run.status = controller.signal.aborted ? "cancelled" : "failed";
          run.error = "Run could not finish; preserved raw results remain available.";
          run.finishedAt = new Date().toISOString();
          await store.saveState();
          publish(run);
        } finally {
          jobs.delete(input.id);
        }
      };
      // Register before executing so cancel/start requests can never launch a duplicate job.
      const initial = clone(input);
      const promise = Promise.resolve().then(execute);
      jobs.set(input.id, { controller, promise, outputs });
      return initial;
    } catch (error) {
      const run = getRun(input.id);
      run.status = "failed";
      run.error =
        "Research runtime could not be initialized. Check secure storage and local data availability.";
      run.finishedAt = new Date().toISOString();
      await store.saveState();
      publish(run);
      throw error;
    } finally {
      launchingRuns.delete(input.id);
    }
  }
  const handlers: ResearchHandlers = {
    settings: {
      get: async () => clone(store.state.settings),
      secrets: async () => secrets.status(),
      save: async (input) => {
        const settings = Settings.parse(input);
        // Dedicated configure owns provider access flags; stale general-settings autosaves must
        // not re-enable providers or undo an explicit approval/revocation.
        settings.research.apis = clone(store.state.settings.research.apis);
        store.state.settings = settings;
        await store.saveState();
        await audit({
          actor: actor(),
          action: "settings.changed",
          entityType: "settings",
          entityId: "app",
          rationale: "General app settings saved; no credential values in audit.",
        });
        return clone(settings);
      },
      setSecret: async (name, value) => {
        const key = SecretName.parse(name);
        const result = await secrets.set(key, value);
        for (const id of ResearchProviderId.options)
          if (PROVIDER_SECRETS[id].includes(key)) invalidate(id);
        await audit({
          actor: actor(),
          action: "settings.changed",
          entityType: "settings",
          entityId: `credential:${key}`,
          rationale:
            value === null
              ? "Credential removed."
              : "Credential stored using OS-backed encryption.",
        });
        return result;
      },
    },
    workflows: {
      list: async () => clone(store.state.workflows),
      get: async (id) => {
        z.string().startsWith("wf_").parse(id);
        const wf = store.state.workflows.find((w) => w.id === id);
        if (!wf) throw new ReqflowError("not_found", "Workflow not found.");
        return clone(wf);
      },
      save: async (input) => {
        const now = new Date().toISOString();
        const previous = input.id
          ? store.state.workflows.find((w) => w.id === input.id)
          : undefined;
        if (input.id && !previous)
          throw new ReqflowError("not_found", "Workflow to update was not found.");
        const workflow = Workflow.parse({
          ...input,
          id: previous?.id ?? `wf_${randomUUID()}`,
          version: (previous?.version ?? 0) + 1,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        });
        const problems = validateGraph(workflow);
        if (problems.length)
          throw new ReqflowError("invalid_graph", "Workflow graph failed validation.", problems);
        store.state.workflows = [
          ...store.state.workflows.filter((w) => w.id !== workflow.id),
          workflow,
        ];
        await store.saveState();
        await audit({
          actor: actor(),
          action: "workflow.saved",
          entityType: "workflow",
          entityId: workflow.id,
        });
        return clone(workflow);
      },
      remove: async (id) => {
        z.string().startsWith("wf_").parse(id);
        store.state.workflows = store.state.workflows.filter((w) => w.id !== id);
        await store.saveState();
      },
    },
    runs: {
      start: async (workflowId) => {
        z.string().startsWith("wf_").parse(workflowId);
        const workflow = store.state.workflows.find((w) => w.id === workflowId);
        if (!workflow) throw new ReqflowError("not_found", "Workflow not found.");
        if (
          startingWorkflows.has(workflowId) ||
          [...jobs.keys(), ...launchingRuns].some((id) => getRun(id).workflowId === workflowId)
        )
          throw new ReqflowError("run_busy", "This workflow already has an active run.");
        startingWorkflows.add(workflowId);
        try {
          const run = WorkflowRun.parse({
            id: `run_${randomUUID()}`,
            workflowId,
            workflowVersion: workflow.version,
            graph: { blocks: workflow.blocks, edges: workflow.edges },
            scope: workflow.scope,
            status: "queued",
            startedBy: actor(),
            startedAt: new Date().toISOString(),
            blockRuns: [...walkBlocks(workflow)].map(({ block }) => ({
              blockId: block.id,
              status: "pending",
              counts: {},
              logs: [],
            })),
          });
          store.state.runs.push(run);
          await store.saveState();
          await audit({
            actor: run.startedBy,
            action: "run.started",
            entityType: "run",
            entityId: run.id,
            runId: run.id,
          });
          return await launch(clone(run), {});
        } finally {
          startingWorkflows.delete(workflowId);
        }
      },
      get: async (id) => clone(getRun(id)),
      list: async (id) => {
        if (id) z.string().startsWith("wf_").parse(id);
        return clone(store.state.runs.filter((r) => !id || r.workflowId === id));
      },
      blockOutput: async (runId, blockId) => {
        getRun(runId);
        BlockId.parse(blockId);
        const outputs = jobs.get(runId)?.outputs ?? (await store.outputs(runId));
        const value = outputs[blockId];
        if (!value) throw new ReqflowError("not_found", "This block has no preserved output.");
        return clone(value);
      },
      resume: async (id) => {
        const run = getRun(id);
        if (resumingRuns.has(id) || jobs.has(id) || launchingRuns.has(id))
          throw new ReqflowError("run_busy", "Run is already resuming or active.");
        if (run.status !== "waiting_for_review")
          throw new ReqflowError(
            "invalid_state",
            "Only a workflow waiting for human review can resume.",
          );
        resumingRuns.add(id);
        try {
          await audit({
            actor: actor(),
            action: "run.resumed",
            entityType: "run",
            entityId: run.id,
            runId: run.id,
          });
          return await launch(clone(run), await store.outputs(id));
        } finally {
          resumingRuns.delete(id);
        }
      },
      cancel: async (id) => {
        const run = getRun(id);
        const job = jobs.get(id);
        if (job) {
          job.controller.abort();
          await job.promise;
        } else if (run.status === "waiting_for_review" || run.status === "queued") {
          run.status = "cancelled";
          run.finishedAt = new Date().toISOString();
          await store.saveState();
          publish(run);
        }
        return clone(getRun(id));
      },
    },
    files: {
      import: async () => {
        const path = await deps.chooseImport();
        if (!path) return null;
        const extension = FileInfo.shape.extension.parse(extname(path).toLowerCase());
        const size = await stat(path);
        if (!size.isFile() || size.size > 64 * 1024 * 1024)
          throw new ReqflowError("invalid_file", "Choose a supported file no larger than 64 MiB.");
        const file = FileInfo.parse({
          id: `file_${randomUUID()}`,
          name: basename(path),
          mimeType: FILE_TYPES[extension],
          sizeBytes: size.size,
          importedAt: new Date().toISOString(),
          extension,
        });
        await mkdir(join(deps.dir, "uploads"), { recursive: true, mode: 0o700 });
        await copyFile(path, join(deps.dir, "uploads", `${file.id}${extension}`));
        const operation = fileQueue.promise.then(async () => {
          let files: z.infer<typeof FileInfo>[] = [];
          try {
            files = await store.read("files.json", z.array(FileInfo));
          } catch (error) {
            if (!(error instanceof ReqflowError) || error.code !== "not_found") throw error;
          }
          await store.write("files.json", [...files, file]);
        });
        fileQueue.promise = operation.catch(() => {});
        await operation;
        const { extension: _, ...info } = file;
        return info as StoredFileInfo;
      },
    },
    research: {
      agents: async () => clone(RESEARCH_AGENTS),
      providers: async () => ResearchProviderId.options.map(status),
      configure: async (input, value) => {
        const id = ResearchProviderId.parse(input);
        const config = ResearchProviderConfig.parse(value);
        store.state.settings.research.apis[id] = config;
        invalidate(id);
        await store.saveState();
        await audit({
          actor: actor(),
          action: "settings.changed",
          entityType: "settings",
          entityId: `provider:${id}`,
          rationale: "Provider enablement/access configuration saved. No credential values.",
        });
        return status(id);
      },
      test: async (input) => {
        const id = ResearchProviderId.parse(input);
        const previous = tests.get(id);
        if (previous) return previous;
        const generation = versions.get(id) ?? 0;
        const config = clone(store.state.settings.research.apis[id]);
        const promise = (async () => {
          const flags = configured(id);
          if (id !== "openalex" && PROVIDER_SECRETS[id].some((name) => !flags[name]))
            return status(id);
          const signal = AbortSignal.timeout(15000);
          const limits = ResearchLimits.parse({
            maxRequests: 3,
            maxResults: 1,
            maxDocumentPages: 1,
            timeoutMs: 15000,
            retries: 0,
            concurrency: 1,
          });
          let report: ConnectionReport;
          try {
            report = ConnectionReport.parse(
              await adapters.get(id)!.test({
                http: createProviderHttp({ limits, signal, fetchImpl: deps.fetchImpl }),
                credentials: credentials(),
                config,
                limits,
                signal,
                log: () => {},
                now: () => new Date().toISOString(),
                documents,
              }),
            );
          } catch (error) {
            report = {
              state:
                error instanceof ProviderError &&
                [
                  "invalid_credentials",
                  "permission_required",
                  "rate_limited",
                  "unsupported",
                ].includes(error.code)
                  ? (error.code as "invalid_credentials")
                  : "unreachable",
              message: "Provider test failed. No sensitive response details retained.",
              testedAt: new Date().toISOString(),
              capabilities: [],
              limitations: [],
            };
          }
          const values = SECRET_NAMES.map((name) => {
            try {
              return secrets.get(name);
            } catch {
              return undefined;
            }
          }).filter((key): key is string => !!key);
          report.message = redactSecrets(report.message, values);
          report.limitations = report.limitations.map((m) => redactSecrets(m, values));
          if ((versions.get(id) ?? 0) === generation) reports.set(id, report);
          return status(id);
        })();
        tests.set(id, promise);
        try {
          return await promise;
        } finally {
          tests.delete(id);
        }
      },
      dataset: async (id) => {
        getRun(id);
        return store.dataset(id);
      },
    },
    exports: {
      research: async (input) => {
        const { runId, format } = z
          .strictObject({
            runId: z.string().regex(/^run_[A-Za-z0-9_-]+$/),
            format: z.enum(["json", "xlsx", "csv"]),
          })
          .parse(input);
        getRun(runId);
        const dataset = await store.dataset(runId);
        const path = await deps.chooseExport(format, runId);
        if (!path) return null;
        await writeFile(
          path,
          format === "xlsx"
            ? await exportResearchXlsx(dataset)
            : format === "csv"
              ? exportResearchCsv(dataset)
              : exportResearchJson(dataset),
          { mode: 0o600 },
        );
        await audit({
          actor: actor(),
          action: "export.created",
          entityType: "export",
          entityId: runId,
          runId,
          rationale: `Raw research exported as ${format}; no analysis generated.`,
        });
        return { path };
      },
    },
    audit: {
      list: async (input?: AuditFilter) => {
        const filter = z
          .object({
            entityId: z.string().optional(),
            entityType: AuditEvent.shape.entityType.optional(),
            actorType: z.enum(["human", "ai", "system"]).optional(),
            action: AuditEvent.shape.action.optional(),
            runId: z.string().startsWith("run_").optional(),
            limit: z.number().int().min(1).max(1000).default(100),
          })
          .strict()
          .parse(input ?? {});
        let events: AuditEvent[] = [];
        try {
          events = await store.read("audit.json", z.array(AuditEvent));
        } catch (error) {
          if (!(error instanceof ReqflowError) || error.code !== "not_found") throw error;
        }
        return events
          .filter(
            (e) =>
              (!filter.entityId || e.entityId === filter.entityId) &&
              (!filter.entityType || e.entityType === filter.entityType) &&
              (!filter.actorType || e.actor.type === filter.actorType) &&
              (!filter.action || e.action === filter.action) &&
              (!filter.runId || e.runId === filter.runId),
          )
          .slice(-filter.limit);
      },
    },
  };
  return {
    handlers,
    async shutdown() {
      for (const job of jobs.values()) job.controller.abort();
      await Promise.allSettled([...jobs.values()].map((job) => job.promise));
    },
  };
}
