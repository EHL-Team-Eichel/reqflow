import { z } from "zod";
import { Source, SourceKind, SourceRecord } from "./source";

export const RESEARCH_AGENT_IDS = [
  "reddit",
  "youtube",
  "instagram",
  "tiktok",
  "x",
  "owner_forums",
  "editorial_reviews",
  "competitor_models",
  "market_studies",
  "regional_context",
  "technology",
  "bmw_sales",
  "bmw_strategy",
] as const;
export const ResearchAgentId = z.enum(RESEARCH_AGENT_IDS);
export type ResearchAgentId = z.infer<typeof ResearchAgentId>;
export const RESEARCH_PROVIDER_IDS = [
  "firecrawl",
  "youtube",
  "apify",
  "x",
  "reddit",
  "openalex",
  "eurostat",
  "local_documents",
  "tavily",
] as const;
export const ResearchProviderId = z.enum(RESEARCH_PROVIDER_IDS);
export type ResearchProviderId = z.infer<typeof ResearchProviderId>;
export const APIFY_ACTORS = [
  "apify/instagram-scraper",
  "apify/instagram-comment-scraper",
  "clockworks/tiktok-scraper",
  "clockworks/tiktok-comments-scraper",
] as const;
export const ResearchProviderConfig = z
  .object({
    enabled: z.boolean().default(false),
    approval: z.enum(["not_granted", "granted"]).default("not_granted"),
    xSearchMode: z.enum(["recent", "full_archive"]).default("recent"),
    allowedActors: z.array(z.enum(APIFY_ACTORS)).default([]),
    redditUserAgent: z.string().min(10).max(200).default("ReqFlow/0.1 (approved research client)"),
  })
  .strict();
export type ResearchProviderConfig = z.infer<typeof ResearchProviderConfig>;
export const DEFAULT_RESEARCH_APIS = Object.fromEntries(
  RESEARCH_PROVIDER_IDS.map((id) => [
    id,
    ResearchProviderConfig.parse({ enabled: id === "eurostat" || id === "local_documents" }),
  ]),
) as Record<ResearchProviderId, ResearchProviderConfig>;
export const ResearchApiSettings = z
  .object({
    firecrawl: ResearchProviderConfig.default(DEFAULT_RESEARCH_APIS.firecrawl),
    youtube: ResearchProviderConfig.default(DEFAULT_RESEARCH_APIS.youtube),
    apify: ResearchProviderConfig.default(DEFAULT_RESEARCH_APIS.apify),
    x: ResearchProviderConfig.default(DEFAULT_RESEARCH_APIS.x),
    reddit: ResearchProviderConfig.default(DEFAULT_RESEARCH_APIS.reddit),
    openalex: ResearchProviderConfig.default(DEFAULT_RESEARCH_APIS.openalex),
    eurostat: ResearchProviderConfig.default(DEFAULT_RESEARCH_APIS.eurostat),
    local_documents: ResearchProviderConfig.default(DEFAULT_RESEARCH_APIS.local_documents),
    tavily: ResearchProviderConfig.default(DEFAULT_RESEARCH_APIS.tavily),
  })
  .strict()
  .default(DEFAULT_RESEARCH_APIS);

export const ResearchLimits = z
  .object({
    maxResults: z.number().int().min(1).max(1000).default(50),
    maxRequests: z.number().int().min(1).max(1000).default(100),
    maxDocumentPages: z.number().int().min(1).max(500).default(20),
    timeoutMs: z.number().int().min(1000).max(900000).default(120000),
    concurrency: z.number().int().min(1).max(8).default(3),
    retries: z.number().int().min(0).max(3).default(2),
    cacheMaxAgeMs: z.number().int().min(0).max(86400000).default(0),
    maxProviderCredits: z.number().int().min(1).optional(),
    maxApifyChargeUsd: z.number().positive().max(100).default(1),
  })
  .strict();
export type ResearchLimits = z.infer<typeof ResearchLimits>;
export const ResearchScope = z
  .object({
    brand: z.string().trim().min(1).default("BMW"),
    model: z.string().trim().min(1).default("5 Series"),
    currentGeneration: z.string().optional(),
    previousGeneration: z.string().optional(),
    derivative: z.string().optional(),
    propulsion: z.string().optional(),
    modelYear: z.string().optional(),
    markets: z.array(z.string().min(1)).default(["EU"]),
    languages: z.array(z.string().min(1)).default(["en", "de"]),
    publishedFrom: z.iso.date().optional(),
    publishedTo: z.iso.date().optional(),
    horizonYears: z.number().int().min(1).max(10).default(5),
    questions: z.array(z.string().trim().min(1)).default([]),
    keywords: z.array(z.string().trim().min(1)).default([]),
    competitors: z
      .array(
        z
          .object({
            brand: z.string().min(1),
            model: z.string().min(1),
            generation: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    allowedDomains: z.array(z.string()).default([]),
    blockedDomains: z.array(z.string()).default([]),
    urls: z.array(z.url()).default([]),
    documentIds: z.array(z.string().regex(/^file_[A-Za-z0-9_-]+$/)).default([]),
    eurostatDatasets: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9_]+$/),
            filters: z.record(z.string(), z.string()).default({}),
          })
          .strict(),
      )
      .default([]),
  })
  .strict()
  .refine(
    (s) => !s.publishedFrom || !s.publishedTo || s.publishedFrom <= s.publishedTo,
    "Publication start must precede end",
  );
export type ResearchScope = z.infer<typeof ResearchScope>;
export const ResearchRequest = z
  .object({
    agents: z.array(ResearchAgentId).min(1).max(13),
    scope: ResearchScope,
    limits: ResearchLimits.default(() => ResearchLimits.parse({})),
  })
  .strict();
export type ResearchRequest = z.infer<typeof ResearchRequest>;
export const RawRecordType = z.enum([
  "feedback",
  "passage",
  "transcript",
  "table",
  "product_description",
  "strategy_statement",
  "forecast",
  "metadata",
]);
export const ExplicitAttribute = z.object({
  value: z.string(),
  origin: z.enum(["source_explicit", "author_claim", "provider_metadata"]),
  locator: z.string().optional(),
});
export const RawTable = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  units: z.array(z.string()).default([]),
  footnotes: z.array(z.string()).default([]),
  dimensions: z.record(z.string(), z.unknown()).optional(),
});
/** Provider-owned original content. No model-generated evidence or classifications. */
export const CollectedItem = z
  .object({
    provider: ResearchProviderId,
    sourceId: z.string().min(1),
    sourceUrl: z.url(),
    sourceTitle: z.string().min(1),
    sourceKind: SourceKind.default("other_web"),
    publisher: z.string().optional(),
    recordId: z.string().min(1),
    recordType: RawRecordType,
    text: z.string(),
    publishedAt: z.string().optional(),
    datePrecision: z.enum(["instant", "day", "month", "year", "unknown"]).default("unknown"),
    language: z.string().optional(),
    market: ExplicitAttribute.optional(),
    vehicle: ExplicitAttribute.optional(),
    locator: z.string().optional(),
    parentId: z.string().optional(),
    threadId: z.string().optional(),
    context: z
      .object({
        id: z.string().optional(),
        url: z.string().optional(),
        text: z.string().optional(),
      })
      .optional(),
    table: RawTable.optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    limitations: z.array(z.string()).default([]),
  })
  .strict();
export type CollectedItem = z.infer<typeof CollectedItem>;
export const ResearchRecord = SourceRecord.extend({
  recordType: RawRecordType,
  originalSourceId: z.string(),
  originalRecordId: z.string(),
  provider: ResearchProviderId,
  originalUrl: z.url(),
  collectingAgents: z.array(ResearchAgentId),
  runIds: z.array(z.string()),
  retrievedAt: z.iso.datetime(),
  publishedAt: z.string().optional(),
  datePrecision: z.enum(["instant", "day", "month", "year", "unknown"]),
  marketAttribution: ExplicitAttribute.optional(),
  vehicleAttribution: ExplicitAttribute.optional(),
  parentId: z.string().optional(),
  threadId: z.string().optional(),
  context: CollectedItem.shape.context,
  table: RawTable.optional(),
  metadata: z.record(z.string(), z.unknown()),
  limitations: z.array(z.string()),
  contentHash: z.string(),
});
export type ResearchRecord = z.infer<typeof ResearchRecord>;
export const CollectionStatus = z.enum([
  "success",
  "empty",
  "partial",
  "missing_credentials",
  "blocked",
  "error",
  "cancelled",
]);
export type CollectionStatus = z.infer<typeof CollectionStatus>;
export const AgentCollectionResult = z.object({
  agentId: ResearchAgentId,
  status: CollectionStatus,
  recordIds: z.array(z.string()),
  limitations: z.array(z.string()),
  requests: z.number().int().nonnegative(),
});
export type AgentCollectionResult = z.infer<typeof AgentCollectionResult>;
export const ResearchDataset = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().startsWith("run_"),
  sources: z.array(Source),
  records: z.array(ResearchRecord),
  results: z.array(AgentCollectionResult),
  retrievedAt: z.iso.datetime(),
  synthetic: z.boolean().default(false),
});
export type ResearchDataset = z.infer<typeof ResearchDataset>;
export const ConnectionState = z.enum([
  "not_configured",
  "untested",
  "success",
  "invalid_credentials",
  "permission_required",
  "rate_limited",
  "unreachable",
  "unsupported",
]);
export const ConnectionReport = z.object({
  state: ConnectionState,
  message: z.string(),
  testedAt: z.iso.datetime().optional(),
  capabilities: z.array(z.string()).default([]),
  limitations: z.array(z.string()).default([]),
});
export type ConnectionReport = z.infer<typeof ConnectionReport>;
export const ResearchProviderStatus = z.object({
  id: ResearchProviderId,
  config: ResearchProviderConfig,
  credentialsConfigured: z.record(z.string(), z.boolean()),
  connection: ConnectionReport,
});
export type ResearchProviderStatus = z.infer<typeof ResearchProviderStatus>;
export const ResearchAgentDefinition = z.object({
  id: ResearchAgentId,
  label: z.string(),
  description: z.string(),
  providers: z.array(ResearchProviderId),
});
export type ResearchAgentDefinition = z.infer<typeof ResearchAgentDefinition>;
