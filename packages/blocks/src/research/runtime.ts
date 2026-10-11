import { isIP } from "node:net";
import {
  CollectedItem,
  LiveLlmProvider,
  LLM_SECRET_NAMES,
  ResearchDataset,
  ResearchRequest,
  type ResearchCollector,
  type ResearchProviderId,
  type ResearchProviderConfig,
  type ResearchAgentId,
  type ResearchScope,
  type SecretName,
  type Settings,
  type AgentCollectionResult,
  type CollectionStatus,
  type ResearchRecord,
  type Source,
  type LlmClient,
} from "@reqflow/core";
import { ASSESSMENT_FIELD, assessOriginal, type SourceAssessment } from "./assessment";
import { RESEARCH_AGENTS, buildQueries } from "./agents";
import { createMastraQueryPlanner } from "./mastra";
import { createProviderHttp, errorReport, redactSecrets, withAbort } from "./http";
import { normalizeItem, mergeResearchDatasets } from "./raw";
import { ProviderError, type ProviderAdapter, type ProviderContext } from "./provider";
import { assertJsonByteBudget, jsonByteSize, RESEARCH_DATASET_MAX_BYTES } from "./data-budget";
import {
  discoverCompetitors,
  buildAutonomousQueries,
  refineAgentQueries,
  type RejectionContext,
} from "./autonomous";
import { createFirecrawlAdapter } from "./providers/firecrawl";
import { createTavilyAdapter } from "./providers/tavily";
import { createYouTubeAdapter } from "./providers/youtube";
import { createXAdapter } from "./providers/x";
import { createRedditAdapter } from "./providers/reddit";
import { createApifyAdapter } from "./providers/apify";
import { createOpenAlexAdapter } from "./providers/openalex";
import { createEurostatAdapter } from "./providers/eurostat";
import { createLocalDocumentsAdapter } from "./providers/documents";

// Reserve space for bounded notes/status changes across all 13 agents. Candidate checks
// already include recordIds, including repeated IDs collected by different agents.
const RESULT_METADATA_RESERVE_BYTES = 128 * 1024;
const RESULT_NOTES_MAX_BYTES = 8 * 1024;
const RESULT_NOTE_MAX_LENGTH = 512;
const RAW_DATA_BUDGET_NOTE =
  "Raw-data byte budget exceeded or safe serialization limit reached; additional originals were skipped; previously collected originals were retained.";
const OMITTED_NOTES =
  "Additional collection limitation messages were omitted by the result metadata limit.";

export const PROVIDER_SECRETS: Record<ResearchProviderId, SecretName[]> = {
  firecrawl: ["firecrawl_api_key"],
  youtube: ["youtube_api_key"],
  apify: ["apify_api_token"],
  x: ["x_bearer_token"],
  reddit: ["reddit_client_id", "reddit_client_secret", "reddit_refresh_token"],
  openalex: ["openalex_api_key"],
  tavily: ["tavily_api_key"],
  eurostat: [],
  local_documents: [],
};

export function createResearchAdapters(): Map<ResearchProviderId, ProviderAdapter> {
  return new Map(
    [
      createFirecrawlAdapter(),
      createTavilyAdapter(),
      createYouTubeAdapter(),
      createXAdapter(),
      createRedditAdapter(),
      createApifyAdapter(),
      createOpenAlexAdapter(),
      createEurostatAdapter(),
      createLocalDocumentsAdapter(),
    ].map((adapter) => [adapter.id, adapter]),
  );
}

function publicHost(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    isIP(host.replace(/^\[|\]$/g, "")) ||
    !host.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|localdomain|test|invalid|example|onion)$/.test(
      host,
    ) ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  )
    throw new Error(
      "Research source must have a public HTTP(S) hostname without credentials or custom ports.",
    );
  return host;
}

/** Normalize domain policy once, so every provider receives the same hostname semantics. */
function domains(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => {
        const trimmed = value.trim().replace(/^(https?:\/\/)?\*\./i, "$1");
        if (!trimmed || /\s/.test(trimmed))
          throw new Error("Research domain filters must contain valid hostnames or HTTP(S) URLs.");
        return publicHost(new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`));
      }),
    ),
  ];
}

const matchesHost = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);
function intersectDomains(left: string[], right: string[]): string[] {
  return [
    ...new Set(
      left.flatMap((a) =>
        right.flatMap((b) => (matchesHost(a, b) ? [a] : matchesHost(b, a) ? [b] : [])),
      ),
    ),
  ];
}

/** A scoped allowlist may narrow global access; an empty intersection never means unrestricted. */
export function mergeResearchDomainPolicy(
  global: Pick<ResearchScope, "allowedDomains" | "blockedDomains">,
  scoped: Pick<ResearchScope, "allowedDomains" | "blockedDomains">,
): Pick<ResearchScope, "allowedDomains" | "blockedDomains"> {
  const globalAllowed = domains(global.allowedDomains);
  const scopedAllowed = domains(scoped.allowedDomains);
  const allowedDomains =
    globalAllowed.length && scopedAllowed.length
      ? intersectDomains(globalAllowed, scopedAllowed)
      : globalAllowed.length
        ? globalAllowed
        : scopedAllowed;
  if (globalAllowed.length && scopedAllowed.length && !allowedDomains.length)
    throw new Error(
      "Research domain allowlist intersection is empty; global restrictions cannot be widened.",
    );
  return {
    allowedDomains,
    blockedDomains: [
      ...new Set([...domains(global.blockedDomains), ...domains(scoped.blockedDomains)]),
    ],
  };
}

function sourceDomains(agent: ResearchAgentId, provider: ResearchProviderId): string[] {
  if (provider === "reddit") return ["reddit.com"];
  if (provider === "youtube") return ["youtube.com", "youtu.be"];
  if (provider === "x") return ["x.com", "twitter.com"];
  if (provider === "openalex") return ["openalex.org"];
  if (provider === "eurostat") return ["ec.europa.eu"];
  if (provider === "apify") return [agent === "instagram" ? "instagram.com" : "tiktok.com"];
  if (
    (provider === "firecrawl" || provider === "tavily") &&
    (agent === "bmw_sales" || agent === "bmw_strategy")
  )
    return ["bmwgroup.com", "press.bmwgroup.com"];
  return [];
}

function providerScope(
  scope: ResearchScope,
  agent: ResearchAgentId,
  provider: ResearchProviderId,
): ResearchScope {
  if (provider === "local_documents") return scope;
  const platform = sourceDomains(agent, provider);
  const allowedDomains = platform.length
    ? scope.allowedDomains.length
      ? intersectDomains(scope.allowedDomains, platform)
      : platform
    : scope.allowedDomains;
  if (
    (platform.length && !allowedDomains.length) ||
    (allowedDomains.length &&
      allowedDomains.every((host) =>
        scope.blockedDomains.some((blocked) => matchesHost(host, blocked)),
      ))
  )
    throw new Error("Source platform is excluded by the research domain policy.");
  return { ...scope, allowedDomains };
}

function allowedSource(item: CollectedItem, scope: ResearchScope): boolean {
  // Imported originals are not public network sources. Their identity is checked by the local adapter.
  if (item.provider === "local_documents")
    return new URL(item.sourceUrl).protocol === "reqflow-file:";
  try {
    const host = publicHost(new URL(item.sourceUrl));
    return (
      !scope.blockedDomains.some((domain) => matchesHost(host, domain)) &&
      (!scope.allowedDomains.length ||
        scope.allowedDomains.some((domain) => matchesHost(host, domain)))
    );
  } catch {
    return false;
  }
}

const usesQueries = (provider: ResearchProviderId) =>
  provider !== "local_documents" && provider !== "eurostat";
function actorGate(
  agent: ResearchAgentId,
  provider: ResearchProviderId,
  config: ResearchProviderConfig,
): string | undefined {
  if (provider !== "apify") return;
  const actor = agent === "instagram" ? "apify/instagram-scraper" : "clockworks/tiktok-scraper";
  if (!config.allowedActors.includes(actor))
    return `apify: explicit permission for ${actor} is required.`;
}

export interface ResearchCollectorOptions {
  settings: Settings;
  credentials: Partial<Record<SecretName, string>>;
  /** Explicit factory-level opt-in; per-run context.planQueries takes precedence. Default: false. */
  queryPlanning?: boolean;
  documents?: ProviderContext["documents"];
  adapters?: Map<ResearchProviderId, ProviderAdapter>;
  fetchImpl?: typeof fetch;
  /** Production injects the selected Quality client. Omitted only for retrieval-only/offline compatibility. */
  reviewLlm?: () => LlmClient;
  save(dataset: ResearchDataset): Promise<void>;
}

async function parallelMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function createResearchCollector(options: ResearchCollectorOptions): ResearchCollector {
  return {
    async collect(input, context) {
      const request = ResearchRequest.parse(input);
      const hasCustomDeadline =
        typeof request.limits.timeoutMs === "number" && request.limits.timeoutMs !== 120000;
      const signal = AbortSignal.any([
        context.signal,
        ...(hasCustomDeadline ? [AbortSignal.timeout(request.limits.timeoutMs)] : []),
      ]);
      const budget = { used: 0 };
      const httpOptions = { limits: request.limits, signal, fetchImpl: options.fetchImpl, budget };
      const http = createProviderHttp(httpOptions);
      const adapters = options.adapters ?? createResearchAdapters();
      const secrets = Object.values(options.credentials).filter(
        (value): value is string => !!value,
      );
      const safe = (message: string) => redactSecrets(message, secrets);
      const parts: ResearchDataset[] = [];
      const uniqueRecords = new Set<string>();
      const usableRecords = new Set<string>();
      let plannerRequests = 0;
      let reviewRequests = 0;
      const assessments = new Map<string, SourceAssessment>();
      let planner: ReturnType<typeof createMastraQueryPlanner> | undefined;
      // This optional context field belongs to ResearchCollector, never to strict ResearchRequest.
      const planQueries =
        (context as typeof context & { planQueries?: boolean }).planQueries ??
        options.queryPlanning ??
        false;
      const selectedLlm = LiveLlmProvider.safeParse(options.settings.llm.provider);
      const plannerKey = selectedLlm.success
        ? options.credentials[LLM_SECRET_NAMES[selectedLlm.data]]
        : undefined;
      const plannerOptions =
        planQueries === true &&
        selectedLlm.success &&
        plannerKey?.trim() &&
        options.settings.llm.fastModel?.trim()
          ? {
              provider: selectedLlm.data,
              apiKey: plannerKey,
              modelId: options.settings.llm.fastModel,
            }
          : undefined;
      let scope = request.scope;
      let policyError: string | undefined;
      try {
        scope = { ...scope, ...mergeResearchDomainPolicy(options.settings.research, scope) };
      } catch (error) {
        policyError = safe(
          error instanceof Error ? error.message : "Invalid research domain policy.",
        );
      }

      const agents = [...new Set(request.agents)];

      // Autonomous discovery of competitor models when competitor_models agent is active and not explicitly provided
      if (
        scope.competitors.length === 0 &&
        agents.includes("competitor_models") &&
        options.reviewLlm
      ) {
        try {
          const reserveDiscovery = () => {
            if (budget.used >= request.limits.maxRequests) {
              throw new Error("Shared request budget exhausted during competitor discovery.");
            }
            budget.used += 1;
            reviewRequests += 1;
          };
          const discovered = await discoverCompetitors(
            scope,
            options.reviewLlm(),
            signal,
            reserveDiscovery,
          );
          if (discovered.length > 0) {
            scope = { ...scope, competitors: discovered };
            context.log(
              `Autonomously discovered segment competitors: ${discovered.map((c) => `${c.brand} ${c.model}`).join(", ")}.`,
            );
          }
        } catch {
          // Keep deterministic segmentation
        }
      }

      for (const [index, agentId] of agents.entries()) {
        const definition = RESEARCH_AGENTS.find((entry) => entry.id === agentId)!;
        const limitations: string[] = [];
        const sources: Source[] = [];
        const records: ResearchRecord[] = [];
        const states: CollectionStatus[] = [];
        let limitationBytes = 2;
        let limitationsOmitted = false;
        let serializationLimitReached = false;
        const startRequests = http.requests + plannerRequests + reviewRequests;
        const eligible: {
          provider: ResearchProviderId;
          adapter: ProviderAdapter;
          scope: ResearchScope;
          config: ResearchProviderConfig;
        }[] = [];
        const addLimitation = (message: string) => {
          const sanitized = safe(message);
          if (sanitized.length > RESULT_NOTE_MAX_LENGTH) limitationsOmitted = true;
          const bounded = sanitized.slice(0, RESULT_NOTE_MAX_LENGTH);
          if (limitations.includes(bounded)) return;
          const bytes = jsonByteSize(bounded) + (limitations.length ? 1 : 0);
          if (limitationBytes + bytes > RESULT_NOTES_MAX_BYTES) {
            limitationsOmitted = true;
            return;
          }
          limitations.push(bounded);
          limitationBytes += bytes;
        };
        const note = (status: CollectionStatus, message: string) => {
          states.push(status);
          addLimitation(message);
        };
        const resultLimitations = () => [
          ...(serializationLimitReached ? [RAW_DATA_BUDGET_NOTE] : []),
          ...limitations,
          ...(limitationsOmitted ? [OMITTED_NOTES] : []),
        ];
        const part = (
          candidateSources = sources,
          candidateRecords = records,
          status: CollectionStatus = "partial",
        ): ResearchDataset =>
          ResearchDataset.parse({
            schemaVersion: 1,
            runId: context.runId,
            sources: candidateSources,
            records: candidateRecords,
            results: [
              {
                agentId,
                status,
                recordIds: [...new Set(candidateRecords.map((record) => record.id))],
                limitations: resultLimitations(),
                requests: http.requests + plannerRequests + reviewRequests - startRequests,
              },
            ],
            retrievedAt: new Date().toISOString(),
            synthetic: false,
          });

        if (signal.aborted) note("cancelled", "Research cancelled or time limit reached.");
        else
          for (const originalProvider of definition.providers) {
            let provider = originalProvider;
            if (originalProvider === "firecrawl") {
              const selected = options.settings.research.provider;
              if (selected === "off") {
                note(
                  "blocked",
                  "Web research is off; Firecrawl and Tavily collection are disabled.",
                );
                continue;
              }
              if (selected === "anthropic_web_search") {
                note(
                  "blocked",
                  "anthropic_web_search is unsupported for raw original collection; explicitly select Firecrawl or Tavily.",
                );
                continue;
              }
              provider = selected;
            }
            const config = options.settings.research.apis[provider];
            if (!config.enabled) {
              note("blocked", `${provider}: disabled in Research APIs Settings.`);
              continue;
            }
            if ((provider === "reddit" || provider === "apify") && config.approval !== "granted") {
              note("blocked", `${provider}: usage approval not granted.`);
              continue;
            }
            const actorError = actorGate(agentId, provider, config);
            if (actorError) {
              note("blocked", actorError);
              continue;
            }
            if (
              provider !== "openalex" &&
              PROVIDER_SECRETS[provider].some((name) => !options.credentials[name]?.trim())
            ) {
              note("missing_credentials", `${provider}: required credentials are missing.`);
              continue;
            }
            const adapter = adapters.get(provider);
            if (!adapter) {
              note("blocked", `${provider}: adapter not installed.`);
              continue;
            }
            if (policyError && provider !== "local_documents") {
              note("blocked", `${provider}: ${policyError}`);
              continue;
            }
            let restricted: ResearchScope;
            try {
              restricted = providerScope(scope, agentId, provider);
            } catch {
              note(
                "blocked",
                `${provider}: source platform is excluded by the research domain policy.`,
              );
              continue;
            }
            const qualityTargetReached = options.reviewLlm
              ? usableRecords.size >= request.limits.maxResults
              : uniqueRecords.size >= request.limits.maxResults;
            if (qualityTargetReached) {
              note("partial", "Shared result limit reached.");
              continue;
            }
            if (provider !== "local_documents" && budget.used >= request.limits.maxRequests) {
              note("partial", "Shared request budget exhausted.");
              continue;
            }
            eligible.push({ provider, adapter, scope: restricted, config });
          }

        let queries: string[] = [];
        let queryError = false;
        const queryWork = eligible.some(({ provider }) => usesQueries(provider));
        if (queryWork) {
          try {
            queries = buildAutonomousQueries(agentId, scope, scope.competitors);
          } catch {
            queryError = true;
            note(
              "error",
              "Invalid deterministic research query scope; no queries or results fabricated.",
            );
          }
          // Reserve at least one request for collection. Explicit URL-only Apify work does not use queries.
          const planningWork = eligible.some(
            ({ provider }) =>
              usesQueries(provider) &&
              !(provider === "apify" && (agentId === "instagram" || scope.urls.length > 0)),
          );
          if (
            !queryError &&
            plannerOptions &&
            planningWork &&
            budget.used + 1 < request.limits.maxRequests
          ) {
            try {
              signal.throwIfAborted();
              planner ??= createMastraQueryPlanner(plannerOptions);
              budget.used += 1;
              plannerRequests += 1;
              queries = await withAbort(planner(agentId, scope, signal), signal);
            } catch {
              queryError = true;
              note(
                signal.aborted ? "cancelled" : "error",
                signal.aborted
                  ? "Research cancelled or time limit reached."
                  : "Mastra query planning failed; no deterministic fallback, fabricated queries or results used.",
              );
            }
          }
        }

        const targetUsableForAgent = Math.max(
          1,
          Math.ceil(request.limits.maxResults / agents.length),
        );
        const agentUsableRecordIds = new Set<string>();
        const maxRounds =
          options.reviewLlm && eligible.some(({ provider }) => usesQueries(provider)) ? 3 : 1;
        const rejections: RejectionContext[] = [];
        const seenQueries = new Set<string>();

        for (let round = 1; round <= maxRounds; round++) {
          let newRecordsInRound = 0;
          for (const q of queries) seenQueries.add(q);
          for (const { provider, adapter, scope: restricted, config } of eligible) {
            if (queryError && usesQueries(provider)) continue;
            if (signal.aborted) {
              note("cancelled", "Research cancelled or time limit reached.");
              break;
            }
            const qualityTargetReached = options.reviewLlm
              ? usableRecords.size >= request.limits.maxResults
              : uniqueRecords.size >= request.limits.maxResults;
            if (qualityTargetReached) {
              note("partial", "Shared result limit reached.");
              break;
            }
            const remaining = options.reviewLlm
              ? request.limits.maxResults - usableRecords.size
              : request.limits.maxResults - uniqueRecords.size;
            if (remaining <= 0) {
              note("partial", "Shared result limit reached.");
              break;
            }
            if (provider !== "local_documents" && budget.used >= request.limits.maxRequests) {
              note("partial", "Shared request budget exhausted.");
              continue;
            }
            try {
              const outcome = await adapter.collect(
                { agentId, scope: restricted, queries },
                {
                  http,
                  credentials: options.credentials,
                  config,
                  limits: {
                    ...request.limits,
                    maxResults: remaining,
                    maxRequests: Math.max(1, request.limits.maxRequests - plannerRequests),
                  },
                  signal,
                  log: (message) => context.log(safe(message)),
                  now: () => new Date().toISOString(),
                  documents: options.documents,
                },
              );
              states.push(outcome.status);
              for (const limitation of outcome.limitations) addLimitation(limitation);

              const parsedItems: CollectedItem[] = [];
              for (const value of outcome.items) {
                try {
                  const item = CollectedItem.parse(value);
                  if (item.provider !== provider || !allowedSource(item, restricted)) {
                    note(
                      "partial",
                      `${provider}: returned source excluded by the provider or public-source domain policy.`,
                    );
                    continue;
                  }
                  assertJsonByteBudget(
                    item,
                    RESEARCH_DATASET_MAX_BYTES - RESULT_METADATA_RESERVE_BYTES,
                  );
                  parsedItems.push(item);
                } catch (error) {
                  if (error instanceof ProviderError && error.code === "limit_reached") {
                    states.push("partial");
                    serializationLimitReached = true;
                    continue;
                  }
                  note(
                    "error",
                    `${provider}: malformed original record was skipped; previously collected originals were retained.`,
                  );
                }
              }

              const itemConcurrency = Math.min(
                request.limits.concurrency || 3,
                parsedItems.length || 1,
              );
              const processedItems = await parallelMap(
                parsedItems,
                itemConcurrency,
                async (item) => {
                  const { source, record } = normalizeItem(
                    item,
                    agentId,
                    context.runId,
                    new Date().toISOString(),
                  );
                  let isUsable = true;
                  let statusNote: { status: CollectionStatus; message: string } | undefined;

                  if (options.reviewLlm) {
                    const key = `${agentId}:${record.id}:${record.contentHash}`;
                    let assessment = assessments.get(key);
                    if (!assessment) {
                      try {
                        assessment = await withAbort(
                          assessOriginal(
                            item,
                            record,
                            agentId,
                            scope,
                            options.reviewLlm(),
                            signal,
                            () => {
                              if (budget.used >= request.limits.maxRequests)
                                throw new Error(
                                  "Shared request budget exhausted during source assessment.",
                                );
                              budget.used += 1;
                              reviewRequests += 1;
                            },
                          ),
                          signal,
                        );
                      } catch (error) {
                        assessment = {
                          version: 1,
                          agentId,
                          contentHash: record.contentHash,
                          scope,
                          runId: context.runId,
                          verdict: "unreviewed",
                          reasons: [
                            "Content assessment did not complete; this original is archived but excluded from usable output.",
                          ],
                          uncertainties: [],
                          excerpts: [],
                          tableRows: [],
                          model: "",
                          summaries: [],
                        };
                        statusNote = {
                          status: signal.aborted ? "cancelled" : "partial",
                          message: safe(errorReport(error).message),
                        };
                        addLimitation(
                          "Source assessment incomplete; affected originals are archived but excluded from usable output.",
                        );
                      }
                      assessments.set(key, assessment);
                    }
                    record.fields = { ...record.fields, [ASSESSMENT_FIELD]: [assessment] };
                    if (assessment.verdict === "relevant") {
                      isUsable = true;
                    } else {
                      isUsable = false;
                      rejections.push({
                        url: item.sourceUrl,
                        reason: assessment.reasons.join("; ") || `verdict ${assessment.verdict}`,
                      });
                      if (assessment.verdict === "uncertain") {
                        statusNote = {
                          status: "partial",
                          message:
                            "Source relevance is uncertain; this original is archived but excluded from usable output.",
                        };
                      }
                    }
                    context.log(
                      `${definition.label}: source [${record.id}] content assessment ${assessment.verdict}.`,
                    );
                  }
                  return { source, record, isUsable, statusNote };
                },
              );

              for (const { source, record, isUsable, statusNote } of processedItems) {
                try {
                  if (statusNote) note(statusNote.status, statusNote.message);

                  if (
                    !uniqueRecords.has(record.id) &&
                    (options.reviewLlm
                      ? usableRecords.size >= request.limits.maxResults && !isUsable
                      : uniqueRecords.size >= request.limits.maxResults)
                  ) {
                    note(
                      "partial",
                      "Shared result limit reached; excess unique records were not retained.",
                    );
                    continue;
                  }

                  const candidate = mergeResearchDatasets(
                    ...parts,
                    part([...sources, source], [...records, record]),
                  );
                  assertJsonByteBudget(
                    candidate,
                    RESEARCH_DATASET_MAX_BYTES - RESULT_METADATA_RESERVE_BYTES,
                  );
                  uniqueRecords.add(record.id);
                  newRecordsInRound++;
                  sources.push(source);
                  records.push(record);
                  if (isUsable) {
                    usableRecords.add(record.id);
                    agentUsableRecordIds.add(record.id);
                  }
                } catch (error) {
                  if (error instanceof ProviderError && error.code === "limit_reached") {
                    states.push("partial");
                    serializationLimitReached = true;
                    continue;
                  }
                  note(
                    "error",
                    `${provider}: malformed original record was skipped; previously collected originals were retained.`,
                  );
                }
              }
            } catch (error) {
              const failure = errorReport(error);
              note(
                signal.aborted || failure.code === "cancelled"
                  ? "cancelled"
                  : failure.code === "invalid_credentials"
                    ? "missing_credentials"
                    : failure.code === "permission_required" || failure.code === "unsupported"
                      ? "blocked"
                      : "error",
                `${provider}: ${failure.message}`,
              );
            }
          }

          const qualityGoalReached =
            agentUsableRecordIds.size >= targetUsableForAgent ||
            usableRecords.size >= request.limits.maxResults;
          const remainingAgents = agents.length - index - 1;
          const reservedForRemaining =
            remainingAgents * Math.min(25, Math.floor(request.limits.maxRequests / agents.length));
          const canRefine = budget.used + reservedForRemaining < request.limits.maxRequests;
          if (
            qualityGoalReached ||
            round >= maxRounds ||
            newRecordsInRound === 0 ||
            !canRefine ||
            budget.used >= request.limits.maxRequests ||
            signal.aborted ||
            rejections.length === 0
          ) {
            if (qualityGoalReached) {
              context.log(
                `${definition.label}: reached quality goal with ${agentUsableRecordIds.size} relevant sources.`,
              );
            }
            break;
          }

          try {
            context.log(
              `${definition.label}: round ${round} yielded ${agentUsableRecordIds.size}/${targetUsableForAgent} relevant sources (${rejections.length} rejected). Refining search queries...`,
            );
            const reserveRefinement = () => {
              if (budget.used >= request.limits.maxRequests) {
                throw new Error("Shared request budget exhausted during query refinement.");
              }
              budget.used += 1;
              plannerRequests += 1;
            };
            const refinement = await refineAgentQueries({
              agentId,
              scope,
              previousQueries: [...seenQueries],
              rejections,
              acceptedCount: agentUsableRecordIds.size,
              targetCount: targetUsableForAgent,
              discoveredCompetitors: scope.competitors,
              llm: options.reviewLlm ? options.reviewLlm() : undefined,
              signal,
              reserveRequest: reserveRefinement,
            });
            context.log(
              `${definition.label}: refined queries: ${refinement.queries.join("; ")} (${refinement.refinementReason})`,
            );
            queries = refinement.queries;
            rejections.length = 0;
          } catch {
            break;
          }
        }
        const status: AgentCollectionResult["status"] =
          signal.aborted || states.includes("cancelled")
            ? "cancelled"
            : records.length
              ? states.some((state) => state !== "success" && state !== "empty")
                ? "partial"
                : "success"
              : states.includes("error")
                ? "error"
                : states.includes("missing_credentials")
                  ? "missing_credentials"
                  : states.includes("blocked")
                    ? "blocked"
                    : states.includes("partial")
                      ? "partial"
                      : "empty";
        const completedPart = part(sources, records, status);
        const result = completedPart.results[0]!;
        parts.push(completedPart);
        const completeDataset = mergeResearchDatasets(...parts);
        assertJsonByteBudget(completeDataset, RESEARCH_DATASET_MAX_BYTES);
        await options.save(completeDataset);
        context.log(`${definition.label}: ${status}, ${result.recordIds.length} original records.`);
        for (const limitation of result.limitations)
          context.log(`${definition.label}: ${limitation}`);
        context.progress((index + 1) / agents.length);
      }
      const completeDataset = mergeResearchDatasets(...parts);
      assertJsonByteBudget(completeDataset, RESEARCH_DATASET_MAX_BYTES);
      return completeDataset;
    },
  };
}
