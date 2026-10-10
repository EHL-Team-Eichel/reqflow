import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APIFY_ACTORS,
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
} from "@reqflow/core";
import { ProviderError } from "../provider";
import type { CollectionRequest, HttpOptions, ProviderContext } from "../provider";
import { createApifyAdapter } from "./apify";

// Synthetic values, using the field names in the official actor README examples.
const instagramUrl = "https://www.instagram.com/p/Synthetic5/";
const tiktokUrl = "https://www.tiktok.com/@synthetic/video/7543693751290481942";
const instagramPost = {
  id: "3923124318436838545",
  url: instagramUrl,
  caption: "  Größe 🚙\n第二行\n\nOriginal caption  ",
  timestamp: "2026-06-20T10:00:04.000Z",
  ownerUsername: "synthetic",
  type: "Image",
  paidPartnership: false,
  affiliate: true,
  sponsors: [],
  latestComments: [{ id: "embedded", text: "Not the post caption" }],
};
const instagramComment = {
  id: "17949788698583607",
  text: "  Maßstab 🧑🏽‍🔧\n座椅\n\n  ",
  ownerUsername: "synthetic_owner",
  timestamp: "2026-06-21T13:54:13.000Z",
  likesCount: 12,
  repliesCount: 1,
  replies: [
    {
      id: "17891234567890123",
      text: "返信\nStimmt!",
      timestamp: "2026-06-21T14:02:45.000Z",
      replies: [],
    },
  ],
};
const tiktokPost = {
  id: "7543693751290481942",
  text: "Sitzkomfort ☁️\n#BMW",
  textLanguage: "de",
  createTime: 1756403075,
  createTimeISO: "2025-08-28T17:44:35.000Z",
  isAd: true,
  isSponsored: false,
  webVideoUrl: tiktokUrl,
  locationCreated: "GB",
  authorMeta: { name: "synthetic", signature: "Living in the US" },
  videoMeta: {
    duration: 15,
    subtitleLinks: [
      {
        language: "kor-KR",
        downloadLink: "https://example.invalid/subtitles.vtt",
        tiktokLink: "https://example.invalid/subtitles.vtt",
        source: "MT",
        sourceUnabbreviated: "machine translation",
        version: "4",
      },
    ],
  },
};
const tiktokComment = {
  cid: "7399984975553086214",
  text: "改善して\n  please 🚗",
  diggCount: 246,
  replyCommentTotal: 3,
  createTimeISO: "2025-08-29T11:21:16.000Z",
  uniqueId: "synthetic_owner",
  videoWebUrl: tiktokUrl,
  uid: "6904063862041396225",
};

type Call = { url: URL; options: HttpOptions };
type Reply = unknown | ((call: Call) => unknown | Promise<unknown>);
function harness(replies: Reply[] = []) {
  const calls: Call[] = [];
  const log = vi.fn();
  const controller = new AbortController();
  const ctx: ProviderContext = {
    config: ResearchProviderConfig.parse({
      enabled: true,
      approval: "granted",
      allowedActors: [...APIFY_ACTORS],
    }),
    credentials: { apify_api_token: "synthetic-secret-for-offline-tests" },
    limits: ResearchLimits.parse({ maxResults: 6 }),
    signal: controller.signal,
    now: () => "2026-10-10T17:00:00.000Z",
    log,
    http: {
      get requests() {
        return calls.length;
      },
      async json<T>(url: string, options: HttpOptions = {}): Promise<T> {
        const call = { url: new URL(url), options };
        calls.push(call);
        if (!replies.length) throw new Error("Unexpected offline request");
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return (typeof next === "function" ? await next(call) : next) as T;
      },
      text: vi.fn(() => Promise.reject(new Error("No subtitle/media fetching"))),
    },
  };
  return { ctx, calls, log, controller };
}
function request(agentId: "instagram" | "tiktok" = "instagram"): CollectionRequest {
  return {
    agentId,
    scope: ResearchScope.parse({ urls: [agentId === "instagram" ? instagramUrl : tiktokUrl] }),
    queries: ["BMW 5 Series comfort"],
  };
}
function run(id: string, status = "SUCCEEDED", extra = {}) {
  return { data: { id, status, defaultDatasetId: `${id}Dataset`, ...extra } };
}
function actorCalls(calls: Call[]) {
  return calls.filter((call) => call.url.pathname.includes("/actors/"));
}
function postOnly(ctx: ProviderContext, platform = "instagram") {
  ctx.config.allowedActors = [
    platform === "instagram" ? "apify/instagram-scraper" : "clockworks/tiktok-scraper",
  ];
}

afterEach(() => vi.useRealTimers());

describe("createApifyAdapter", () => {
  it("exports the shared ProviderAdapter interface", () => {
    expect(createApifyAdapter()).toMatchObject({
      id: "apify",
      collect: expect.any(Function),
      test: expect.any(Function),
    });
  });

  it.each(["not_granted", "disabled", "no_actor", "arbitrary_actor", "wrong_platform"])(
    "does not launch without explicit approval and exact actor: %s",
    async (mode) => {
      const { ctx, calls } = harness();
      if (mode === "not_granted") ctx.config.approval = "not_granted";
      if (mode === "disabled") ctx.config.enabled = false;
      if (mode === "no_actor") ctx.config.allowedActors = [];
      if (mode === "arbitrary_actor") {
        ctx.config.allowedActors = ["someone/arbitrary" as (typeof APIFY_ACTORS)[number]];
      }
      if (mode === "wrong_platform") ctx.config.allowedActors = ["clockworks/tiktok-scraper"];
      expect((await createApifyAdapter().collect(request(), ctx)).status).toBe("blocked");
      expect(calls).toHaveLength(0);
    },
  );

  it("returns missing_credentials without an HTTP call", async () => {
    const { ctx, calls } = harness();
    ctx.credentials = {};
    expect((await createApifyAdapter().collect(request(), ctx)).status).toBe("missing_credentials");
    expect(calls).toHaveLength(0);
  });

  it("rejects other research agents", async () => {
    const { ctx, calls } = harness();
    expect(
      (await createApifyAdapter().collect({ ...request(), agentId: "reddit" }, ctx)).status,
    ).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("polls asynchronous runs, reuses retrieved URLs, separates captions/comments/replies", async () => {
    const { ctx, calls } = harness([
      run("posts", "READY"),
      run("posts", "RUNNING"),
      run("posts"),
      [instagramPost],
      run("comments"),
      [instagramComment],
    ]);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("success");
    expect(result.items).toHaveLength(3);
    result.items.forEach((item) => expect(CollectedItem.safeParse(item).success).toBe(true));
    expect(result.items[0]).toMatchObject({
      recordId: instagramPost.id,
      recordType: "passage",
      text: instagramPost.caption,
      sourceUrl: instagramUrl,
      publishedAt: instagramPost.timestamp,
      datePrecision: "instant",
      metadata: { paidPartnership: false, affiliate: true, sponsors: [] },
    });
    expect(result.items[1]).toMatchObject({
      recordId: instagramComment.id,
      recordType: "feedback",
      text: instagramComment.text,
      sourceId: instagramPost.id,
      threadId: instagramPost.id,
      parentId: instagramPost.id,
      context: { id: instagramPost.id, url: instagramUrl, text: instagramPost.caption },
      publishedAt: instagramComment.timestamp,
    });
    expect(result.items[2]).toMatchObject({ parentId: instagramComment.id, text: "返信\nStimmt!" });
    expect(calls.filter((c) => c.url.pathname === "/v2/actor-runs/posts")).toHaveLength(2);
    expect(actorCalls(calls)[1]?.options.body).toMatchObject({ directUrls: [instagramPost.url] });
    for (const call of calls) {
      expect(call.options.headers?.Authorization).toBe(`Bearer ${ctx.credentials.apify_api_token}`);
      expect(call.url.searchParams.has("token")).toBe(false);
      expect(call.url.href).not.toContain(ctx.credentials.apify_api_token);
    }
    for (const call of actorCalls(calls)) {
      expect(call.options.method).toBe("POST");
      expect(call.options.headers?.["Content-Type"]).toBe("application/json");
      expect(call.url.searchParams.get("maxTotalChargeUsd")).toBe(
        String(ctx.limits.maxApifyChargeUsd),
      );
      expect(Number(call.url.searchParams.get("memory"))).toBeGreaterThanOrEqual(128);
      expect(Number(call.url.searchParams.get("timeout"))).toBeGreaterThan(0);
      expect(Number(call.url.searchParams.get("timeout"))).toBeLessThanOrEqual(
        ctx.limits.timeoutMs / 1000,
      );
      expect(call.url.searchParams.get("waitForFinish")).toBe("0");
    }
  });

  it("uses documented TikTok shapes and keeps language, ad flags and subtitle provenance", async () => {
    const { ctx, calls } = harness([run("posts"), [tiktokPost], run("comments"), [tiktokComment]]);
    const result = await createApifyAdapter().collect(request("tiktok"), ctx);
    expect(result.status).toBe("success");
    expect(result.items[0]).toMatchObject({
      recordId: tiktokPost.id,
      recordType: "passage",
      language: "de",
      text: tiktokPost.text,
      publishedAt: tiktokPost.createTimeISO,
      metadata: {
        createTime: tiktokPost.createTime,
        isAd: true,
        isSponsored: false,
        videoMeta: { subtitleLinks: tiktokPost.videoMeta.subtitleLinks },
      },
    });
    expect(result.items[1]).toMatchObject({
      recordId: tiktokComment.cid,
      recordType: "feedback",
      text: tiktokComment.text,
      publishedAt: tiktokComment.createTimeISO,
      threadId: tiktokPost.id,
    });
    expect(result.items[1]?.parentId).toBeUndefined(); // The documented fixture supplies no reply parent ID.
    for (const item of result.items) {
      expect(item.market).toBeUndefined();
      expect(item.vehicle).toBeUndefined();
      expect(item.metadata).not.toHaveProperty("sentiment");
    }
    expect(actorCalls(calls)[0]?.options.body).toMatchObject({
      postURLs: [tiktokUrl],
      commentsPerPost: 0,
      aiVideoDescription: false,
      aiVideoSummary: false,
      downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
    });
    expect(actorCalls(calls)[1]?.options.body).toMatchObject({ postURLs: [tiktokUrl] });
    expect(ctx.http.text).not.toHaveBeenCalled();
  });

  it("requires a second exact allowlist entry for the comment actor", async () => {
    const { ctx, calls } = harness([run("posts"), [instagramPost]]);
    postOnly(ctx);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(1);
    expect(result.limitations.join(" ")).toContain("apify/instagram-comment-scraper");
    expect(actorCalls(calls)).toHaveLength(1);
  });

  it("uses item offset/limit pagination, not pages, and enforces the shared record limit", async () => {
    const posts = Array.from({ length: 55 }, (_, i) => ({
      ...instagramPost,
      id: `original${i}`,
      url: `https://www.instagram.com/p/Synthetic${i}/`,
    }));
    const { ctx, calls } = harness([run("posts"), posts.slice(0, 50), posts.slice(50)]);
    postOnly(ctx);
    ctx.limits.maxResults = 55;
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.items).toHaveLength(55);
    const pages = calls.filter((call) => call.url.pathname.endsWith("/items"));
    expect(pages.map((p) => p.url.searchParams.get("offset"))).toEqual(["0", "50"]);
    expect(pages.map((p) => p.url.searchParams.get("limit"))).toEqual(["50", "5"]);
    expect(pages.every((p) => p.url.searchParams.get("clean") === "false")).toBe(true);
    expect(pages.every((p) => !p.url.searchParams.has("page"))).toBe(true);
  });

  it("does not exceed maxResults when an actor returns too many records or replies", async () => {
    const { ctx } = harness([run("posts"), [instagramPost], run("comments"), [instagramComment]]);
    ctx.limits.maxResults = 2;
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.items).toHaveLength(2);
    expect(result.items[1]?.text).toBe(instagramComment.text);
  });

  it("does not claim keyword search on Instagram; requires URLs or a literal hashtag", async () => {
    const { ctx, calls } = harness();
    const input = request();
    input.scope.urls = [];
    const result = await createApifyAdapter().collect(input, ctx);
    expect(result.status).toBe("blocked");
    expect(result.limitations.join(" ")).toMatch(/URLs.*hashtag|hashtag.*URLs/);
    expect(calls).toHaveLength(0);
  });

  it("uses Instagram's documented hashtag search fields", async () => {
    const { ctx, calls } = harness([run("posts"), []]);
    const input = request();
    input.scope.urls = [];
    input.queries = ["#BMW5Series"];
    expect((await createApifyAdapter().collect(input, ctx)).status).toBe("empty");
    expect(actorCalls(calls)[0]?.options.body).toMatchObject({
      search: "#BMW5Series",
      searchType: "hashtag",
      searchLimit: 1,
      resultsType: "posts",
    });
  });

  it("uses TikTok's documented keyword video search without paid AI add-ons", async () => {
    const { ctx, calls } = harness([run("posts"), []]);
    const input = request("tiktok");
    input.scope.urls = [];
    await createApifyAdapter().collect(input, ctx);
    expect(actorCalls(calls)[0]?.options.body).toMatchObject({
      searchQueries: ["BMW 5 Series comfort"],
      searchSection: "/video",
      resultsPerPage: 3,
    });
  });

  it.each([
    "https://instagram.com.evil.invalid/p/hello/",
    "https://www.tiktok.com/@synthetic/video/123",
    "https://www.instagram.com/accounts/login/",
  ])("blocks unsupported explicit URL without falling back to keyword search: %s", async (url) => {
    const { ctx, calls } = harness();
    const input = request();
    input.scope.urls = [url];
    expect((await createApifyAdapter().collect(input, ctx)).status).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("honors domain restrictions before starting actors", async () => {
    const { ctx, calls } = harness();
    const input = request();
    input.scope.blockedDomains = ["instagram.com"];
    expect((await createApifyAdapter().collect(input, ctx)).status).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("preserves successful records when comments fail; sanitizes remote errors", async () => {
    const { ctx, log } = harness([
      run("posts"),
      [instagramPost],
      new ProviderError(
        "permission_required",
        "remote secret synthetic-secret-for-offline-tests",
        403,
      ),
    ]);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("partial");
    expect(result.items[0]?.text).toBe(instagramPost.caption);
    expect(result.limitations.join(" ")).toContain("permission_required");
    expect(JSON.stringify(result)).not.toContain(ctx.credentials.apify_api_token);
    expect(JSON.stringify(log.mock.calls)).not.toContain(ctx.credentials.apify_api_token);
  });

  it("keeps successes before individual malformed/error rows and later dataset failure", async () => {
    const posts = Array.from({ length: 50 }, (_, i) => ({ ...instagramPost, id: `original${i}` }));
    posts[1] = {
      error: "Private",
      errorCode: "PROFILE_PRIVATE",
    } as unknown as typeof instagramPost;
    posts[2] = { ...instagramPost, id: undefined } as unknown as typeof instagramPost;
    const { ctx } = harness([run("posts"), posts, new Error("HTTP 502")]);
    postOnly(ctx);
    ctx.limits.maxResults = 60;
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(48);
    expect(result.limitations.join(" ")).toMatch(/malformed/i);
    expect(result.limitations.join(" ")).toMatch(/error/i);
  });

  it.each(["FAILED", "TIMED-OUT", "ABORTED"])(
    "reads existing dataset from terminal %s runs",
    async (status) => {
      const { ctx } = harness([run("posts", status), [instagramPost]]);
      postOnly(ctx);
      const result = await createApifyAdapter().collect(request(), ctx);
      expect(result.status).toBe("partial");
      expect(result.items).toHaveLength(1);
      expect(result.limitations.join(" ")).toContain(status);
    },
  );

  it("returns error for malformed dataset envelope", async () => {
    const { ctx } = harness([run("posts"), { data: [instagramPost] }]);
    postOnly(ctx);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("error");
    expect(result.limitations.join(" ")).toMatch(/malformed/i);
  });

  it("aborts a known run after malformed status using an independent signal", async () => {
    const { ctx, calls } = harness([run("posts", "UNRECOGNIZED"), run("posts", "ABORTED")]);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("error");
    expect(calls[1]?.url.pathname).toBe("/v2/actor-runs/posts/abort");
    expect(calls[1]?.options.signal).not.toBe(ctx.signal);
    expect(calls[1]?.options.signal?.aborted).toBe(false);
  });

  it("does not launch an actor after cancellation", async () => {
    const { ctx, controller, calls } = harness();
    controller.abort();
    expect((await createApifyAdapter().collect(request(), ctx)).status).toBe("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("cancels polling and aborts the run with a clean signal; preserves earlier posts", async () => {
    const { ctx, controller, calls } = harness([
      run("posts"),
      [instagramPost],
      run("comments", "RUNNING"),
      () => {
        controller.abort();
        throw new ProviderError("cancelled", "aborted");
      },
      run("comments", "ABORTED"),
    ]);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("cancelled");
    expect(result.items).toHaveLength(1);
    const abort = calls.at(-1)!;
    expect(abort.url.pathname).toBe("/v2/actor-runs/comments/abort");
    expect(abort.url.searchParams.get("gracefully")).toBe("false");
    expect(abort.options.signal).not.toBe(ctx.signal);
    expect(abort.options.signal?.aborted).toBe(false);
    expect(result.limitations.join(" ")).toMatch(/cost/i);
  });

  it("bounds timeout, aborts a running actor, and reports unconfirmed abort", async () => {
    vi.useFakeTimers();
    const { ctx, calls } = harness([
      run("posts", "RUNNING"),
      async ({ options }: Call) =>
        new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("abort")), {
            once: true,
          });
        }),
      new Error("Cleanup failed"),
    ]);
    ctx.limits.timeoutMs = 1000;
    const pending = createApifyAdapter().collect(request(), ctx);
    await vi.advanceTimersByTimeAsync(1001);
    const result = await pending;
    expect(result.status).toBe("error");
    expect(calls.at(-1)?.url.pathname).toBe("/v2/actor-runs/posts/abort");
    expect(result.limitations.join(" ")).toMatch(/timeout/i);
    expect(result.limitations.join(" ")).toMatch(/abort.*not confirmed/i);
  });

  it("cannot claim an abort if the start response has no run ID", async () => {
    const { ctx, calls } = harness([{ data: { status: "RUNNING" } }]);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("error");
    expect(calls).toHaveLength(1);
    expect(result.limitations.join(" ")).toMatch(/unknown run|run ID/i);
  });

  it("retains empty captions as metadata, never generates opinions from images", async () => {
    const { ctx } = harness([
      run("posts"),
      [{ ...instagramPost, caption: "", displayUrl: "https://example.invalid/image.jpg" }],
    ]);
    postOnly(ctx);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.items[0]).toMatchObject({ text: "", recordType: "metadata" });
    expect(result.items[0]?.text).not.toContain("comfort");
  });

  it("does not fabricate publication times when none are supplied", async () => {
    const { ctx } = harness([run("posts"), [{ ...instagramPost, timestamp: undefined }]]);
    postOnly(ctx);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.items[0]?.publishedAt).toBeUndefined();
    expect(result.items[0]?.datePrecision).toBe("unknown");
  });

  it("accepts official nullable captions and safe numeric Instagram IDs without inventing text", async () => {
    const { ctx } = harness([run("posts"), [{ ...instagramPost, id: 12345, caption: null }]]);
    postOnly(ctx);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.items[0]).toMatchObject({
      recordId: "12345",
      text: "",
      recordType: "metadata",
      metadata: { id: 12345, caption: null },
    });
  });

  it("rejects unsafe numeric IDs rather than preserving an already rounded identifier", async () => {
    const { ctx } = harness([run("posts"), [{ ...instagramPost, id: 3923124318436838545 }]]);
    postOnly(ctx);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("error");
    expect(result.items).toHaveLength(0);
  });

  it("preserves official TikTok repliesToId and explicit Unix publication time", async () => {
    const { ctx } = harness([
      run("posts"),
      [tiktokPost],
      run("comments"),
      [
        {
          ...tiktokComment,
          repliesToId: "originalParentComment",
          createTimeISO: undefined,
          createTime: 1756403075,
        },
      ],
    ]);
    const result = await createApifyAdapter().collect(request("tiktok"), ctx);
    expect(result.items[1]).toMatchObject({
      parentId: "originalParentComment",
      publishedAt: "2025-08-28T17:44:35.000Z",
      datePrecision: "instant",
      metadata: { repliesToId: "originalParentComment", createTime: 1756403075 },
    });
  });

  it("keeps original comment permalink and explicit nested parent URL", async () => {
    const commentUrl = `${instagramUrl}c/${instagramComment.id}/`;
    const { ctx } = harness([
      run("posts"),
      [instagramPost],
      run("comments"),
      [{ ...instagramComment, postUrl: instagramUrl, commentUrl }],
    ]);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.items[1]).toMatchObject({
      sourceUrl: commentUrl,
      metadata: { parentUrl: instagramUrl, postUrl: instagramUrl, commentUrl },
    });
    expect(result.items[2]).toMatchObject({
      parentId: instagramComment.id,
      metadata: { parentUrl: commentUrl },
    });
  });

  it("retains comment-without-text metadata and accepts null optional error fields", async () => {
    const { ctx } = harness([
      run("posts"),
      [{ ...instagramPost, error: null }],
      run("comments"),
      [{ ...instagramComment, text: null, replies: [], error: null }],
    ]);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("success");
    expect(result.items[1]).toMatchObject({
      recordId: instagramComment.id,
      recordType: "metadata",
      text: "",
      metadata: { text: null, contentType: "comment" },
    });
  });

  it("continues other posts after an individual comment actor failure", async () => {
    const secondPost = {
      ...instagramPost,
      id: "originalSecondPost",
      url: "https://www.instagram.com/reel/SyntheticSecond/",
    };
    const { ctx, calls } = harness([
      run("posts"),
      [instagramPost, secondPost],
      new ProviderError("permission_required", "denied", 403),
      run("secondComments"),
      [{ ...instagramComment, replies: [] }],
    ]);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("partial");
    expect(result.items).toHaveLength(3);
    expect(result.items[2]).toMatchObject({
      sourceId: secondPost.id,
      context: { url: secondPost.url },
    });
    expect(actorCalls(calls)[2]?.options.body).toMatchObject({ directUrls: [secondPost.url] });
  });

  it("filters known explicit dates but preserves independently dated comments", async () => {
    const { ctx } = harness([run("posts"), [instagramPost], run("comments"), [instagramComment]]);
    const input = request();
    input.scope.publishedFrom = "2026-06-21";
    input.scope.publishedTo = "2026-06-21";
    const result = await createApifyAdapter().collect(input, ctx);
    expect(result.items.map((item) => item.recordId)).toEqual([
      instagramComment.id,
      instagramComment.replies[0]!.id,
    ]);
  });

  it("reports unknown publication dates rather than pretending the date filter was satisfied", async () => {
    const { ctx } = harness([run("posts"), [{ ...instagramPost, timestamp: null }]]);
    postOnly(ctx);
    const input = request();
    input.scope.publishedFrom = "2026-06-21";
    const result = await createApifyAdapter().collect(input, ctx);
    expect(result.items).toHaveLength(1);
    expect(result.limitations.join(" ")).toMatch(/date range cannot be proved/);
  });

  it("uses supported Instagram profiles and TikTok profile usernames as documented inputs", async () => {
    const instagram = harness([run("posts"), []]);
    const instagramRequest = request();
    instagramRequest.scope.urls = ["https://www.instagram.com/synthetic/"];
    await createApifyAdapter().collect(instagramRequest, instagram.ctx);
    expect(actorCalls(instagram.calls)[0]?.options.body).toMatchObject({
      directUrls: instagramRequest.scope.urls,
      resultsType: "posts",
    });
    const tiktok = harness([run("posts"), []]);
    const tiktokRequest = request("tiktok");
    tiktokRequest.scope.urls = ["https://www.tiktok.com/@synthetic"];
    await createApifyAdapter().collect(tiktokRequest, tiktok.ctx);
    expect(actorCalls(tiktok.calls)[0]?.options.body).toMatchObject({
      profiles: ["synthetic"],
      profileScrapeSections: ["videos"],
    });
  });

  it("matches Instagram reel inputs to resultsType reels and preserves canonical post/comment URLs", async () => {
    const reelUrl = "https://www.instagram.com/reel/Synthetic5/";
    const { ctx, calls } = harness([
      run("posts"),
      [{ ...instagramPost, url: reelUrl }],
      run("comments"),
      [
        {
          ...instagramComment,
          postUrl: instagramUrl,
          commentUrl: `${instagramUrl}c/${instagramComment.id}/`,
          replies: [],
        },
      ],
    ]);
    const input = request();
    input.scope.urls = [reelUrl];
    const result = await createApifyAdapter().collect(input, ctx);
    expect(result.status).toBe("success");
    expect(actorCalls(calls)[0]?.options.body).toMatchObject({
      resultsType: "reels",
      directUrls: [reelUrl],
    });
    expect(actorCalls(calls)[1]?.options.body).toMatchObject({ directUrls: [reelUrl] });
    expect(result.items[1]).toMatchObject({
      sourceUrl: `${instagramUrl}c/${instagramComment.id}/`,
      context: { url: reelUrl },
    });
  });

  it("honors request budget, attempts independent cleanup, and never loops indefinitely", async () => {
    const { ctx, calls } = harness([
      run("posts", "RUNNING"),
      run("posts", "RUNNING"),
      run("posts", "ABORTED"),
    ]);
    ctx.limits.maxRequests = 2;
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.status).toBe("error");
    expect(calls).toHaveLength(3); // Cleanup still goes through ctx.http; it may reject an exhausted common budget.
    expect(calls.at(-1)?.url.pathname).toBe("/v2/actor-runs/posts/abort");
    expect(result.limitations.join(" ")).toContain("limit_reached");
  });

  it("deduplicates original comment IDs across rows/nested replies", async () => {
    const { ctx } = harness([
      run("posts"),
      [instagramPost],
      run("comments"),
      [instagramComment, { ...instagramComment, replies: [] }],
    ]);
    const result = await createApifyAdapter().collect(request(), ctx);
    expect(result.items.map((item) => item.recordId)).toEqual([
      instagramPost.id,
      instagramComment.id,
      instagramComment.replies[0]!.id,
    ]);
  });
});

describe("Apify connection test", () => {
  it("only calls cheap users/me with bearer header, proving neither actor permissions nor usage rights", async () => {
    const { ctx, calls } = harness([{ data: { id: "syntheticUser", username: "synthetic" } }]);
    ctx.config.approval = "not_granted";
    ctx.config.allowedActors = [];
    const result = await createApifyAdapter().test(ctx);
    expect(result.state).toBe("success");
    expect(result.capabilities).toEqual(["token authentication"]);
    expect(result.limitations.join(" ")).toMatch(/actor permissions/i);
    expect(result.limitations.join(" ")).toMatch(/usage rights/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe("https://api.apify.com/v2/users/me");
    expect(calls[0]?.options.headers?.Authorization).toBe(
      `Bearer ${ctx.credentials.apify_api_token}`,
    );
  });

  it("does not make a connection call without a token", async () => {
    const { ctx, calls } = harness();
    ctx.credentials = {};
    expect((await createApifyAdapter().test(ctx)).state).toBe("not_configured");
    expect(calls).toHaveLength(0);
  });

  it.each(["invalid_credentials", "permission_required", "rate_limited", "unreachable"] as const)(
    "reports connection failure %s without leaking errors",
    async (code) => {
      const { ctx } = harness([new ProviderError(code, "synthetic-secret-for-offline-tests")]);
      const result = await createApifyAdapter().test(ctx);
      expect(result.state).toBe(code);
      expect(JSON.stringify(result)).not.toContain(ctx.credentials.apify_api_token);
    },
  );

  it("rejects malformed connection response instead of claiming valid credentials", async () => {
    const { ctx } = harness([{ data: {} }]);
    expect((await createApifyAdapter().test(ctx)).state).toBe("unreachable");
  });
});
