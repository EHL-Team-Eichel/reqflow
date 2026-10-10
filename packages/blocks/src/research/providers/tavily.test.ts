import { describe, expect, it, vi } from "vitest";
import {
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
} from "@reqflow/core";
import {
  ProviderError,
  type CollectionRequest,
  type HttpOptions,
  type ProviderContext,
} from "../provider";
import { createTavilyAdapter } from "./tavily";

const url = "https://reviews.example.com/original";
const text =
  "Original: Die Bedienung ist anders. 空间宽敞。\n\n| Region | Wert |\n| --- | --- |\n| EU | 12 |";
const hit = (extra: Record<string, unknown> = {}) => ({
  url,
  title: "Original source title",
  content: "Search snippet only",
  raw_content: text,
  score: 0.9,
  ...extra,
});
const search = (...results: unknown[]) => ({
  query: "neutral supplied query",
  results,
  request_id: "fixture-search",
  usage: { credits: 1 },
});
function setup(responses: unknown[] = [], overrides: Partial<ProviderContext> = {}) {
  let requests = 0;
  const json = vi.fn(async (_url: string, _options?: HttpOptions) => {
    requests++;
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  });
  const ctx: ProviderContext = {
    http: {
      json: json as ProviderContext["http"]["json"],
      text: vi.fn(),
      get requests() {
        return requests;
      },
    },
    credentials: { tavily_api_key: "fixture-key" },
    config: ResearchProviderConfig.parse({ enabled: true }),
    limits: ResearchLimits.parse({ maxResults: 3 }),
    signal: new AbortController().signal,
    log: vi.fn(),
    now: () => "2026-10-10T12:00:00.000Z",
    ...overrides,
  };
  const request: CollectionRequest = {
    agentId: "competitor_models",
    scope: ResearchScope.parse({}),
    queries: ["neutral supplied query"],
  };
  return { ctx, json, request, adapter: createTavilyAdapter() };
}

describe("Tavily alternative original web collection", () => {
  it("requests raw markdown without generated answers, preserves originals and leaves unknown attribution empty", async () => {
    const { ctx, json, request, adapter } = setup([
      { ...search(hit()), answer: "Generated answer; ignore" },
    ]);
    const result = await adapter.collect(request, ctx);
    expect(result.items).toHaveLength(1);
    expect(json.mock.calls[0]).toEqual([
      "https://api.tavily.com/search",
      expect.objectContaining({
        signal: ctx.signal,
        headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" },
        body: expect.objectContaining({
          query: request.queries[0],
          search_depth: "basic",
          topic: "general",
          max_results: 3,
          include_answer: false,
          include_raw_content: "markdown",
          auto_parameters: false,
        }),
      }),
    ]);
    expect(result.items[0]).toMatchObject({
      provider: "tavily",
      sourceUrl: url,
      text,
      sourceKind: "other_web",
      recordType: "passage",
      datePrecision: "unknown",
      metadata: { search: { content: "Search snippet only", score: 0.9 } },
    });
    for (const field of ["publishedAt", "market", "vehicle", "language", "sentiment"])
      expect(result.items[0]).not.toHaveProperty(field);
    expect(JSON.stringify(result.items)).not.toContain("Generated answer; ignore");
    expect(CollectedItem.safeParse(result.items[0]).success).toBe(true);
    // Tavily does not promise target status or final redirect metadata.
    expect(result.status).toBe("partial");
    expect(result.limitations.join(" ")).toMatch(/redirect/i);
  });

  it.each([null, "", " \n"])(
    "does not turn snippets into evidence when raw_content is %j",
    async (raw_content) => {
      const { ctx, json, request, adapter } = setup([search(hit({ raw_content }))]);
      expect(await adapter.collect(request, ctx)).toMatchObject({ status: "error", items: [] });
      expect(json).toHaveBeenCalledTimes(1); // No automatic paid fallback, even within another provider.
    },
  );

  it("keeps a later original for a URL whose earlier query only returned a snippet", async () => {
    const { ctx, request, adapter } = setup([search(hit({ raw_content: null })), search(hit())]);
    request.queries.push("second supplied query");
    expect(await adapter.collect(request, ctx)).toMatchObject({
      status: "partial",
      items: [expect.objectContaining({ text })],
    });
  });

  it("keeps valid originals when another hit or extraction failure is malformed", async () => {
    const { ctx, request, adapter } = setup([
      { results: [{ url, raw_content: text }], failed_results: [null] },
      search(null, hit({ url: "https://reviews.example.com/second" })),
    ]);
    request.scope.urls = [url];
    const result = await adapter.collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(2);
  });

  it("never accepts a recognizable anti-bot body as original evidence", async () => {
    const { ctx, request, adapter } = setup([
      search(hit({ raw_content: "# Access denied\nYou have been blocked." })),
    ]);
    expect(await adapter.collect(request, ctx)).toMatchObject({ status: "blocked", items: [] });
  });

  it("extracts explicit URLs using Tavily only and keeps failures partial", async () => {
    const second = "https://reviews.example.com/unavailable";
    const { ctx, json, request, adapter } = setup([
      { results: [{ url, raw_content: text }], failed_results: [] },
      { results: [], failed_results: [{ url: second, error: "403 Forbidden" }] },
    ]);
    request.scope.urls = [url, second];
    request.queries = [];
    const result = await adapter.collect(request, ctx);
    expect(result).toMatchObject({
      status: "partial",
      items: [expect.objectContaining({ text, provider: "tavily" })],
    });
    expect(json.mock.calls[0]).toEqual([
      "https://api.tavily.com/extract",
      expect.objectContaining({
        signal: ctx.signal,
        body: expect.objectContaining({ urls: [url], extract_depth: "basic", format: "markdown" }),
      }),
    ]);
    expect(json.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "https://api.tavily.com/extract",
      "https://api.tavily.com/extract",
    ]);
    expect(json.mock.calls[0]?.[1]?.body as Record<string, unknown>).not.toHaveProperty("query");
  });

  it("enforces domain policy for search, explicit URLs, and supplied redirect metadata", async () => {
    const { ctx, json, request, adapter } = setup([
      search(
        hit({ url: "https://example.com.evil.org/a" }),
        hit({ url: "https://blocked.example.com/a" }),
        hit({ metadata: { url: "http://127.0.0.1/secret", statusCode: 200 } }),
      ),
    ]);
    request.scope.allowedDomains = ["example.com"];
    request.scope.blockedDomains = ["blocked.example.com"];
    expect(await adapter.collect(request, ctx)).toMatchObject({ status: "blocked", items: [] });
    expect(json.mock.calls[0]?.[1]?.body).toMatchObject({
      include_domains: ["example.com"],
      exclude_domains: ["blocked.example.com"],
    });
    const explicit = setup();
    explicit.request.scope.urls = ["http://localhost/a"];
    explicit.request.queries = [];
    expect(await explicit.adapter.collect(explicit.request, explicit.ctx)).toMatchObject({
      status: "blocked",
      items: [],
    });
    expect(explicit.json).not.toHaveBeenCalled();
  });

  it.each([
    "http://169.254.169.254/a",
    "http://[::1]/a",
    "http://10.0.0.1/a",
    "https://host.local/a",
    "ftp://example.com/a",
  ])("rejects non-public source %s", async (unsafe) => {
    const { ctx, request, adapter } = setup([search(hit({ url: unsafe }))]);
    expect(await adapter.collect(request, ctx)).toMatchObject({ status: "blocked", items: [] });
  });

  it("rejects known PDFs instead of ignoring page limits or silently buying Firecrawl scrapes", async () => {
    const pdf = "https://studies.example.com/report.pdf";
    const { ctx, json, request, adapter } = setup([search(hit({ url: pdf }))], {
      credentials: { tavily_api_key: "fixture-key", firecrawl_api_key: "unused-fixture-key" },
    });
    request.scope.urls = [pdf];
    const result = await adapter.collect(request, ctx);
    expect(result.items).toEqual([]);
    expect(result.status).not.toBe("success");
    expect(result.limitations.join(" ")).toMatch(/PDF.*page/i);
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0]?.[0]).toBe("https://api.tavily.com/search");
  });

  it("rejects target 403 bodies even when raw_content is populated", async () => {
    const { ctx, request, adapter } = setup([
      search(hit({ raw_content: "Forbidden", metadata: { statusCode: 403, url } })),
    ]);
    expect(await adapter.collect(request, ctx)).toMatchObject({ status: "blocked", items: [] });
  });

  it("preserves only dates actually supplied and flags Tavily publication estimates", async () => {
    const { ctx, request, adapter } = setup([
      search(hit({ published_date: "Tue, 11 Mar 2025 17:00:00 GMT" })),
    ]);
    const result = await adapter.collect(request, ctx);
    expect(result.items[0]).toMatchObject({
      publishedAt: "Tue, 11 Mar 2025 17:00:00 GMT",
      datePrecision: "instant",
    });
    expect(result.items[0]?.limitations.join(" ")).toMatch(/estimate/i);
  });

  it.each([
    {},
    { results: "no" },
    { results: [null] },
    { detail: { error: "Internal Server Error" } },
  ])("handles protocol errors %j", async (response) => {
    const { ctx, request, adapter } = setup([response]);
    expect(await adapter.collect(request, ctx)).toMatchObject({ status: "error", items: [] });
  });

  it("reports valid empty search as empty", async () => {
    const { ctx, request, adapter } = setup([search()]);
    expect(await adapter.collect(request, ctx)).toEqual({
      status: "empty",
      items: [],
      limitations: [],
    });
  });

  it("preserves successful raw originals when another query fails", async () => {
    const { ctx, request, adapter } = setup([
      search(hit()),
      new ProviderError("rate_limited", "fixture-key", 429),
    ]);
    request.queries.push("second supplied query");
    const result = await adapter.collect(request, ctx);
    expect(result).toMatchObject({ status: "partial", items: [expect.objectContaining({ text })] });
    expect(result.limitations.join(" ")).not.toContain("fixture-key");
  });

  it("caps search results, deduplicates URLs and stops at request budget", async () => {
    const { ctx, json, request, adapter } = setup([search(hit(), hit())], {
      limits: ResearchLimits.parse({ maxRequests: 1, maxResults: 1 }),
    });
    request.queries.push("second query");
    expect((await adapter.collect(request, ctx)).items).toHaveLength(1);
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0]?.[1]?.body).toMatchObject({ max_results: 1 });
  });

  it("checks missing credentials and cancellation before paid requests", async () => {
    const missing = setup([], { credentials: {} });
    expect(await missing.adapter.collect(missing.request, missing.ctx)).toMatchObject({
      status: "missing_credentials",
    });
    expect(await missing.adapter.test(missing.ctx)).toMatchObject({ state: "not_configured" });
    expect(missing.json).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    const cancelled = setup([], { signal: controller.signal });
    expect(await cancelled.adapter.collect(cancelled.request, cancelled.ctx)).toMatchObject({
      status: "cancelled",
      items: [],
    });
    expect(cancelled.json).not.toHaveBeenCalled();
  });
});

describe("Tavily connection test", () => {
  it("uses one small deterministic basic search, not a raw-content scrape", async () => {
    const { ctx, json, adapter } = setup([search()]);
    expect(await adapter.test(ctx)).toMatchObject({ state: "success", testedAt: ctx.now() });
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0]?.[1]?.body).toMatchObject({
      query: "site:example.com Example Domain",
      max_results: 1,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      auto_parameters: false,
    });
  });

  it.each([
    new ProviderError("invalid_credentials", "fixture-key", 401),
    { detail: { error: "Unauthorized: missing or invalid API key." } },
  ])("handles invalid credentials without exposing secrets", async (response) => {
    const { ctx, adapter } = setup([response]);
    const report = await adapter.test(ctx);
    expect(report.state).toBe("invalid_credentials");
    expect(report.message).not.toContain("fixture-key");
  });

  it.each(["invalid\nkey", "invalid key"])("rejects malformed key before HTTP", async (key) => {
    const { ctx, json, adapter } = setup([], { credentials: { tavily_api_key: key } });
    expect(await adapter.test(ctx)).toMatchObject({ state: "invalid_credentials" });
    expect(json).not.toHaveBeenCalled();
  });
});
