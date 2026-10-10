import { Agent } from "@mastra/core/agent";
import {
  CollectedItem,
  DEFAULT_SETTINGS,
  RESEARCH_AGENT_IDS,
  RESEARCH_PROVIDER_IDS,
  ResearchRequest,
  SECRET_NAMES,
  type ResearchAgentId,
  type ResearchCollector,
  type ResearchDataset,
  type ResearchProviderId,
  type SecretName,
} from "@reqflow/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  type CollectionOutcome,
  type CollectionRequest,
  type ProviderAdapter,
  type ProviderContext,
} from "./provider";
import { createLocalDocumentsAdapter } from "./providers/documents";
import * as mastra from "./mastra";
import { assertJsonByteBudget, jsonByteSize, RESEARCH_DATASET_MAX_BYTES } from "./data-budget";
import { createResearchCollector } from "./runtime";

// Independent expectations: do not derive the routing oracle from RESEARCH_AGENTS.
const routes: [ResearchAgentId, ResearchProviderId[]][] = [
  ["reddit", ["reddit"]],
  ["youtube", ["youtube"]],
  ["instagram", ["apify"]],
  ["tiktok", ["apify"]],
  ["x", ["x"]],
  ["owner_forums", ["firecrawl"]],
  ["editorial_reviews", ["firecrawl"]],
  ["competitor_models", ["firecrawl"]],
  ["market_studies", ["firecrawl", "openalex"]],
  ["regional_context", ["eurostat", "firecrawl"]],
  ["technology", ["firecrawl", "openalex"]],
  ["bmw_sales", ["firecrawl", "local_documents"]],
  ["bmw_strategy", ["firecrawl", "local_documents"]],
];
function original(
  provider: ResearchProviderId,
  suffix: string,
  overrides: Partial<CollectedItem> = {},
): CollectedItem {
  return CollectedItem.parse({
    provider,
    sourceId: `synthetic-source-${suffix}`,
    sourceUrl:
      provider === "local_documents"
        ? `reqflow-file:///file_${suffix.replace(/[^A-Za-z0-9_-]/g, "_")}`
        : `https://${({ reddit: "www.reddit.com", youtube: "www.youtube.com", x: "x.com", openalex: "openalex.org", eurostat: "ec.europa.eu", apify: suffix.startsWith("tiktok") ? "www.tiktok.com" : "www.instagram.com" } as Partial<Record<ResearchProviderId, string>>)[provider] ?? (suffix.startsWith("bmw_") ? "www.bmwgroup.com" : "sources.example.org")}/${suffix}`,
    sourceTitle: `Synthetic original ${suffix}`,
    recordId: `synthetic-record-${suffix}`,
    recordType: "passage",
    text: `Synthetic source text ${suffix}\nOriginal — unchanged.`,
    metadata: { originalValue: 7, nested: { supplied: true } },
    ...overrides,
  });
}
function request(
  agents: ResearchAgentId[],
  limits: Partial<ResearchRequest["limits"]> = {},
  scope: Partial<ResearchRequest["scope"]> = {},
): ResearchRequest {
  return ResearchRequest.parse({
    agents,
    scope,
    limits: { maxResults: 100, maxRequests: 100, retries: 0, ...limits },
  });
}
function setup() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.research.provider = "firecrawl";
  for (const id of RESEARCH_PROVIDER_IDS)
    settings.research.apis[id] = {
      ...settings.research.apis[id],
      enabled: true,
      approval: "granted",
      allowedActors: ["apify/instagram-scraper", "clockworks/tiktok-scraper"],
    };
  const credentials: Partial<Record<SecretName, string>> = Object.fromEntries(
    SECRET_NAMES.filter((name) => name !== "anthropic_api_key").map((name) => [
      name,
      `synthetic-${name}`,
    ]),
  );
  const calls: [ResearchAgentId, ResearchProviderId][] = [];
  const adapters = new Map(
    RESEARCH_PROVIDER_IDS.map((id) => {
      const adapter: ProviderAdapter = {
        id,
        collect: vi.fn(
          async (input: CollectionRequest, _ctx: ProviderContext): Promise<CollectionOutcome> => {
            calls.push([input.agentId, id]);
            return {
              items: [original(id, `${input.agentId}-${id}`)],
              status: "success",
              limitations: [],
            };
          },
        ),
        test: vi.fn(async () => ({
          state: "untested" as const,
          message: "Synthetic adapter was not connection-tested.",
          capabilities: [],
          limitations: [],
        })),
      };
      return [id, adapter] as const;
    }),
  );
  const saved: ResearchDataset[] = [];
  const save = vi.fn(async (dataset: ResearchDataset) => {
    saved.push(structuredClone(dataset));
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    throw new Error("Unexpected synthetic network request");
  });
  const controller = new AbortController();
  const context: Parameters<ResearchCollector["collect"]>[1] & { planQueries?: boolean } = {
    runId: "run_synthetic",
    signal: controller.signal,
    log: vi.fn(),
    progress: vi.fn(),
  };
  const collect = (input: ResearchRequest, documents?: ProviderContext["documents"]) =>
    createResearchCollector({
      settings,
      credentials,
      adapters,
      save,
      fetchImpl,
      documents,
    }).collect(input, context);
  return {
    settings,
    credentials,
    adapters,
    calls,
    saved,
    save,
    fetchImpl,
    controller,
    context,
    collect,
  };
}
function replace(
  harness: ReturnType<typeof setup>,
  id: ResearchProviderId,
  collect: ProviderAdapter["collect"],
) {
  const adapter = harness.adapters.get(id)!;
  adapter.collect = vi.fn(collect);
  return adapter.collect;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Research collector routing and access gates", () => {
  it("routes all 13 selected agents to their explicit providers and preserves a result for each", async () => {
    const h = setup();

    const dataset = await h.collect(request([...RESEARCH_AGENT_IDS]));

    expect(h.calls).toEqual(
      routes.flatMap(([agent, providers]) => providers.map((provider) => [agent, provider])),
    );
    expect(dataset.results.map((result) => [result.agentId, result.status])).toEqual(
      RESEARCH_AGENT_IDS.map((id) => [id, "success"]),
    );
    expect(dataset.records).toHaveLength(18);
    expect(h.saved).toHaveLength(13);
    expect(h.saved.at(-1)).toEqual(dataset);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    for (const adapter of h.adapters.values()) expect(adapter.test).not.toHaveBeenCalled();
  });

  it("runs only the selected agents, once each, even when selection contains duplicates", async () => {
    const h = setup();

    const dataset = await h.collect(request(["youtube", "x", "youtube"]));

    expect(h.calls).toEqual([
      ["youtube", "youtube"],
      ["x", "x"],
    ]);
    expect(dataset.results.map((result) => result.agentId)).toEqual(["youtube", "x"]);
  });

  it("selects Firecrawl only when explicitly configured", async () => {
    const h = setup();

    await h.collect(request(["owner_forums"]));

    expect(h.calls).toEqual([["owner_forums", "firecrawl"]]);
    expect(h.adapters.get("tavily")!.collect).not.toHaveBeenCalled();
  });

  it.each(["off", "anthropic_web_search"] as const)(
    "blocks raw web collection for %s without paid fallback",
    async (provider) => {
      const h = setup();
      h.settings.research.provider = provider;
      const dataset = await h.collect(request(["owner_forums"]));
      expect(h.calls).toEqual([]);
      expect(dataset.results[0]).toMatchObject({ status: "blocked", requests: 0, recordIds: [] });
      expect(dataset.results[0]!.limitations.join(" ")).toMatch(
        provider === "off" ? /off/i : /unsupported.*raw|raw.*unsupported/i,
      );
      expect(h.saved.at(-1)).toEqual(dataset);
    },
  );

  it("keeps social, OpenAlex, Eurostat and local documents available when web research is off", async () => {
    const h = setup();
    h.settings.research.provider = "off";
    const dataset = await h.collect(request([...RESEARCH_AGENT_IDS]));
    expect(h.calls).toEqual(
      routes.flatMap(([agent, providers]) =>
        providers.filter((id) => id !== "firecrawl").map((id) => [agent, id]),
      ),
    );
    expect(dataset.results.find((result) => result.agentId === "youtube")?.status).toBe("success");
    expect(dataset.results.find((result) => result.agentId === "market_studies")?.status).toBe(
      "partial",
    );
  });

  it("uses Tavily in place of Firecrawl only when explicitly selected", async () => {
    const h = setup();
    h.settings.research.provider = "tavily";

    await h.collect(request(["owner_forums", "market_studies"]));

    expect(h.calls).toEqual([
      ["owner_forums", "tavily"],
      ["market_studies", "tavily"],
      ["market_studies", "openalex"],
    ]);
    expect(h.adapters.get("firecrawl")!.collect).not.toHaveBeenCalled();
  });

  it("does not fall back to another vendor when the selected provider fails", async () => {
    const h = setup();
    replace(h, "firecrawl", async () => {
      throw new ProviderError("unreachable", "Synthetic provider unavailable");
    });

    const dataset = await h.collect(request(["owner_forums"]));

    expect(dataset.results[0]).toMatchObject({
      status: "error",
      recordIds: [],
      limitations: ["firecrawl: Synthetic provider unavailable"],
    });
    expect(h.adapters.get("tavily")!.collect).not.toHaveBeenCalled();
    expect(dataset.records).toEqual([]);
  });

  it("reports an explicitly selected but disabled Tavily as blocked without Firecrawl fallback", async () => {
    const h = setup();
    h.settings.research.provider = "tavily";
    h.settings.research.apis.tavily.enabled = false;

    const dataset = await h.collect(request(["owner_forums"]));

    expect(dataset.results[0]).toMatchObject({
      status: "blocked",
      limitations: ["tavily: disabled in Research APIs Settings."],
    });
    expect(h.calls).toEqual([]);
  });

  it.each(["firecrawl", "tavily"] as const)(
    "does not substitute another paid vendor when %s credentials are missing",
    async (provider) => {
      const h = setup();
      h.settings.research.provider = provider;
      delete h.credentials[provider === "firecrawl" ? "firecrawl_api_key" : "tavily_api_key"];
      const dataset = await h.collect(request(["owner_forums"]));
      expect(dataset.results[0]).toMatchObject({ status: "missing_credentials", requests: 0 });
      expect(h.calls).toEqual([]);
    },
  );

  it.each([
    ["reddit", "reddit"],
    ["instagram", "apify"],
    ["youtube", "youtube"],
    ["x", "x"],
    ["owner_forums", "firecrawl"],
  ] as const)("reports disabled %s access without invoking %s", async (agent, provider) => {
    const h = setup();
    h.settings.research.apis[provider].enabled = false;

    const dataset = await h.collect(request([agent]));

    expect(dataset.results[0]).toMatchObject({
      agentId: agent,
      status: "blocked",
      recordIds: [],
      requests: 0,
      limitations: [`${provider}: disabled in Research APIs Settings.`],
    });
    expect(h.calls).toEqual([]);
    expect(h.saved.at(-1)).toEqual(dataset);
  });

  it.each([
    ["youtube", "youtube", "youtube_api_key"],
    ["x", "x", "x_bearer_token"],
    ["reddit", "reddit", "reddit_refresh_token"],
    ["instagram", "apify", "apify_api_token"],
  ] as const)(
    "reports missing credentials for %s without invoking %s",
    async (agent, provider, secret) => {
      const h = setup();
      delete h.credentials[secret];

      const dataset = await h.collect(request([agent]));

      expect(dataset.results[0]).toMatchObject({
        status: "missing_credentials",
        recordIds: [],
        requests: 0,
        limitations: [`${provider}: required credentials are missing.`],
      });
      expect(h.calls).toEqual([]);
    },
  );

  it.each([
    ["reddit", "reddit"],
    ["instagram", "apify"],
    ["tiktok", "apify"],
  ] as const)(
    "reports unapproved %s access as blocked despite configured credentials",
    async (agent, provider) => {
      const h = setup();
      h.settings.research.apis[provider].approval = "not_granted";

      const dataset = await h.collect(request([agent]));

      expect(dataset.results[0]).toMatchObject({
        status: "blocked",
        limitations: [`${provider}: usage approval not granted.`],
      });
      expect(h.calls).toEqual([]);
    },
  );

  it("permits the credential-optional OpenAlex adapter but still reports the other provider's gate", async () => {
    const h = setup();
    h.settings.research.apis.firecrawl.enabled = false;
    delete h.credentials.openalex_api_key;

    const dataset = await h.collect(request(["market_studies"]));

    expect(h.calls).toEqual([["market_studies", "openalex"]]);
    expect(dataset.results[0]).toMatchObject({
      status: "partial",
      recordIds: [dataset.records[0]!.id],
      limitations: ["firecrawl: disabled in Research APIs Settings."],
    });
  });

  it("reports a missing installed adapter explicitly rather than fabricating success", async () => {
    const h = setup();
    h.adapters.delete("youtube");

    const dataset = await h.collect(request(["youtube"]));

    expect(dataset.results[0]).toMatchObject({
      status: "blocked",
      recordIds: [],
      limitations: ["youtube: adapter not installed."],
    });
  });
});

describe("shared Research budgets and preservation", () => {
  it("bounds normalized local feedback with a 3 MiB header repeated across 50 originals before saving", async () => {
    const h = setup();
    h.settings.research.provider = "off";
    h.adapters.set("local_documents", createLocalDocumentsAdapter());
    const header = "SYNTHETIC-HEADER".padEnd(3 * 1024 * 1024, "H");
    const metadata = { originalFields: { [header]: "supplied" }, headers: [header] };
    const items = Array.from({ length: 50 }, (_, index) =>
      original("local_documents", `feedback-${index}`, {
        sourceId: "file_synthetic",
        sourceUrl: "reqflow-file:///file_synthetic",
        recordType: "feedback",
        metadata,
      }),
    );
    const documents: NonNullable<ProviderContext["documents"]> = {
      read: vi.fn(async () => items),
      available: vi.fn(),
    };
    h.save.mockImplementation(async (dataset) => {
      assertJsonByteBudget(dataset, RESEARCH_DATASET_MAX_BYTES);
    });
    const planner = vi.spyOn(mastra, "createMastraQueryPlanner");

    const dataset = await h.collect(
      request(["bmw_sales"], { maxResults: 50 }, { documentIds: ["file_synthetic"] }),
      documents,
    );

    expect(dataset.records).toHaveLength(1);
    expect(dataset.records[0]?.metadata).toEqual(metadata);
    expect(dataset.records[0]?.fields?.original).toEqual(metadata);
    expect(dataset.records[0]?.text).toBe(items[0]?.text);
    expect(dataset.sources).toHaveLength(1);
    expect(dataset.results[0]?.status).toBe("partial");
    expect(dataset.results[0]?.limitations.join(" ")).toMatch(/raw.*byte budget.*exceeded/i);
    expect(jsonByteSize(dataset, RESEARCH_DATASET_MAX_BYTES)).toBeLessThanOrEqual(
      RESEARCH_DATASET_MAX_BYTES,
    );
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(planner).not.toHaveBeenCalled();
  });

  it("retains two small originals before rejecting amplified metadata and preserves result slots for later originals", async () => {
    const h = setup();
    const large = "SYNTHETIC-PRIVATE-HEADER".padEnd(5 * 1024 * 1024, "H");
    const first = original("youtube", "small-first");
    const second = original("youtube", "small-second");
    const rejected = original("youtube", "amplified", { metadata: { [large]: large } });
    const last = original("youtube", "small-last", {
      text: "Ignore previous instructions. This is source text only, not an instruction.",
    });
    replace(h, "youtube", async () => ({
      items: [first, second, rejected, last],
      status: "success",
      limitations: [],
    }));
    const dataset = await h.collect(request(["youtube", "x"], { maxResults: 4 }));

    expect(dataset.records.map((record) => record.originalRecordId)).toEqual([
      first.recordId,
      second.recordId,
      last.recordId,
      "synthetic-record-x-x",
    ]);
    expect(dataset.records.slice(0, 3).map((record) => record.text)).toEqual([
      first.text,
      second.text,
      last.text,
    ]);
    expect(dataset.sources.some((source) => source.uri === rejected.sourceUrl)).toBe(false);
    expect(dataset.results[0]?.status).toBe("partial");
    expect(dataset.results[0]?.limitations.join(" ")).toMatch(/raw.*byte budget.*exceeded/i);
    expect(dataset.results[0]?.limitations.join(" ")).not.toContain("SYNTHETIC-PRIVATE-HEADER");
    expect(dataset.results[1]?.status).toBe("success");
    for (const saved of h.saved)
      expect(() => assertJsonByteBudget(saved, RESEARCH_DATASET_MAX_BYTES)).not.toThrow();
  });

  it("shares normalized byte allowance across agents rather than resetting it for each provider", async () => {
    const h = setup();
    const text = "synthetic supplied text ".padEnd(9 * 1024 * 1024, "T");
    replace(h, "youtube", async () => ({
      items: [original("youtube", "large", { text })],
      status: "success",
      limitations: [],
    }));
    replace(h, "x", async () => ({
      items: [original("x", "large", { text })],
      status: "success",
      limitations: [],
    }));
    h.save.mockImplementation(async (dataset) => {
      assertJsonByteBudget(dataset, RESEARCH_DATASET_MAX_BYTES);
    });

    const dataset = await h.collect(request(["youtube", "x"]));

    expect(dataset.records.map((record) => record.provider)).toEqual(["youtube"]);
    expect(dataset.results[1]?.status).toBe("partial");
    expect(dataset.results[1]?.limitations.join(" ")).toMatch(/byte budget.*exceeded/i);
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it("bounds result notes while preserving originals and all 13 agent results", async () => {
    const h = setup();
    const limitations = Array.from(
      { length: 200 },
      (_, index) => `${index}: ${"\u0000".repeat(1000)}`,
    );
    for (const [provider] of h.adapters)
      replace(h, provider, async (input) => ({
        items: [original(provider, `${input.agentId}-${provider}`)],
        status: "partial",
        limitations,
      }));

    const dataset = await h.collect(request([...RESEARCH_AGENT_IDS]));

    expect(dataset.results).toHaveLength(13);
    expect(dataset.records).toHaveLength(18);
    expect(dataset.results.every((result) => result.status === "partial")).toBe(true);
    expect(
      dataset.results.every((result) => result.limitations.every((note) => note.length <= 512)),
    ).toBe(true);
    expect(
      dataset.results.every((result) => result.limitations.some((note) => /omitted/i.test(note))),
    ).toBe(true);
    for (const saved of h.saved) assertJsonByteBudget(saved, RESEARCH_DATASET_MAX_BYTES);
  });

  it("reserves room for late limitation notes across all 13 agents near the byte ceiling", async () => {
    const h = setup();
    const text = "synthetic supplied text ".padEnd(
      RESEARCH_DATASET_MAX_BYTES - 128 * 1024 - 24 * 1024,
      "T",
    );
    const limitations = Array.from(
      { length: 100 },
      (_, index) => `${index}: ${"\u0000".repeat(512)}`,
    );
    for (const [provider] of h.adapters)
      replace(h, provider, async () => ({
        items: provider === "youtube" ? [original(provider, "near-limit", { text })] : [],
        status: "partial",
        limitations,
      }));
    h.save.mockImplementation(async (dataset) => {
      assertJsonByteBudget(dataset, RESEARCH_DATASET_MAX_BYTES);
    });

    const dataset = await h.collect(request([...RESEARCH_AGENT_IDS]));

    expect(dataset.records).toHaveLength(1);
    expect(dataset.records[0]?.text).toBe(text);
    expect(dataset.results).toHaveLength(13);
    expect(h.save).toHaveBeenCalledTimes(13);
    assertJsonByteBudget(dataset, RESEARCH_DATASET_MAX_BYTES);
  });

  it("keeps an explicit byte-limit note even after a provider floods result metadata", async () => {
    const h = setup();
    const text = "SYNTHETIC-PRIVATE-OVERSIZED".padEnd(RESEARCH_DATASET_MAX_BYTES, "T");
    replace(h, "youtube", async () => ({
      items: [original("youtube", "safe"), original("youtube", "too-large", { text })],
      status: "success",
      limitations: Array.from({ length: 200 }, (_, index) => `${index}: ${"N".repeat(512)}`),
    }));

    const dataset = await h.collect(request(["youtube"]));

    expect(dataset.records).toHaveLength(1);
    expect(dataset.results[0]?.status).toBe("partial");
    expect(dataset.results[0]?.limitations.join(" ")).toMatch(/raw.*byte budget.*exceeded/i);
    expect(dataset.results[0]?.limitations.join(" ")).not.toContain("SYNTHETIC-PRIVATE-OVERSIZED");
    expect(h.saved.at(-1)).toEqual(dataset);
  });

  it("rejects non-JSON original metadata before hashing without invoking supplied code", async () => {
    const h = setup();
    const toJSON = vi.fn(() => "synthetic private value");
    replace(h, "youtube", async () => ({
      items: [
        original("youtube", "safe"),
        original("youtube", "unsafe", { metadata: { nested: { toJSON } } }),
      ],
      status: "success",
      limitations: [],
    }));

    const dataset = await h.collect(request(["youtube"]));

    expect(dataset.records).toHaveLength(1);
    expect(dataset.results[0]?.status).toBe("partial");
    expect(toJSON).not.toHaveBeenCalled();
    expect(h.saved.at(-1)).toEqual(dataset);
  });

  it("checks actual complete dataset overhead before save even when no original was collected", async () => {
    const h = setup();
    h.context.runId = `run_${"R".repeat(RESEARCH_DATASET_MAX_BYTES)}`;
    h.settings.research.apis.youtube.enabled = false;

    await expect(h.collect(request(["youtube"]))).rejects.toThrow(
      expect.objectContaining({ code: "limit_reached" }),
    );
    expect(h.save).not.toHaveBeenCalled();
  });

  it("counts unique BMW documents, not duplicate originals, against the shared result budget", async () => {
    const h = setup();
    h.settings.research.apis.local_documents.enabled = false;
    const document = original("firecrawl", "bmw_publication", {
      sourceUrl: "https://www.bmwgroup.com/report.pdf",
    });
    replace(h, "firecrawl", async () => ({
      items: [document, structuredClone(document)],
      status: "success",
      limitations: [],
    }));
    const dataset = await h.collect(
      request(["bmw_sales", "bmw_strategy", "youtube"], { maxResults: 2 }),
    );
    expect(dataset.records).toHaveLength(2);
    expect(dataset.records[0]?.collectingAgents).toEqual(["bmw_sales", "bmw_strategy"]);
    expect(dataset.results[2]?.status).toBe("success");
  });

  it("retains valid originals when a later returned record is malformed", async () => {
    const h = setup();
    replace(h, "youtube", async () => ({
      items: [
        original("youtube", "valid"),
        { ...original("youtube", "invalid"), text: null } as unknown as CollectedItem,
      ],
      status: "success",
      limitations: [],
    }));
    const dataset = await h.collect(request(["youtube"]));
    expect(dataset.records).toHaveLength(1);
    expect(dataset.results[0]?.status).toBe("partial");
    expect(dataset.results[0]?.limitations.join(" ")).toMatch(/malformed/i);
    expect(h.saved.at(-1)).toEqual(dataset);
  });

  it("shares the result allowance across agents and stops providers when it is exhausted", async () => {
    const h = setup();
    const seenLimits: number[] = [];
    for (const id of ["youtube", "x", "firecrawl"] as const)
      replace(h, id, async (input, ctx) => {
        seenLimits.push(ctx.limits.maxResults);
        return { items: [original(id, input.agentId)], status: "success", limitations: [] };
      });

    const dataset = await h.collect(request(["youtube", "x", "owner_forums"], { maxResults: 2 }));

    expect(seenLimits).toEqual([2, 1]);
    expect(dataset.records).toHaveLength(2);
    expect(dataset.results[2]).toMatchObject({
      status: "partial",
      recordIds: [],
      requests: 0,
      limitations: ["Shared result limit reached."],
    });
    expect(h.adapters.get("firecrawl")!.collect).not.toHaveBeenCalled();
  });

  it("clips overfetched records but reports every physical HTTP request already made", async () => {
    const h = setup();
    h.fetchImpl.mockImplementation(async () => Response.json({ synthetic: true }));
    replace(h, "youtube", async (_input, ctx) => {
      for (let page = 0; page < 3; page++)
        await ctx.http.json(`https://www.googleapis.com/youtube/v3/search?synthetic-page=${page}`);
      return {
        items: Array.from({ length: 5 }, (_, i) => original("youtube", `overfetch-${i}`)),
        status: "partial",
        limitations: ["Synthetic adapter overfetched original records."],
      };
    });

    const dataset = await h.collect(request(["youtube", "x"], { maxResults: 2 }));

    expect(dataset.records).toHaveLength(2);
    expect(dataset.results.map((result) => result.requests)).toEqual([3, 0]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.adapters.get("x")!.collect).not.toHaveBeenCalled();
    expect(dataset.results[0]?.limitations).toContain(
      "Synthetic adapter overfetched original records.",
    );
  });

  it("shares the physical request allowance across agents without resetting it", async () => {
    const h = setup();
    h.fetchImpl.mockImplementation(async () => Response.json({ synthetic: true }));
    for (const provider of ["youtube", "x"] as const)
      replace(h, provider, async (input, ctx) => {
        for (let page = 0; page < 2; page++)
          await ctx.http.json(
            `https://api.openalex.org/works?synthetic-agent=${input.agentId}&page=${page}`,
          );
        return { items: [original(provider, input.agentId)], status: "success", limitations: [] };
      });

    const dataset = await h.collect(request(["youtube", "x"], { maxRequests: 3 }));

    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    expect(dataset.results.map((result) => result.requests)).toEqual([2, 1]);
    expect(dataset.results[1]).toMatchObject({
      status: "error",
      recordIds: [],
      limitations: ["x: Shared request budget exhausted."],
    });
    expect(dataset.records.map((record) => record.collectingAgents)).toEqual([["youtube"]]);
    expect(h.saved.at(-1)).toEqual(dataset);
  });

  it.each(["cancel", "deadline"] as const)(
    "preserves earlier original records and saves a cancelled result when %s interrupts later collection",
    async (reason) => {
      const h = setup();
      const deadline = new AbortController();
      if (reason === "deadline") vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      replace(h, "x", async (_input, ctx) => {
        expect(h.saved[0]?.records).toHaveLength(1);
        if (reason === "deadline")
          deadline.abort(new DOMException("Synthetic deadline", "TimeoutError"));
        else h.controller.abort();
        ctx.signal.throwIfAborted();
        throw new Error("Unreachable after synthetic cancellation");
      });

      const dataset = await h.collect(
        request(["youtube", "x", "owner_forums"], { timeoutMs: 1000 }),
      );

      expect(dataset.records).toEqual(h.saved[0]?.records);
      expect(dataset.results.map((result) => result.status)).toEqual([
        "success",
        "cancelled",
        "cancelled",
      ]);
      expect(h.saved.at(-1)).toEqual(dataset);
      expect(h.adapters.get("firecrawl")!.collect).not.toHaveBeenCalled();
    },
  );

  it("redacts injected credentials from adapter limitations and runtime logs", async () => {
    const h = setup();
    const value = h.credentials.youtube_api_key!;
    replace(h, "youtube", async (_input, ctx) => {
      ctx.log(`Synthetic rejected key ${value}`);
      throw new ProviderError("invalid_credentials", `Synthetic rejected key ${value}`);
    });

    const dataset = await h.collect(request(["youtube"]));

    expect(dataset.results[0]?.status).toBe("missing_credentials");
    expect(JSON.stringify(dataset.results)).not.toContain(value);
    expect(JSON.stringify(vi.mocked(h.context.log).mock.calls)).not.toContain(value);
    expect(dataset.results[0]?.limitations.join(" ")).toContain("[REDACTED]");
  });

  it("propagates persistence failure instead of reporting an unsaved successful collection", async () => {
    const h = setup();
    h.save.mockRejectedValueOnce(new Error("Synthetic storage unavailable"));

    await expect(h.collect(request(["youtube", "x"]))).rejects.toThrow(
      "Synthetic storage unavailable",
    );

    expect(h.adapters.get("x")!.collect).not.toHaveBeenCalled();
  });

  it("rejects invalid agent input before requesting or saving anything", async () => {
    const h = setup();
    const invalid = {
      ...request(["youtube"]),
      agents: ["synthetic_unknown"],
    } as unknown as ResearchRequest;

    await expect(h.collect(invalid)).rejects.toThrow();

    expect(h.calls).toEqual([]);
    expect(h.save).not.toHaveBeenCalled();
  });
});

describe("original local data and query-planner isolation", () => {
  it("retains structured originals with stable identities across the BMW agents, including undated local data", async () => {
    const h = setup();
    h.settings.research.apis.firecrawl.enabled = false;
    h.adapters.set("local_documents", createLocalDocumentsAdapter());
    const item = original("local_documents", "table", {
      sourceId: "file_synthetic",
      sourceUrl: "reqflow-file:///file_synthetic",
      recordId: "file_synthetic:sheet:1",
      recordType: "table",
      text: "Metric\tValue\nSynthetic count\t7",
      table: {
        headers: ["Metric", "Value"],
        rows: [["Synthetic count", 7]],
        units: ["vehicles"],
        footnotes: ["Synthetic footnote"],
      },
      metadata: {
        originalArtifact: { fileId: "file_synthetic" },
        sourceRows: [2],
        provenance: [{ page_no: 1, bbox: { l: 2 } }],
        extra: { supplied: false },
      },
    });
    const documents: NonNullable<ProviderContext["documents"]> = {
      read: vi.fn(async () => [structuredClone(item)]),
      available: vi.fn(async () => ({
        state: "untested" as const,
        message: "Not probed",
        capabilities: [],
        limitations: [],
      })),
    };

    const dataset = await h.collect(
      request(
        ["bmw_sales", "bmw_strategy"],
        {},
        { documentIds: ["file_synthetic"], publishedFrom: "2025-01-01" },
      ),
      documents,
    );

    expect(dataset.records).toHaveLength(1);
    expect(dataset.sources).toHaveLength(1);
    expect(dataset.records[0]).toMatchObject({
      text: item.text,
      table: item.table,
      metadata: item.metadata,
      originalRecordId: item.recordId,
      originalSourceId: item.sourceId,
      originalUrl: item.sourceUrl,
      datePrecision: "unknown",
      collectingAgents: ["bmw_sales", "bmw_strategy"],
      runIds: ["run_synthetic"],
    });
    expect(dataset.results.map((result) => result.recordIds)).toEqual([
      [dataset.records[0]!.id],
      [dataset.records[0]!.id],
    ]);
    expect(dataset.sources[0]?.reliability).toBeUndefined();
    expect(dataset.records[0]?.marketAttribution).toBeUndefined();
    expect(dataset.records[0]?.publishedAt).toBeUndefined();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("passes only search scope to real Mastra planners, never previously collected source text or credentials", async () => {
    const h = setup();
    h.settings.llm.provider = "anthropic";
    h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
    h.context.planQueries = true;
    const sourceText = "SYNTHETIC-ORIGINAL-DO-NOT-SEND-TO-MODEL";
    replace(h, "youtube", async () => ({
      items: [
        original("youtube", "private", {
          text: sourceText,
          metadata: { originalText: sourceText },
        }),
      ],
      status: "success",
      limitations: [],
    }));
    const prompts: string[] = [];
    const generate = vi.spyOn(Agent.prototype, "generate").mockImplementation(async (prompt) => {
      const text = String(prompt);
      prompts.push(text);
      const plan = JSON.parse(text) as { neutralQuery: string };
      return { object: { queries: [plan.neutralQuery] } } as Awaited<ReturnType<Agent["generate"]>>;
    });

    const dataset = await h.collect(
      request(
        ["youtube", "x"],
        {},
        {
          documentIds: ["file_synthetic_private"],
          urls: ["https://sources.example.org/private-document"],
        },
      ),
    );

    expect(generate).toHaveBeenCalledTimes(2);
    expect(dataset.records[0]?.text).toBe(sourceText);
    for (const prompt of prompts) {
      expect(prompt).not.toContain(sourceText);
      expect(prompt).not.toContain("file_synthetic_private");
      expect(prompt).not.toContain("private-document");
      for (const key of Object.values(h.credentials)) expect(prompt).not.toContain(key!);
    }
    expect(dataset.results.map((result) => result.requests)).toEqual([1, 1]);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("does not plan queries without an explicitly injected Anthropic credential", async () => {
    const h = setup();
    h.settings.llm.provider = "anthropic";
    h.context.planQueries = true;
    const generate = vi.spyOn(Agent.prototype, "generate").mockImplementation(async () => {
      throw new Error("Unexpected paid model call");
    });

    const dataset = await h.collect(request(["youtube"]));

    expect(generate).not.toHaveBeenCalled();
    expect(dataset.results[0]?.requests).toBe(0);
  });

  it("charges query planning and provider HTTP calls to the same shared request budget", async () => {
    const h = setup();
    h.settings.llm.provider = "anthropic";
    h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
    h.context.planQueries = true;
    const generate = vi.spyOn(Agent.prototype, "generate").mockImplementation(async (prompt) => {
      const plan = JSON.parse(String(prompt)) as { neutralQuery: string };
      return { object: { queries: [plan.neutralQuery] } } as Awaited<ReturnType<Agent["generate"]>>;
    });
    h.fetchImpl.mockImplementation(async () => Response.json({ synthetic: true }));
    replace(h, "youtube", async (_input, ctx) => {
      for (let page = 0; page < 2; page++)
        await ctx.http.json(`https://www.googleapis.com/youtube/v3/search?synthetic-page=${page}`);
      return { items: [original("youtube", "budget")], status: "success", limitations: [] };
    });

    const dataset = await h.collect(request(["youtube", "x"], { maxRequests: 2 }));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(dataset.results.reduce((total, result) => total + result.requests, 0)).toBe(2);
    expect(dataset.results.every((result) => result.status !== "success")).toBe(true);
    expect(h.adapters.get("x")!.collect).not.toHaveBeenCalled();
  });

  it("does not initialize paid planning without explicit opt-in, even with configured Anthropic credentials", async () => {
    const h = setup();
    h.settings.llm.provider = "anthropic";
    h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
    const planner = vi.spyOn(mastra, "createMastraQueryPlanner");
    const dataset = await h.collect(request(["youtube"]));
    expect(planner).not.toHaveBeenCalled();
    expect(dataset.results[0]?.requests).toBe(0);
    expect(h.calls).toEqual([["youtube", "youtube"]]);
  });

  it("supports explicit collector-option opt-in while a false context override keeps planning disabled", async () => {
    const h = setup();
    h.settings.llm.provider = "anthropic";
    h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
    const generate = vi
      .spyOn(Agent.prototype, "generate")
      .mockImplementation(
        async (prompt) =>
          ({ object: { queries: [JSON.parse(String(prompt)).neutralQuery] } }) as Awaited<
            ReturnType<Agent["generate"]>
          >,
      );
    const collector = createResearchCollector({ ...h, queryPlanning: true });
    expect((await collector.collect(request(["youtube"]), h.context)).results[0]?.requests).toBe(1);
    h.context.planQueries = false;
    expect((await collector.collect(request(["youtube"]), h.context)).results[0]?.requests).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("keeps collection deterministic when no request remains for both planning and collection", async () => {
    const h = setup();
    h.settings.llm.provider = "anthropic";
    h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
    h.context.planQueries = true;
    const planner = vi.spyOn(mastra, "createMastraQueryPlanner");
    h.fetchImpl.mockImplementation(async () => Response.json({ synthetic: true }));
    replace(h, "youtube", async (_input, ctx) => {
      await ctx.http.json("https://www.googleapis.com/youtube/v3/search");
      return { items: [original("youtube", "only-request")], status: "success", limitations: [] };
    });
    const dataset = await h.collect(request(["youtube"], { maxRequests: 1 }));
    expect(planner).not.toHaveBeenCalled();
    expect(dataset.results[0]).toMatchObject({ status: "success", requests: 1 });
  });

  it("counts HTTP retry attempts and planning in one global request budget", async () => {
    const h = setup();
    h.settings.llm.provider = "anthropic";
    h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
    h.context.planQueries = true;
    const generate = vi
      .spyOn(Agent.prototype, "generate")
      .mockImplementation(
        async (prompt) =>
          ({ object: { queries: [JSON.parse(String(prompt)).neutralQuery] } }) as Awaited<
            ReturnType<Agent["generate"]>
          >,
      );
    h.fetchImpl
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(Response.json({ synthetic: true }));
    replace(h, "youtube", async (_input, ctx) => {
      await ctx.http.json("https://www.googleapis.com/youtube/v3/search");
      return { items: [original("youtube", "retry")], status: "success", limitations: [] };
    });
    const dataset = await h.collect(request(["youtube", "x"], { maxRequests: 3, retries: 1 }));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(dataset.results.map((result) => result.requests)).toEqual([3, 0]);
    expect(h.adapters.get("x")!.collect).not.toHaveBeenCalled();
  });

  it("does not initialize planning for local documents and explicit Eurostat datasets", async () => {
    const h = setup();
    h.settings.research.provider = "off";
    h.settings.llm.provider = "anthropic";
    h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
    h.context.planQueries = true;
    const planner = vi.spyOn(mastra, "createMastraQueryPlanner");
    await h.collect(request(["regional_context", "bmw_sales"]));
    expect(planner).not.toHaveBeenCalled();
    expect(h.calls).toEqual([
      ["regional_context", "eurostat"],
      ["bmw_sales", "local_documents"],
    ]);
  });

  it.each(["disabled", "credentials", "approval", "actor", "domain", "off", "cancelled"] as const)(
    "does not initialize planning when collection is gated by %s",
    async (gate) => {
      const h = setup();
      h.settings.llm.provider = "anthropic";
      h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
      h.context.planQueries = true;
      const planner = vi.spyOn(mastra, "createMastraQueryPlanner");
      let agent: ResearchAgentId = "reddit";
      if (gate === "disabled") h.settings.research.apis.reddit.enabled = false;
      if (gate === "credentials") delete h.credentials.reddit_refresh_token;
      if (gate === "approval") h.settings.research.apis.reddit.approval = "not_granted";
      if (gate === "actor") {
        agent = "tiktok";
        h.settings.research.apis.apify.allowedActors = [];
      }
      if (gate === "off") {
        agent = "owner_forums";
        h.settings.research.provider = "off";
      }
      if (gate === "domain") h.settings.research.allowedDomains = ["bmwgroup.com"];
      if (gate === "cancelled") h.controller.abort();
      const dataset = await h.collect(request([agent]));
      expect(planner).not.toHaveBeenCalled();
      expect(h.calls).toEqual([]);
      expect(dataset.results[0]?.requests).toBe(0);
    },
  );

  it("does not plan after the shared result allowance is exhausted", async () => {
    const h = setup();
    h.settings.llm.provider = "anthropic";
    h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
    h.context.planQueries = true;
    const generate = vi
      .spyOn(Agent.prototype, "generate")
      .mockImplementation(
        async (prompt) =>
          ({ object: { queries: [JSON.parse(String(prompt)).neutralQuery] } }) as Awaited<
            ReturnType<Agent["generate"]>
          >,
      );
    const dataset = await h.collect(request(["youtube", "x"], { maxResults: 1 }));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(dataset.results[1]?.status).toBe("partial");
  });

  it("reports planning failure without deterministic fallback and preserves earlier agents' saved originals", async () => {
    const h = setup();
    h.settings.llm.provider = "anthropic";
    h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
    h.context.planQueries = true;
    vi.spyOn(Agent.prototype, "generate")
      .mockImplementationOnce(
        async (prompt) =>
          ({ object: { queries: [JSON.parse(String(prompt)).neutralQuery] } }) as Awaited<
            ReturnType<Agent["generate"]>
          >,
      )
      .mockRejectedValueOnce(new Error("Synthetic planning failure"));
    const dataset = await h.collect(request(["youtube", "x"]));
    expect(dataset.records).toHaveLength(1);
    expect(dataset.results[1]).toMatchObject({ status: "error", requests: 1, recordIds: [] });
    expect(dataset.results[1]?.limitations.join(" ")).toMatch(/planning failed/i);
    expect(h.adapters.get("x")!.collect).not.toHaveBeenCalled();
    expect(h.saved.at(-1)).toEqual(dataset);
  });
});

describe("Research source-domain policy", () => {
  it.each([
    ["reddit", "reddit", ["reddit.com"]],
    ["youtube", "youtube", ["youtube.com", "youtu.be"]],
    ["x", "x", ["x.com", "twitter.com"]],
    ["instagram", "apify", ["instagram.com"]],
    ["tiktok", "apify", ["tiktok.com"]],
  ] as const)("blocks %s before any social API call", async (agent, provider, blocked) => {
    const h = setup();
    const dataset = await h.collect(request([agent], {}, { blockedDomains: [...blocked] }));
    expect(h.adapters.get(provider)!.collect).not.toHaveBeenCalled();
    expect(dataset.results[0]).toMatchObject({ status: "blocked", requests: 0 });
    expect(dataset.results[0]?.limitations.join(" ")).toMatch(/domain/i);
  });

  it("matches normalized host boundaries, not API endpoints or lookalike suffixes", async () => {
    const h = setup();
    h.settings.research.allowedDomains = [" https://*.YouTube.COM./ "];
    h.fetchImpl.mockImplementation(async () => Response.json({ synthetic: true }));
    replace(h, "youtube", async (_input, ctx) => {
      await ctx.http.json("https://www.googleapis.com/youtube/v3/search");
      return {
        items: [
          original("youtube", "valid"),
          original("youtube", "lookalike", { sourceUrl: "https://youtube.com.evil.org/post" }),
        ],
        status: "success",
        limitations: [],
      };
    });
    const dataset = await h.collect(request(["youtube"]));
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(dataset.records).toHaveLength(1);
    expect(dataset.results[0]?.status).toBe("partial");
    expect(dataset.results[0]?.limitations.join(" ")).toMatch(/domain/i);
  });

  it("does not let request scope clear global blocked domains or widen allowed domains", async () => {
    const h = setup();
    h.settings.research.allowedDomains = ["example.org"];
    h.settings.research.blockedDomains = ["blocked.example.org"];
    const adapter = replace(h, "firecrawl", async (input) => {
      expect(input.scope.allowedDomains).toEqual(["news.example.org"]);
      expect(input.scope.blockedDomains).toEqual(["blocked.example.org"]);
      return {
        items: [
          original("firecrawl", "valid", { sourceUrl: "https://news.example.org/article" }),
          original("firecrawl", "blocked", { sourceUrl: "https://blocked.example.org/article" }),
        ],
        status: "success",
        limitations: [],
      };
    });
    const dataset = await h.collect(
      request(
        ["editorial_reviews"],
        {},
        { allowedDomains: ["news.example.org", "evil.org"], blockedDomains: [] },
      ),
    );
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(dataset.records).toHaveLength(1);
    expect(dataset.results[0]?.status).toBe("partial");
  });

  it("saves a blocked empty dataset for disjoint global and scoped allowlists, without treating [] as unrestricted", async () => {
    const h = setup();
    h.settings.research.allowedDomains = ["bmwgroup.com"];
    const dataset = await h.collect(
      request(["owner_forums"], {}, { allowedDomains: ["other.org"] }),
    );
    expect(h.calls).toEqual([]);
    expect(dataset.results[0]?.status).toBe("blocked");
    expect(dataset.results[0]?.limitations.join(" ")).toMatch(/intersection/i);
    expect(h.saved.at(-1)).toEqual(dataset);
  });

  it.each(["firecrawl", "tavily"] as const)(
    "restricts BMW official publications to official domains for %s",
    async (provider) => {
      const h = setup();
      h.settings.research.provider = provider;
      replace(h, provider, async (input) => {
        expect(input.scope.allowedDomains).toEqual(["bmwgroup.com", "press.bmwgroup.com"]);
        return {
          items: [
            original(provider, "official", { sourceUrl: "https://press.bmwgroup.com/report" }),
            original(provider, "unofficial", { sourceUrl: "https://bmwgroup.com.evil.org/report" }),
          ],
          status: "success",
          limitations: [],
        };
      });
      h.settings.research.apis.local_documents.enabled = false;
      const dataset = await h.collect(request(["bmw_sales"]));
      expect(dataset.records).toHaveLength(1);
      expect(dataset.results[0]?.status).toBe("partial");
    },
  );

  it("applies official BMW restrictions before paid planning but still retains authorized local documents", async () => {
    const h = setup();
    h.settings.llm.provider = "anthropic";
    h.credentials.anthropic_api_key = "synthetic-anthropic-injected-key";
    h.context.planQueries = true;
    h.settings.research.allowedDomains = ["other.org"];
    const planner = vi.spyOn(mastra, "createMastraQueryPlanner");
    const dataset = await h.collect(request(["bmw_sales"]));
    expect(planner).not.toHaveBeenCalled();
    expect(h.calls).toEqual([["bmw_sales", "local_documents"]]);
    expect(dataset.records).toHaveLength(1);
    expect(dataset.results[0]?.status).toBe("partial");
  });

  it("lets imported local documents bypass network domain restrictions", async () => {
    const h = setup();
    h.settings.research.provider = "off";
    h.settings.research.allowedDomains = ["only.example.org"];
    const dataset = await h.collect(
      request(["bmw_sales"], {}, { allowedDomains: ["disjoint.example.org"] }),
    );
    expect(h.calls).toEqual([["bmw_sales", "local_documents"]]);
    expect(dataset.records).toHaveLength(1);
  });
});
