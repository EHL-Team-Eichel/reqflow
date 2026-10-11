import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  ConnectionReport,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchProviderId,
  SECRET_NAMES,
  Settings,
  type AuditLogger,
  type CollectedItem,
  BlockId,
  type ResearchCollector,
  type ResearchProviderStatus,
  type WorkflowRun,
  type ReqflowHandlers,
  type LlmClient,
  LiveLlmProvider,
  LLM_SECRET_NAMES,
} from "@reqflow/core";
import { createLlmClient } from "@reqflow/llm";
import {
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
  assertJsonByteBudget,
  RESEARCH_DATASET_MAX_BYTES,
  PERSISTED_JSON_MAX_BYTES,
  jsonByteSize,
} from "@reqflow/blocks";
import type { LocalFileStore } from "@reqflow/db";
import { ResearchDatasetRepository } from "../../../../../packages/db/src/research";
import { ReqflowError } from "../dispatch";
import type { SecretsStore } from "../secrets";

export interface ResearchOptions {
  xlsxWorkerPath?: string;
  fetchImpl?: typeof globalThis.fetch;
  /** Synthetic/offline integration seam; production always uses the selected Quality provider. */
  sourceReviewLlm?: LlmClient;
}
export interface ResearchServiceDeps extends ResearchOptions {
  files: LocalFileStore;
  secrets: SecretsStore;
  datasets: ResearchDatasetRepository;
  settings(): Settings;
  saveSettings(settings: Settings): Settings;
  getRun(runId: string): Promise<WorkflowRun>;
  audit: AuditLogger;
  chooseExport(format: "json" | "xlsx" | "csv", runId: string): Promise<string | null>;
}
const RunId = z.string().regex(/^run_[A-Za-z0-9_-]{1,100}$/);

/** A collector/namespace/export service, never an alternative application state or executor. */
export function createResearchService(deps: ResearchServiceDeps) {
  const documents = createLocalDocumentReader({
    resolveFile: (id) => deps.files.resolvePath(id),
    xlsxWorkerPath: deps.xlsxWorkerPath,
  });
  const adapters = createResearchAdapters();
  const reports = new Map<ResearchProviderId, ConnectionReport>();
  const versions = new Map<ResearchProviderId, number>();
  const tests = new Map<ResearchProviderId, Promise<ResearchProviderStatus>>();
  const caches = new Map<string, Map<string, Promise<CollectedItem[]>>>();
  const cacheBytes = new Map<string, number>();
  const pending = new Map<string, Set<Promise<unknown>>>();
  const safeValues = new Map<string, Set<string>>();
  const active = new Set<AbortController>();
  let accessEpoch = 0;
  function revokeActive() {
    accessEpoch++;
    for (const controller of active)
      controller.abort(new DOMException("Research access changed; start a new run.", "AbortError"));
  }
  const actor = () => ({ type: "human" as const, ...deps.settings().review.reviewer });
  const credentials = async () =>
    Object.fromEntries(
      await Promise.all(
        SECRET_NAMES.map(
          async (name) => [name, (await deps.secrets.getSecret(name)) ?? undefined] as const,
        ),
      ),
    );
  async function status(id: ResearchProviderId): Promise<ResearchProviderStatus> {
    const secrets = await deps.secrets.getStatus();
    const flags = Object.fromEntries(
      PROVIDER_SECRETS[id].map((name) => [name, secrets[name].configured]),
    );
    const missing = id !== "openalex" && PROVIDER_SECRETS[id].some((name) => !flags[name]);
    return {
      id,
      config: structuredClone(deps.settings().research.apis[id]),
      credentialsConfigured: flags,
      connection: reports.get(id) ?? {
        state: missing ? "not_configured" : "untested",
        message: missing
          ? "Required credentials are missing."
          : "Configured but not tested. No provider request has been made.",
        capabilities: [],
        limitations: [],
      },
    };
  }
  function invalidate(id: ResearchProviderId) {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    reports.delete(id);
    revokeActive();
  }
  function collector(runId: string, blockId: string, settings: Settings): ResearchCollector {
    RunId.parse(runId);
    BlockId.parse(blockId);
    return {
      collect(request, context) {
        assertJsonByteBudget(request, 1024 * 1024);
        if (context.runId !== runId)
          throw new ReqflowError("invalid_input", "Research collector run does not match context.");
        let tasks = pending.get(runId);
        if (!tasks) pending.set(runId, (tasks = new Set()));
        // Reserve before asynchronous credential loading so policy changes cannot
        // slip between startup and transport creation.
        const controller = new AbortController();
        const epoch = accessEpoch;
        active.add(controller);
        const signal = AbortSignal.any([context.signal, controller.signal]);
        const work = (async () => {
          try {
            signal.throwIfAborted();
            const keys = await credentials();
            if (epoch !== accessEpoch)
              controller.abort(new DOMException("Research access changed.", "AbortError"));
            signal.throwIfAborted();
            let values = safeValues.get(runId);
            if (!values) safeValues.set(runId, (values = new Set()));
            for (const key of Object.values(keys)) if (key) values.add(key);
            let cache = caches.get(runId);
            if (!cache) caches.set(runId, (cache = new Map()));
            const cachedDocuments = {
              ...documents,
              read(id: string, maxPages: number, signal: AbortSignal) {
                const key = `${id}:${maxPages}`;
                let result = cache!.get(key);
                if (!result) {
                  if (cache!.size >= 1000)
                    throw new ProviderError(
                      "limit_reached",
                      "Per-run document cache exceeds 1000 reads.",
                    );
                  result = documents.read(id, maxPages, signal).then((items) => {
                    const bytes = jsonByteSize(items, PERSISTED_JSON_MAX_BYTES);
                    if (bytes > PERSISTED_JSON_MAX_BYTES - (cacheBytes.get(runId) ?? 0))
                      throw new ProviderError(
                        "limit_reached",
                        "Per-run document cache exceeds 64 MiB raw-data budget.",
                      );
                    cacheBytes.set(runId, (cacheBytes.get(runId) ?? 0) + bytes);
                    return items;
                  });
                  cache!.set(key, result);
                  void result.catch(() => cache!.delete(key));
                }
                return result;
              },
            };
            // The current access configuration is authoritative. A persisted/stale run cannot
            // undo a provider revocation or widen global domain policy.
            const live = deps.settings().research;
            const snapshot = Settings.parse({
              ...settings,
              research: {
                ...settings.research,
                // Off is an immediate kill switch, not a new provider selection for old runs.
                provider: live.provider === "off" ? "off" : settings.research.provider,
                apis: live.apis,
                allowedDomains: live.allowedDomains,
                blockedDomains: live.blockedDomains,
              },
            });
            return await createResearchCollector({
              settings: snapshot,
              credentials: keys,
              documents: cachedDocuments,
              fetchImpl: deps.fetchImpl,
              reviewLlm: () => {
                if (deps.sourceReviewLlm) return deps.sourceReviewLlm;
                const provider = LiveLlmProvider.safeParse(snapshot.llm.provider);
                if (!provider.success)
                  throw new Error(
                    "Source content assessment requires a configured live Quality model; mock does not assess originals.",
                  );
                return createLlmClient(snapshot.llm, {
                  apiKey: keys[LLM_SECRET_NAMES[provider.data]],
                  fetch: deps.fetchImpl,
                });
              },
              async save(dataset) {
                const parts = deps.datasets.blocks(runId);
                // Migrated aggregate-only originals must survive the first new block save.
                if (!parts.size) {
                  const previous = deps.datasets.get(runId);
                  if (previous) parts.set("legacy", previous);
                }
                parts.set(blockId, dataset);
                const aggregate = mergeResearchDatasets(...parts.values());
                assertJsonByteBudget(dataset, RESEARCH_DATASET_MAX_BYTES);
                assertJsonByteBudget(aggregate, RESEARCH_DATASET_MAX_BYTES);
                deps.datasets.save(runId, blockId, dataset, aggregate);
              },
            }).collect(request, { ...context, signal });
          } finally {
            active.delete(controller);
          }
        })();
        tasks.add(work);
        void work.then(
          () => tasks!.delete(work),
          () => tasks!.delete(work),
        );
        return work;
      },
    };
  }
  const handlers: ReqflowHandlers["research"] = {
    agents: async () => structuredClone(RESEARCH_AGENTS),
    providers: async () => Promise.all(ResearchProviderId.options.map(status)),
    configure: async (input, value) => {
      const id = ResearchProviderId.parse(input),
        config = ResearchProviderConfig.parse(value);
      const settings = structuredClone(deps.settings());
      settings.research.apis[id] = config;
      deps.saveSettings(settings);
      invalidate(id);
      await deps.audit.record({
        actor: actor(),
        action: "settings.changed",
        entityType: "settings",
        entityId: `provider:${id}`,
        rationale: "Provider access configuration saved. No credential values.",
      });
      return status(id);
    },
    test: async (input) => {
      const id = ResearchProviderId.parse(input);
      const previous = tests.get(id);
      if (previous) return previous;
      const generation = versions.get(id) ?? 0;
      const config = structuredClone(deps.settings().research.apis[id]);
      const work = (async () => {
        const current = await status(id);
        if (
          id !== "openalex" &&
          PROVIDER_SECRETS[id].some((name) => !current.credentialsConfigured[name])
        )
          return current;
        // Explicit user-triggered authentication tests do not run actors or grant data access.
        const keys = await credentials();
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
              credentials: keys,
              config,
              limits,
              signal,
              log() {},
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
        const values = Object.values(keys).filter((key): key is string => !!key);
        report.message = redactSecrets(report.message, values).slice(0, 2048);
        report.capabilities = report.capabilities
          .slice(0, 50)
          .map((text) => redactSecrets(text, values).slice(0, 512));
        report.limitations = report.limitations
          .slice(0, 50)
          .map((text) => redactSecrets(text, values).slice(0, 512));
        if ((versions.get(id) ?? 0) === generation) reports.set(id, report);
        return status(id);
      })();
      tests.set(id, work);
      try {
        return await work;
      } finally {
        if (tests.get(id) === work) tests.delete(id);
      }
    },
    dataset: async (input) => {
      const id = RunId.parse(input);
      await deps.getRun(id);
      const dataset = deps.datasets.get(id);
      if (!dataset)
        throw new ReqflowError("not_found", "This run has no preserved research dataset.");
      return dataset;
    },
  };
  return {
    collector,
    handlers,
    invalidateSecret(name: import("@reqflow/core").SecretName) {
      // Planner keys are not provider adapter keys, but invalidate their active
      // requests too. Saved-key deletion may leave an environment fallback.
      revokeActive();
      for (const id of ResearchProviderId.options)
        if (PROVIDER_SECRETS[id].includes(name)) invalidate(id);
    },
    settingsChanged(previous: Settings, next: Settings) {
      if (
        JSON.stringify(previous.research) !== JSON.stringify(next.research) ||
        JSON.stringify(previous.llm) !== JSON.stringify(next.llm)
      )
        revokeActive();
    },
    async settle(runId: string) {
      await Promise.all([...(pending.get(runId) ?? [])]);
    },
    sanitize(run: WorkflowRun): WorkflowRun {
      const snapshot = structuredClone(run),
        keys = [...(safeValues.get(run.id) ?? [])];
      if (snapshot.error) snapshot.error = redactSecrets(snapshot.error, keys);
      for (const block of snapshot.blockRuns) {
        if (block.error) block.error = redactSecrets(block.error, keys);
        for (const log of block.logs) log.message = redactSecrets(log.message, keys);
      }
      return snapshot;
    },
    release(runId: string) {
      caches.delete(runId);
      cacheBytes.delete(runId);
      pending.delete(runId);
      safeValues.delete(runId);
    },
    async export(input: Parameters<ReqflowHandlers["exports"]["research"]>[0]) {
      const { runId, format } = z
        .strictObject({ runId: RunId, format: z.enum(["json", "xlsx", "csv"]) })
        .parse(input);
      const dataset = await handlers.dataset(runId);
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
      await deps.audit.record({
        actor: actor(),
        action: "export.created",
        entityType: "export",
        entityId: runId,
        runId,
        rationale: `Raw research exported as ${format}; no analysis generated.`,
      });
      return { path };
    },
  };
}
