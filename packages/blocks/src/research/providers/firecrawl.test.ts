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
import { createFirecrawlAdapter } from "./firecrawl";

const url = "https://reviews.example.com/original?lang=de";
const original =
  "Die Bedienung bleibt uneinheitlich. 舒适性很好。\n\n| Jahr | Absatz |\n| --- | --- |\n| 2025 | 120 |";
const search = (...urls: string[]) => ({
  success: true,
  data: {
    web: urls.map((url) => ({
      url,
      title: "Source title",
      description: "Search snippet, not evidence",
    })),
  },
});
const scrape = (metadata: Record<string, unknown> = {}, markdown = original) => ({
  success: true,
  data: {
    markdown,
    rawHtml: "<article>Original HTML</article>",
    summary: "Generated; ignore",
    metadata: { title: "Original title", sourceURL: url, url, statusCode: 200, ...metadata },
  },
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
    credentials: { firecrawl_api_key: "fixture-key" },
    config: ResearchProviderConfig.parse({ enabled: true }),
    limits: ResearchLimits.parse({ maxResults: 3 }),
    signal: new AbortController().signal,
    log: vi.fn(),
    now: () => "2026-10-10T12:00:00.000Z",
    ...overrides,
  };
  const request: CollectionRequest = {
    agentId: "editorial_reviews",
    scope: ResearchScope.parse({}),
    queries: ["neutral supplied query"],
  };
  return { ctx, json, request, adapter: createFirecrawlAdapter() };
}

describe("Firecrawl original web collection", () => {
  it("uses v2 search followed by a bounded original scrape, preserving multilingual text and tables", async () => {
    const { ctx, json, request, adapter } = setup([
      search(url),
      scrape({
        language: "de",
        publisher: "Source publisher",
        "article:published_time": "2025-02-03",
      }),
    ]);
    const result = await adapter.collect(request, ctx);
    expect(result.status).toBe("success");
    expect(json.mock.calls[0]).toEqual([
      "https://api.firecrawl.dev/v2/search",
      expect.objectContaining({
        signal: ctx.signal,
        headers: { Authorization: "Bearer fixture-key", "Content-Type": "application/json" },
        body: expect.objectContaining({
          query: request.queries[0],
          sources: ["web"],
          limit: 3,
          highlights: false,
          domainTools: false,
        }),
      }),
    ]);
    expect(json.mock.calls[1]).toEqual([
      "https://api.firecrawl.dev/v2/scrape",
      expect.objectContaining({
        signal: ctx.signal,
        body: expect.objectContaining({
          url,
          formats: ["markdown", "rawHtml"],
          onlyMainContent: false,
          onlyCleanContent: false,
          skipTlsVerification: false,
          maxAge: 0,
          parsers: [{ type: "pdf", maxPages: 20, pages: true }],
        }),
      }),
    ]);
    expect(result.items[0]).toMatchObject({
      provider: "firecrawl",
      sourceUrl: url,
      sourceTitle: "Original title",
      text: original,
      recordType: "passage",
      sourceKind: "other_web",
      language: "de",
      publisher: "Source publisher",
      publishedAt: "2025-02-03",
      datePrecision: "day",
      metadata: {
        rawHtml: "<article>Original HTML</article>",
        search: { description: "Search snippet, not evidence" },
      },
    });
    expect(result.items[0]).not.toHaveProperty("market");
    expect(result.items[0]).not.toHaveProperty("vehicle");
    expect(JSON.stringify(result.items)).not.toContain("Generated; ignore");
    expect(CollectedItem.safeParse(result.items[0]).success).toBe(true);
  });

  it.each([
    "owner_forums",
    "editorial_reviews",
    "competitor_models",
    "market_studies",
    "regional_context",
    "technology",
    "bmw_sales",
    "bmw_strategy",
  ] as const)("does not classify source content from %s agent", async (agentId) => {
    const { ctx, request, adapter } = setup([search(url), scrape()]);
    const result = await adapter.collect({ ...request, agentId }, ctx);
    expect(result.items[0]).toMatchObject({ recordType: "passage", sourceKind: "other_web" });
    expect(result.items[0]).not.toHaveProperty("sentiment");
  });

  it("leaves publication and language unknown, never using retrieval time or requested scope", async () => {
    const { ctx, request, adapter } = setup([search(url), scrape()]);
    const result = await adapter.collect(request, ctx);
    expect(result.items[0]).toMatchObject({ datePrecision: "unknown" });
    expect(result.items[0]).not.toHaveProperty("publishedAt");
    expect(result.items[0]).not.toHaveProperty("language");
  });

  it("scrapes explicit URLs without a search and deduplicates discovered URLs", async () => {
    const { ctx, json, request, adapter } = setup([scrape(), search(url)]);
    request.scope.urls = [url, url];
    expect((await adapter.collect(request, ctx)).items).toHaveLength(1);
    expect(json.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "https://api.firecrawl.dev/v2/scrape",
      "https://api.firecrawl.dev/v2/search",
    ]);
  });

  it.each([403, 401, 429, 500])(
    "rejects API-success bodies when target status is %s",
    async (statusCode) => {
      const { ctx, request, adapter } = setup([
        search(url),
        scrape({ statusCode }, "Access denied"),
      ]);
      const result = await adapter.collect(request, ctx);
      expect(result.items).toEqual([]);
      expect(["blocked", "error"]).toContain(result.status);
      expect(result.limitations.join(" ")).toContain(String(statusCode));
    },
  );

  it.each(["", " \n\t"])(
    "does not substitute search snippets or generated summaries for empty originals",
    async (markdown) => {
      const { ctx, request, adapter } = setup([search(url), scrape({}, markdown)]);
      const result = await adapter.collect(request, ctx);
      expect(result).toMatchObject({ status: "error", items: [] });
      expect(result.limitations.join(" ")).toMatch(/original/i);
    },
  );

  it.each([
    "# Access denied\nYou do not have permission to view this page.",
    "# Just a moment...\nVerify you are human before continuing.",
  ])("rejects recognizable blocked originals even with target HTTP 200", async (markdown) => {
    const { ctx, request, adapter } = setup([search(url), scrape({}, markdown)]);
    expect(await adapter.collect(request, ctx)).toMatchObject({ status: "blocked", items: [] });
  });

  it("retains valid sources when another search hit is malformed", async () => {
    const { ctx, request, adapter } = setup([
      { success: true, data: { web: [null, { url }] } },
      scrape(),
    ]);
    expect(await adapter.collect(request, ctx)).toMatchObject({
      status: "partial",
      items: [expect.objectContaining({ text: original })],
    });
  });

  it("bounds overlong provider hit arrays to the requested limit", async () => {
    const { ctx, json, request, adapter } = setup(
      [search(url, "https://reviews.example.com/ignored"), scrape({ statusCode: 403 })],
      { limits: ResearchLimits.parse({ maxResults: 1 }) },
    );
    const result = await adapter.collect(request, ctx);
    expect(result.status).not.toBe("success");
    expect(json).toHaveBeenCalledTimes(2);
    expect(result.limitations.join(" ")).toMatch(/more.*hits.*requested/i);
  });

  it("reports missing requested raw HTML as a limitation for an HTML source", async () => {
    const response = scrape({ contentType: "text/html" });
    delete (response.data as Record<string, unknown>).rawHtml;
    const { ctx, request, adapter } = setup([search(url), response]);
    expect(await adapter.collect(request, ctx)).toMatchObject({
      status: "partial",
      items: [expect.objectContaining({ text: original })],
    });
  });

  it("reports missing target status and redirect metadata as access limitations", async () => {
    const response = scrape();
    delete (response.data.metadata as Record<string, unknown>).statusCode;
    delete (response.data.metadata as Record<string, unknown>).url;
    const { ctx, request, adapter } = setup([search(url), response]);
    const result = await adapter.collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(result.limitations.join(" ")).toMatch(/status.*not provided/i);
    expect(result.limitations.join(" ")).toMatch(/redirect/i);
  });

  it("enforces allowed and blocked domains independently and at label boundaries", async () => {
    const { ctx, json, request, adapter } = setup([
      search("https://reviews.example.com.evil.org/a", "https://blocked.example.com/a", url),
      scrape(),
    ]);
    request.scope.allowedDomains = ["example.com"];
    request.scope.blockedDomains = ["blocked.example.com"];
    const result = await adapter.collect(request, ctx);
    expect(result.items).toHaveLength(1);
    expect(result.status).toBe("partial");
    const body = json.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body.includeDomains).toEqual(["example.com"]);
    expect(body).not.toHaveProperty("excludeDomains"); // Firecrawl makes these mutually exclusive.
    expect(json).toHaveBeenCalledTimes(2);
  });

  it.each([
    "http://localhost/a",
    "http://127.0.0.1/a",
    "http://2130706433/a",
    "http://10.0.0.1/a",
    "http://169.254.169.254/a",
    "http://[::1]/a",
    "http://[::ffff:127.0.0.1]/a",
    "https://server.local/a",
    "https://intranet/a",
    "file:///tmp/a",
    "https://user:pass@example.com/a",
  ])("never scrapes unsafe URL %s", async (unsafe) => {
    const { ctx, json, request, adapter } = setup([search(unsafe)]);
    const result = await adapter.collect(request, ctx);
    expect(result).toMatchObject({ status: "blocked", items: [] });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it.each(["http://192.168.1.2/a", "https://blocked.example.com/a", "https://unlisted.org/a"])(
    "rejects final redirect URL %s",
    async (redirect) => {
      const { ctx, request, adapter } = setup([search(url), scrape({ url: redirect })]);
      request.scope.allowedDomains = ["example.com"];
      request.scope.blockedDomains = ["blocked.example.com"];
      expect(await adapter.collect(request, ctx)).toMatchObject({ status: "blocked", items: [] });
    },
  );

  it("preserves safe final URL separately from original URL and metadata", async () => {
    const finalUrl = "https://reviews.example.com/final";
    const { ctx, request, adapter } = setup([search(url), scrape({ url: finalUrl })]);
    const item = (await adapter.collect(request, ctx)).items[0];
    expect(item).toMatchObject({
      sourceUrl: url,
      metadata: { finalUrl, sourceURL: url, url: finalUrl },
    });
  });

  it("passes PDF cap using v2 parser objects and marks truncated documents partial", async () => {
    const pdf = "https://studies.example.com/report.pdf";
    const { ctx, json, request, adapter } = setup(
      [
        scrape({
          sourceURL: pdf,
          url: pdf,
          contentType: "application/pdf",
          numPages: 2,
          totalPages: 19,
        }),
      ],
      { limits: ResearchLimits.parse({ maxDocumentPages: 2 }) },
    );
    request.scope.urls = [pdf];
    request.queries = [];
    const result = await adapter.collect(request, ctx);
    expect(result).toMatchObject({
      status: "partial",
      items: [expect.objectContaining({ text: original })],
    });
    expect((json.mock.calls[0]?.[1]?.body as Record<string, unknown>).parsers).toEqual([
      { type: "pdf", maxPages: 2, pages: true },
    ]);
    expect(result.limitations.join(" ")).toMatch(/2.*19/);
  });

  it("rejects a provider document exceeding the requested page cap", async () => {
    const { ctx, request, adapter } = setup([
      search(url),
      scrape({ numPages: 21, totalPages: 21 }),
    ]);
    expect(await adapter.collect(request, ctx)).toMatchObject({ status: "error", items: [] });
  });

  it("retains good originals across per-page errors and later search errors", async () => {
    const bad = "https://reviews.example.com/bad";
    const { ctx, request, adapter } = setup([
      search(url, bad),
      scrape(),
      new ProviderError("unreachable", "Do not echo fixture-key"),
      { success: false, error: "Server error" },
    ]);
    request.queries.push("second neutral query");
    const result = await adapter.collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(result.limitations.join(" ")).not.toContain("fixture-key");
  });

  it.each([
    { success: false, error: "failed" },
    { success: true, data: [] },
    { success: true, data: {} },
    { data: { web: [] } },
    { success: true, data: { web: [null, { url: 42 }] } },
  ])("treats protocol errors as errors, not empty successes: %j", async (response) => {
    const { ctx, request, adapter } = setup([response]);
    expect(await adapter.collect(request, ctx)).toMatchObject({ status: "error", items: [] });
  });

  it("valid empty search returns empty", async () => {
    const { ctx, request, adapter } = setup([search()]);
    expect(await adapter.collect(request, ctx)).toEqual({
      status: "empty",
      items: [],
      limitations: [],
    });
  });

  it("enforces request and result bounds without discarding already collected content", async () => {
    const { ctx, json, request, adapter } = setup(
      [search(url, "https://reviews.example.com/next"), scrape()],
      { limits: ResearchLimits.parse({ maxRequests: 2, maxResults: 1 }) },
    );
    request.queries.push("another query");
    const result = await adapter.collect(request, ctx);
    expect(result).toMatchObject({
      status: "partial",
      items: [expect.objectContaining({ text: original })],
    });
    expect(json).toHaveBeenCalledTimes(2);
    expect((json.mock.calls[0]?.[1]?.body as Record<string, unknown>).limit).toBe(1);
  });

  it("reports request exhaustion with no original, without a scrape request", async () => {
    const { ctx, json, request, adapter } = setup([search(url)], {
      limits: ResearchLimits.parse({ maxRequests: 1 }),
    });
    expect(await adapter.collect(request, ctx)).toMatchObject({ status: "partial", items: [] });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it("honors abort before requests and preserves already collected items on cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const initial = setup([], { signal: controller.signal });
    expect(await initial.adapter.collect(initial.request, initial.ctx)).toMatchObject({
      status: "cancelled",
      items: [],
    });
    expect(initial.json).not.toHaveBeenCalled();
    const later = setup([search(url), scrape(), new ProviderError("cancelled", "cancelled")]);
    later.request.queries.push("second query");
    expect(await later.adapter.collect(later.request, later.ctx)).toMatchObject({
      status: "partial",
      items: [expect.objectContaining({ text: original })],
    });
  });

  it("reports unknown publication within a requested date window instead of inventing a date", async () => {
    const { ctx, request, adapter } = setup([search(url), scrape()]);
    request.scope.publishedFrom = "2025-01-01";
    request.scope.publishedTo = "2025-12-31";
    const result = await adapter.collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items[0]).toMatchObject({ datePrecision: "unknown" });
    expect(result.limitations.join(" ")).toMatch(/publication/i);
  });

  it("validates malformed domain scope before making any paid requests", async () => {
    const { ctx, json, request, adapter } = setup();
    request.scope.allowedDomains = ["example.com/path"];
    expect(await adapter.collect(request, ctx)).toMatchObject({ status: "error", items: [] });
    expect(json).not.toHaveBeenCalled();
  });
});

describe("Firecrawl connection test", () => {
  it("uses one deterministic cheap search, never scraping content", async () => {
    const { ctx, json, adapter } = setup([search()]);
    expect(await adapter.test(ctx)).toMatchObject({ state: "success", testedAt: ctx.now() });
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0]).toEqual([
      "https://api.firecrawl.dev/v2/search",
      expect.objectContaining({
        signal: ctx.signal,
        body: expect.objectContaining({
          query: "site:example.com Example Domain",
          limit: 1,
          sources: ["web"],
        }),
      }),
    ]);
    expect(json.mock.calls[0]?.[1]?.body as Record<string, unknown>).not.toHaveProperty(
      "scrapeOptions",
    );
  });

  it.each([{}, { firecrawl_api_key: " " }])(
    "missing keys make no requests",
    async (credentials) => {
      const { ctx, json, request, adapter } = setup([], { credentials });
      expect(await adapter.collect(request, ctx)).toMatchObject({ status: "missing_credentials" });
      expect(await adapter.test(ctx)).toMatchObject({ state: "not_configured" });
      expect(json).not.toHaveBeenCalled();
    },
  );

  it.each([
    new ProviderError("invalid_credentials", "fixture-key", 401),
    { success: false, code: "UNAUTHORIZED", error: "Invalid API key" },
  ])("invalid credentials report failure without leaking keys", async (response) => {
    const { ctx, adapter } = setup([response]);
    const report = await adapter.test(ctx);
    expect(report.state).toBe("invalid_credentials");
    expect(report.message).not.toContain("fixture-key");
  });

  it.each(["invalid\nheader", "invalid header"])(
    "rejects invalid header key locally",
    async (key) => {
      const { ctx, json, adapter } = setup([], { credentials: { firecrawl_api_key: key } });
      expect(await adapter.test(ctx)).toMatchObject({ state: "invalid_credentials" });
      expect(json).not.toHaveBeenCalled();
    },
  );

  it("does not report malformed API envelopes as connected", async () => {
    const { ctx, adapter } = setup([{ success: true, data: {} }]);
    expect(await adapter.test(ctx)).toMatchObject({ state: "unreachable" });
  });
});
