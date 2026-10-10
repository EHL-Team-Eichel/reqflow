import { describe, expect, it, vi } from "vitest";
import {
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
} from "@reqflow/core";
import { ProviderError, type HttpOptions, type ProviderContext } from "../provider";
import { createXAdapter } from "./x";

function harness(queue: unknown[], overrides: Partial<ProviderContext> = {}) {
  const calls: { url: URL; options?: HttpOptions }[] = [];
  const ctx: ProviderContext = {
    credentials: { x_bearer_token: "fixture-token" },
    config: ResearchProviderConfig.parse({ enabled: true }),
    limits: ResearchLimits.parse({}),
    signal: new AbortController().signal,
    log: vi.fn(),
    now: () => "2026-10-10T12:00:00.000Z",
    http: {
      get requests() {
        return calls.length;
      },
      async json<T>(url: string, options?: HttpOptions): Promise<T> {
        calls.push({ url: new URL(url), options });
        const next = queue.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error("Unexpected fixture request");
        return next as T;
      },
      text: async () => {
        throw new Error("No scraping");
      },
    },
    ...overrides,
  };
  return { ctx, calls };
}
const request = {
  agentId: "x" as const,
  queries: ["BMW 5 Series"],
  scope: ResearchScope.parse({}),
};
const post = (id: string) => ({
  id,
  text: "Original mixed view & details.",
  author_id: "42",
  created_at: "2026-10-09T10:00:00Z",
  lang: "de",
  conversation_id: "1",
});

describe("X official adapter", () => {
  it("requires injected Bearer credentials", async () => {
    const { ctx, calls } = harness([], { credentials: {} });
    expect((await createXAdapter().collect(request, ctx)).status).toBe("missing_credentials");
    expect((await createXAdapter().test(ctx)).state).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });

  it("paginates recent search and retains extended original text, author and reply context", async () => {
    const { ctx, calls } = harness([
      {
        data: [
          {
            ...post("2"),
            text: "Truncated…",
            note_tweet: { text: "Full original long post & details. I own one." },
            in_reply_to_user_id: "41",
            referenced_tweets: [
              { type: "replied_to", id: "1" },
              { type: "quoted", id: "3" },
            ],
          },
        ],
        includes: {
          users: [{ id: "42", username: "fixture", name: "Fixture", location: "Somewhere" }],
          tweets: [{ ...post("1"), text: "Original parent" }],
        },
        meta: { next_token: "page-next" },
      },
      { data: [post("4")], meta: { result_count: 1 } },
    ]);
    const result = await createXAdapter().collect(request, ctx);
    expect(result.status).toBe("success");
    expect(result.items).toHaveLength(2);
    result.items.forEach((item) => expect(CollectedItem.safeParse(item).success).toBe(true));
    expect(result.items[0]).toMatchObject({
      recordId: "2",
      text: "Full original long post & details. I own one.",
      parentId: "1",
      threadId: "1",
      language: "de",
      publishedAt: "2026-10-09T10:00:00Z",
      context: { id: "1", text: "Original parent" },
      metadata: { author_id: "42", in_reply_to_user_id: "41", author: { username: "fixture" } },
    });
    expect(result.items[0]?.market).toBeUndefined();
    expect(result.items[0]?.vehicle).toBeUndefined();
    expect(result.items[0]?.metadata).not.toHaveProperty("sentiment");
    expect(calls[0]?.url.pathname).toBe("/2/tweets/search/recent");
    expect(calls[0]?.url.searchParams.get("query")).toBe(request.queries[0]);
    expect(calls[0]?.url.searchParams.get("tweet.fields")).toContain("referenced_tweets");
    expect(calls[0]?.url.searchParams.get("tweet.fields")).toContain("note_tweet");
    expect(calls[1]?.url.searchParams.get("next_token")).toBe("page-next");
    expect(calls[0]?.options).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer fixture-token" },
      signal: ctx.signal,
    });
  });

  it("selects full archive explicitly and preserves inclusive publication days as exclusive end_time", async () => {
    const { ctx, calls } = harness([{ meta: { result_count: 0 } }], {
      config: ResearchProviderConfig.parse({ enabled: true, xSearchMode: "full_archive" }),
    });
    const result = await createXAdapter().collect(
      {
        ...request,
        scope: ResearchScope.parse({ publishedFrom: "2020-01-01", publishedTo: "2020-01-31" }),
      },
      ctx,
    );
    expect(result.status).toBe("empty");
    expect(calls[0]?.url.pathname).toBe("/2/tweets/search/all");
    expect(calls[0]?.url.searchParams.get("start_time")).toBe("2020-01-01T00:00:00.000Z");
    expect(calls[0]?.url.searchParams.get("end_time")).toBe("2020-02-01T00:00:00.000Z");
  });

  it("blocks incompatible recent windows instead of silently truncating history", async () => {
    for (const scope of [
      { publishedFrom: "2020-01-01" },
      { publishedTo: "2020-01-01" },
      { publishedFrom: "2026-10-11" },
    ]) {
      const { ctx, calls } = harness([]);
      const result = await createXAdapter().collect(
        { ...request, scope: ResearchScope.parse(scope) },
        ctx,
      );
      expect(result.status).toBe("blocked");
      expect(calls).toHaveLength(0);
    }
  });

  it("does not fall back from archive 403 to recent search", async () => {
    const { ctx, calls } = harness([new ProviderError("permission_required", "private", 403)], {
      config: ResearchProviderConfig.parse({ enabled: true, xSearchMode: "full_archive" }),
    });
    expect((await createXAdapter().collect(request, ctx)).status).toBe("blocked");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/2/tweets/search/all");
  });

  it.each([
    [401, "invalid_credentials"],
    [403, "permission_required"],
    [429, "rate_limited"],
  ] as const)("maps HTTP %i connection state", async (status, code) => {
    const { ctx } = harness([new ProviderError(code, "fixture-token private body", status)]);
    const report = await createXAdapter().test(ctx);
    expect(report.state).toBe(code);
    expect(report.message).not.toContain("fixture-token");
  });

  it("preserves earlier pages when later pagination fails", async () => {
    const { ctx } = harness([
      { data: [post("2")], meta: { next_token: "next" } },
      new Error("fixture-token private body"),
    ]);
    const result = await createXAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result.limitations)).not.toContain("private body");
  });

  it("honors request and result bounds, deduplicates IDs", async () => {
    const { ctx, calls } = harness(
      [{ data: [post("2"), post("2"), post("4")], meta: { next_token: "next" } }],
      { limits: ResearchLimits.parse({ maxResults: 1, maxRequests: 1 }) },
    );
    const result = await createXAdapter().collect(request, ctx);
    expect(result.items).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get("max_results")).toBe("10");
  });

  it("reports provider partial errors rather than treating missing data as empty", async () => {
    const { ctx } = harness([
      {
        data: [post("2")],
        errors: [{ title: "Unavailable", detail: "private body" }],
        meta: { result_count: 1 },
      },
    ]);
    const result = await createXAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(result.limitations.join(" ")).not.toContain("private body");
  });

  it("cancels before HTTP and retains records on later abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = harness([], { signal: controller.signal });
    expect((await createXAdapter().collect(request, before.ctx)).status).toBe("cancelled");
    expect(before.calls).toHaveLength(0);
    const mid = harness([
      { data: [post("2")], meta: { next_token: "next" } },
      new ProviderError("cancelled", "aborted"),
    ]);
    const result = await createXAdapter().collect(request, mid.ctx);
    expect(result.status).toBe("cancelled");
    expect(result.items).toHaveLength(1);
  });

  it("tests configured endpoint with one minimum-size search, which can bill", async () => {
    const { ctx, calls } = harness([{ meta: { result_count: 0 } }]);
    const report = await createXAdapter().test(ctx);
    expect(report.state).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.searchParams.get("max_results")).toBe("10");
    expect(report.limitations.join(" ")).toMatch(/bill/i);
  });

  it("enforces request limit independently from result limit", async () => {
    const { ctx, calls } = harness([{ data: [post("2")], meta: { next_token: "next" } }], {
      limits: ResearchLimits.parse({ maxRequests: 1, maxResults: 50 }),
    });
    const result = await createXAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("reports rejected credentials and rejects malformed content instead of making up text", async () => {
    const invalid = harness([new ProviderError("invalid_credentials", "private", 401)]);
    expect((await createXAdapter().collect(request, invalid.ctx)).status).toBe(
      "missing_credentials",
    );
    const malformed = harness([{ data: [{ id: "2", text: null }], meta: {} }]);
    const result = await createXAdapter().collect(request, malformed.ctx);
    expect(result.status).toBe("error");
    expect(result.items).toHaveLength(0);
  });

  it("handles native HTTP abort errors without disclosing error body", async () => {
    const { ctx } = harness([new DOMException("fixture-token private", "AbortError")]);
    const result = await createXAdapter().collect(request, ctx);
    expect(result.status).toBe("cancelled");
    expect(result.limitations.join(" ")).not.toContain("fixture-token");
  });
});
