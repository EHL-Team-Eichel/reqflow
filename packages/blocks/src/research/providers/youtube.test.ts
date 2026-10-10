import { describe, expect, it, vi } from "vitest";
import {
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
} from "@reqflow/core";
import { ProviderError, type HttpOptions, type ProviderContext } from "../provider";
import { createYouTubeAdapter } from "./youtube";

function harness(queue: unknown[], overrides: Partial<ProviderContext> = {}) {
  const calls: { url: URL; options?: HttpOptions }[] = [];
  const ctx: ProviderContext = {
    credentials: { youtube_api_key: "fixture-token" },
    config: ResearchProviderConfig.parse({ enabled: true }),
    limits: ResearchLimits.parse({ maxResults: 50, maxRequests: 30 }),
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
        if (typeof next === "function") return next() as T;
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
  agentId: "youtube" as const,
  queries: ["BMW 5 Series"],
  scope: ResearchScope.parse({}),
};
const search = (id: string, nextPageToken?: string) => ({
  items: [{ id: { videoId: id } }],
  nextPageToken,
});
const video = (id: string) => ({
  items: [
    {
      id,
      snippet: {
        title: "Synthetic review",
        description: "My original description & details.",
        publishedAt: "2026-10-09T10:00:00Z",
        channelId: "channel-fixture",
        channelTitle: "Fixture channel",
        defaultLanguage: "de",
      },
    },
  ],
});
const comment = (id: string, text: string, parentId?: string) => ({
  id,
  snippet: {
    textDisplay: text,
    textOriginal: text,
    publishedAt: "2026-10-09T11:00:00Z",
    updatedAt: "2026-10-09T11:00:00Z",
    authorDisplayName: "Fixture audience",
    authorChannelId: { value: "audience-fixture" },
    parentId,
  },
});
const thread = (replies = 0) => ({
  id: "thread-fixture",
  snippet: {
    videoId: "video1",
    totalReplyCount: replies,
    topLevelComment: comment("top1", "I own one. Mixed experience & details."),
  },
  replies: { comments: replies ? [comment("reply1", "Original reply one", "top1")] : [] },
});

describe("YouTube official adapter", () => {
  it("requires injected credentials and never calls HTTP when missing", async () => {
    const { ctx, calls } = harness([], { credentials: {} });
    expect((await createYouTubeAdapter().collect(request, ctx)).status).toBe("missing_credentials");
    expect((await createYouTubeAdapter().test(ctx)).state).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });

  it("paginates search, threads and all replies beyond embedded partial replies", async () => {
    const { ctx, calls } = harness([
      search("video1", "search-next"),
      video("video1"),
      { items: [thread(3)], nextPageToken: "threads-next" },
      {
        items: [
          comment("reply1", "Original reply one", "top1"),
          comment("reply2", "Original reply two", "top1"),
        ],
        nextPageToken: "replies-next",
      },
      { items: [comment("reply3", "Original reply three", "top1")] },
      { items: [] },
      search("video2"),
      video("video2"),
      { items: [] },
    ]);
    const result = await createYouTubeAdapter().collect(request, ctx);
    expect(result.status).toBe("success");
    expect(result.items.map((item) => item.recordId)).toEqual([
      "video1",
      "top1",
      "reply1",
      "reply2",
      "reply3",
      "video2",
    ]);
    result.items.forEach((item) => expect(CollectedItem.safeParse(item).success).toBe(true));
    expect(result.items[0]).toMatchObject({
      recordType: "metadata",
      text: "My original description & details.",
      language: "de",
    });
    expect(result.items[1]).toMatchObject({
      recordType: "feedback",
      threadId: "thread-fixture",
      parentId: "video1",
      publishedAt: "2026-10-09T11:00:00Z",
    });
    expect(result.items[3]).toMatchObject({
      parentId: "top1",
      threadId: "thread-fixture",
      context: { id: "top1", text: "I own one. Mixed experience & details." },
    });
    expect(
      result.items.every((item) => item.market === undefined && item.vehicle === undefined),
    ).toBe(true);
    expect(result.items[1]?.language).toBeUndefined();
    expect(calls[3]?.url.searchParams.get("parentId")).toBe("top1");
    expect(calls[4]?.url.searchParams.get("pageToken")).toBe("replies-next");
    expect(calls[5]?.url.searchParams.get("pageToken")).toBe("threads-next");
    expect(calls[6]?.url.searchParams.get("pageToken")).toBe("search-next");
    for (const call of calls) {
      expect(call.url.origin).toBe("https://www.googleapis.com");
      expect(call.options).toMatchObject({
        method: "GET",
        headers: { "X-Goog-Api-Key": "fixture-token" },
        signal: ctx.signal,
      });
      expect(call.url.searchParams.has("key")).toBe(false);
    }
    expect(result.limitations.join(" ")).toMatch(/transcripts.*authorized/i);
  });

  it("retains publicly returned plain text without inventing original text or comment language", async () => {
    const top = comment("top1", "Plain display & text.");
    delete (top.snippet as { textOriginal?: string }).textOriginal;
    const { ctx } = harness([
      search("video1"),
      video("video1"),
      { items: [{ ...thread(), snippet: { ...thread().snippet, topLevelComment: top } }] },
    ]);
    const result = await createYouTubeAdapter().collect(request, ctx);
    expect(result.items[1]?.text).toBe("Plain display & text.");
    expect(result.items[1]?.limitations.join(" ")).toMatch(/textOriginal.*not available/i);
  });

  it("preserves records and does not leak a later pagination failure", async () => {
    const { ctx } = harness([
      search("video1"),
      video("video1"),
      { items: [thread()], nextPageToken: "next" },
      new Error("fixture-token provider body"),
    ]);
    const result = await createYouTubeAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(2);
    expect(JSON.stringify(result.limitations)).not.toContain("fixture-token");
    expect(JSON.stringify(vi.mocked(ctx.log).mock.calls)).not.toContain("provider body");
  });

  it.each([
    [401, "invalid_credentials"],
    [403, "permission_required"],
    [429, "rate_limited"],
  ] as const)("maps HTTP %i connection state", async (status, code) => {
    const { ctx } = harness([new ProviderError(code, "fixture-token provider body", status)]);
    const report = await createYouTubeAdapter().test(ctx);
    expect(report.state).toBe(code);
    expect(report.message).not.toContain("fixture-token");
  });

  it("returns blocked for permission failures and missing_credentials for rejected keys", async () => {
    for (const [code, status] of [
      ["permission_required", "blocked"],
      ["invalid_credentials", "missing_credentials"],
    ] as const) {
      const { ctx } = harness([new ProviderError(code, "private body")]);
      expect((await createYouTubeAdapter().collect(request, ctx)).status).toBe(status);
    }
  });

  it("honors request and result bounds without claiming exhaustive collection", async () => {
    const { ctx, calls } = harness([search("video1"), video("video1")], {
      limits: ResearchLimits.parse({ maxRequests: 2 }),
    });
    const result = await createYouTubeAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(calls).toHaveLength(2);
    const bounded = harness([search("video1"), video("video1")], {
      limits: ResearchLimits.parse({ maxResults: 1 }),
    });
    expect((await createYouTubeAdapter().collect(request, bounded.ctx)).items).toHaveLength(1);
    expect(bounded.calls).toHaveLength(2);
  });

  it("cancels before HTTP and preserves earlier records on mid-run abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = harness([], { signal: controller.signal });
    expect((await createYouTubeAdapter().collect(request, before.ctx)).status).toBe("cancelled");
    expect(before.calls).toHaveLength(0);
    const mid = harness([
      search("video1"),
      video("video1"),
      new ProviderError("cancelled", "Aborted"),
    ]);
    const result = await createYouTubeAdapter().collect(request, mid.ctx);
    expect(result.status).toBe("cancelled");
    expect(result.items).toHaveLength(1);
  });

  it("tests connection with one bounded videos.list request, not transcript scraping", async () => {
    const { ctx, calls } = harness([{ items: [] }]);
    expect((await createYouTubeAdapter().test(ctx)).state).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/youtube/v3/videos");
    expect(calls[0]?.url.searchParams.get("maxResults")).toBe("1");
  });

  it("keeps embedded and fetched replies if a later comments.list page fails", async () => {
    const { ctx } = harness([
      search("video1"),
      video("video1"),
      { items: [thread(3)] },
      { items: [comment("reply2", "Original reply two", "top1")], nextPageToken: "next" },
      new ProviderError("permission_required", "private body", 403),
    ]);
    const result = await createYouTubeAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items.map((item) => item.recordId)).toEqual([
      "video1",
      "top1",
      "reply1",
      "reply2",
    ]);
  });

  it("returns empty without inventing video metadata; rejects malformed response", async () => {
    const empty = harness([{ items: [] }]);
    expect((await createYouTubeAdapter().collect(request, empty.ctx)).status).toBe("empty");
    expect(empty.calls).toHaveLength(1);
    const malformed = harness([{ items: [{ id: {} }] }]);
    expect((await createYouTubeAdapter().collect(request, malformed.ctx)).status).toBe("error");
  });

  it("does not ignore result limits when videos.list hydrates a batch", async () => {
    const hydrated = { items: [...video("video1").items, ...video("video2").items] };
    const { ctx, calls } = harness(
      [
        { items: [{ id: { videoId: "video1" } }, { id: { videoId: "video2" } }] },
        hydrated,
        { items: [] },
      ],
      { limits: ResearchLimits.parse({ maxResults: 1 }) },
    );
    const result = await createYouTubeAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});
