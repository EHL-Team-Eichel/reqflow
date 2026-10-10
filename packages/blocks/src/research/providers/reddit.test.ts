import { describe, expect, it, vi } from "vitest";
import {
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
} from "@reqflow/core";
import { ProviderError, type HttpOptions, type ProviderContext } from "../provider";
import { createRedditAdapter } from "./reddit";

function harness(queue: unknown[], overrides: Partial<ProviderContext> = {}) {
  const calls: { url: URL; options?: HttpOptions }[] = [];
  const ctx: ProviderContext = {
    credentials: {
      reddit_client_id: "fixture-id",
      reddit_client_secret: "fixture-secret",
      reddit_refresh_token: "fixture-token",
    },
    config: ResearchProviderConfig.parse({
      enabled: true,
      approval: "granted",
      redditUserAgent: "ReqFlow/0.1 by u/fixture",
    }),
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
  agentId: "reddit" as const,
  queries: ["BMW 5 Series"],
  scope: ResearchScope.parse({}),
};
const token = {
  access_token: "fixture-access",
  token_type: "bearer",
  scope: "read",
  expires_in: 3600,
};
const listing = (children: unknown[], after: string | null = null) => ({
  kind: "Listing",
  data: { children, after },
});
const post = (id: string) => ({
  kind: "t3",
  data: {
    id,
    name: `t3_${id}`,
    title: "Synthetic question",
    selftext: "I own one. Original & mixed view.",
    author: "fixture",
    created_utc: 1791540000,
    subreddit: "fixture",
    permalink: `/r/fixture/comments/${id}/synthetic/`,
    num_comments: 2,
  },
});
const comment = (id: string, parentId: string, replies: unknown = "") => ({
  kind: "t1",
  data: {
    id,
    name: `t1_${id}`,
    body: "Original comment & details.",
    author: "fixture2",
    created_utc: 1791540001,
    parent_id: parentId,
    link_id: "t3_post1",
    permalink: `/r/fixture/comments/post1/synthetic/${id}/`,
    replies,
  },
});

describe("Reddit approved OAuth adapter", () => {
  it("blocks data access without approval separately from OAuth credentials", async () => {
    const { ctx, calls } = harness([], { config: ResearchProviderConfig.parse({ enabled: true }) });
    expect((await createRedditAdapter().collect(request, ctx)).status).toBe("blocked");
    expect((await createRedditAdapter().test(ctx)).state).toBe("permission_required");
    expect(calls).toHaveLength(0);
  });

  it.each(["reddit_client_id", "reddit_client_secret", "reddit_refresh_token"] as const)(
    "requires %s; no password or tokenless success",
    async (name) => {
      const test = harness([]);
      delete (test.ctx.credentials as Record<string, string>)[name];
      expect((await createRedditAdapter().collect(request, test.ctx)).status).toBe(
        "missing_credentials",
      );
      expect((await createRedditAdapter().test(test.ctx)).state).toBe("not_configured");
      expect(test.calls).toHaveLength(0);
    },
  );

  it("refreshes OAuth and paginates search with original nested comment parent/thread context", async () => {
    const { ctx, calls } = harness([
      token,
      listing([post("post1")], "t3_post1"),
      [
        listing([post("post1")]),
        listing([comment("c1", "t3_post1", listing([comment("c2", "t1_c1")]))]),
      ],
      listing([post("post2")]),
      [listing([post("post2")]), listing([])],
    ]);
    const result = await createRedditAdapter().collect(request, ctx);
    expect(result.status).toBe("success");
    expect(result.items.map((item) => item.recordId)).toEqual([
      "t3_post1",
      "t1_c1",
      "t1_c2",
      "t3_post2",
    ]);
    result.items.forEach((item) => expect(CollectedItem.safeParse(item).success).toBe(true));
    expect(result.items[0]?.text).toBe("I own one. Original & mixed view.");
    expect(result.items[2]).toMatchObject({
      text: "Original comment & details.",
      parentId: "t1_c1",
      threadId: "t3_post1",
      context: { id: "t1_c1", text: "Original comment & details." },
      datePrecision: "instant",
    });
    expect(
      result.items.every(
        (item) =>
          item.market === undefined && item.vehicle === undefined && item.language === undefined,
      ),
    ).toBe(true);
    expect(calls[0]?.url.href).toBe("https://www.reddit.com/api/v1/access_token");
    expect(calls[0]?.options).toMatchObject({
      method: "POST",
      body: "grant_type=refresh_token&refresh_token=fixture-token",
      signal: ctx.signal,
    });
    expect(calls[0]?.options?.headers?.Authorization).toBe(
      `Basic ${Buffer.from("fixture-id:fixture-secret").toString("base64")}`,
    );
    expect(calls[1]?.url.pathname).toBe("/search.json");
    expect(calls[1]?.url.searchParams.get("q")).toBe(request.queries[0]);
    expect(calls[3]?.url.searchParams.get("after")).toBe("t3_post1");
    expect(calls[2]?.url.pathname).toBe("/comments/post1.json");
    for (const call of calls.slice(1)) {
      expect(call.url.origin).toBe("https://oauth.reddit.com");
      expect(call.url.searchParams.get("raw_json")).toBe("1");
      expect(call.options?.headers?.Authorization).toBe("Bearer fixture-access");
      expect(call.options?.headers?.["User-Agent"]).toBe(ctx.config.redditUserAgent);
    }
  });

  it("marks MoreComments omissions as partial, never pretends complete tree", async () => {
    const { ctx } = harness([
      token,
      listing([post("post1")]),
      [
        listing([post("post1")]),
        listing([
          comment("c1", "t3_post1"),
          { kind: "more", data: { count: 2, children: ["c2", "c3"], parent_id: "t1_c1" } },
        ]),
      ],
    ]);
    const result = await createRedditAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(2);
    expect(result.limitations.join(" ")).toMatch(/MoreComments/);
  });

  it("keeps partial records when later search or thread calls fail", async () => {
    const { ctx } = harness([
      token,
      listing([post("post1")], "t3_post1"),
      [listing([post("post1")]), listing([comment("c1", "t3_post1")])],
      new Error("fixture-token private body"),
    ]);
    const result = await createRedditAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(2);
    expect(result.limitations.join(" ")).not.toContain("private body");
  });

  it.each([
    [401, "invalid_credentials"],
    [403, "permission_required"],
    [429, "rate_limited"],
  ] as const)("maps HTTP %i connection state", async (status, code) => {
    const { ctx } = harness([new ProviderError(code, "fixture-token private body", status)]);
    const report = await createRedditAdapter().test(ctx);
    expect(report.state).toBe(code);
    expect(report.message).not.toContain("fixture-token");
  });

  it("rejects invalid refresh grants and tokens without read scope", async () => {
    const invalid = harness([{ error: "invalid_grant", error_description: "private" }]);
    expect((await createRedditAdapter().test(invalid.ctx)).state).toBe("invalid_credentials");
    const denied = harness([{ ...token, scope: "identity" }]);
    expect((await createRedditAdapter().collect(request, denied.ctx)).status).toBe("blocked");
  });

  it("honors limits including OAuth request", async () => {
    const { ctx, calls } = harness([token, listing([post("post1")])], {
      limits: ResearchLimits.parse({ maxRequests: 2 }),
    });
    const result = await createRedditAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("cancels before HTTP and preserves records on mid-run abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = harness([], { signal: controller.signal });
    expect((await createRedditAdapter().collect(request, before.ctx)).status).toBe("cancelled");
    expect(before.calls).toHaveLength(0);
    const mid = harness([
      token,
      listing([post("post1")]),
      new ProviderError("cancelled", "Aborted"),
    ]);
    const result = await createRedditAdapter().collect(request, mid.ctx);
    expect(result.status).toBe("cancelled");
    expect(result.items).toHaveLength(1);
  });

  it("tests read access with refresh plus one tiny OAuth search, not identity scope", async () => {
    const { ctx, calls } = harness([token, listing([])]);
    expect((await createRedditAdapter().test(ctx)).state).toBe("success");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url.pathname).toBe("/search.json");
    expect(calls[1]?.url.searchParams.get("limit")).toBe("1");
  });

  it("enforces result bound before fetching comments and never follows provider URLs", async () => {
    const { ctx, calls } = harness(
      [
        token,
        listing([
          {
            ...post("post1"),
            data: { ...post("post1").data, permalink: "https://untrusted.invalid/steal" },
          },
        ]),
      ],
      { limits: ResearchLimits.parse({ maxResults: 1 }) },
    );
    const result = await createRedditAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(result.items[0]?.sourceUrl).toBe("https://www.reddit.com/comments/post1/");
  });

  it("does not claim success for malformed refresh response or data permission denial", async () => {
    const malformed = harness([{ token_type: "bearer", scope: "read", expires_in: 3600 }]);
    expect((await createRedditAdapter().test(malformed.ctx)).state).toBe("unreachable");
    const denied = harness([token, new ProviderError("permission_required", "private", 403)]);
    expect((await createRedditAdapter().collect(request, denied.ctx)).status).toBe("blocked");
  });

  it("does not silently discard unexpected comment listing cursors", async () => {
    const { ctx } = harness([
      token,
      listing([post("post1")]),
      [listing([post("post1")]), listing([comment("c1", "t3_post1")], "t1_next")],
    ]);
    const result = await createRedditAdapter().collect(request, ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(2);
    expect(result.limitations.join(" ")).toMatch(/cursor/);
  });
});
