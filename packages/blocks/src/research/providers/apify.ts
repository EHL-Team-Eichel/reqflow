import { z } from "zod";
import {
  APIFY_ACTORS,
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
} from "@reqflow/core";
import type {
  CollectionOutcome,
  CollectionRequest,
  ProviderAdapter,
  ProviderContext,
} from "../provider";
import { ProviderError } from "../provider";

const API = "https://api.apify.com/v2";
type Actor = (typeof APIFY_ACTORS)[number];
type Platform = "instagram" | "tiktok";
// Selection is application-owned. Never select an actor from user input or infer approval.
const ACTORS = {
  instagram: { posts: "apify/instagram-scraper", comments: "apify/instagram-comment-scraper" },
  tiktok: { posts: "clockworks/tiktok-scraper", comments: "clockworks/tiktok-comments-scraper" },
} as const satisfies Record<Platform, { posts: Actor; comments: Actor }>;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED"]);
const Identifier = z.string().regex(/^[A-Za-z0-9_-]+$/);
const Run = z.object({
  data: z.object({
    id: Identifier,
    status: z.enum([
      "READY",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "TIMING-OUT",
      "TIMED-OUT",
      "ABORTING",
      "ABORTED",
    ]),
    defaultDatasetId: Identifier,
  }),
});
const OptionalText = z.string().nullish();
const OptionalFlag = z.boolean().nullish();
const OriginalId = z.union([z.string().min(1), z.number().int().nonnegative().safe()]);
const InstagramPost = z.looseObject({
  id: OriginalId,
  url: z.url(),
  caption: OptionalText,
  timestamp: OptionalText,
  ownerUsername: OptionalText,
  paidPartnership: OptionalFlag,
  affiliate: OptionalFlag,
});
const InstagramComment = z.looseObject({
  id: z.string().min(1),
  text: OptionalText,
  timestamp: OptionalText,
  postUrl: z.url().nullish(),
  commentUrl: z.url().nullish(),
  replies: z.array(z.unknown()).nullish(),
});
const TikTokPost = z.looseObject({
  id: z.string().min(1),
  webVideoUrl: z.url(),
  text: z.string(),
  textLanguage: OptionalText,
  createTimeISO: OptionalText,
  createTime: z.number().int().nonnegative().nullish(),
  isAd: OptionalFlag,
  isSponsored: OptionalFlag,
  videoMeta: z.looseObject({ subtitleLinks: z.array(z.unknown()).nullish() }).nullish(),
});
const TikTokComment = z.looseObject({
  cid: z.string().min(1),
  text: OptionalText,
  videoWebUrl: z.url(),
  createTimeISO: OptionalText,
  createTime: z.number().int().nonnegative().nullish(),
  repliesToId: OptionalText,
});

interface PostContext {
  id: string;
  url: string;
  text: string;
}
interface Job {
  input: Record<string, unknown>;
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function selected(data: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(
    keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]),
  );
}

function domainAllowed(url: URL, scope: CollectionRequest["scope"]) {
  const matches = (domain: string) => {
    const host = domain
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^\*\./, "");
    return host.length > 0 && (url.hostname === host || url.hostname.endsWith(`.${host}`));
  };
  return (
    !scope.blockedDomains.some(matches) &&
    (!scope.allowedDomains.length || scope.allowedDomains.some(matches))
  );
}

function supportedUrl(value: string, platform: Platform, postOnly = false): URL | undefined {
  const parsed = z.url().safeParse(value);
  if (!parsed.success) return;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) return;
  if (platform === "instagram") {
    if (!["instagram.com", "www.instagram.com"].includes(url.hostname)) return;
    if (/^\/(p|reel)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return url;
    if (!postOnly && /^\/explore\/tags\/[\p{L}\p{N}_]+\/?$/u.test(url.pathname)) return url;
    if (
      !postOnly &&
      /^\/[A-Za-z0-9_.]+\/?$/.test(url.pathname) &&
      !/^\/(accounts|explore|direct|stories|reels|about|developer)\/?$/.test(url.pathname)
    )
      return url;
  } else {
    if (!["tiktok.com", "www.tiktok.com"].includes(url.hostname)) return;
    if (/^\/@[^/]+\/video\/\d+\/?$/.test(url.pathname)) return url;
    if (!postOnly && /^\/@[A-Za-z0-9_.]+\/?$/.test(url.pathname)) return url;
  }
}

function samePost(left: string, right: string) {
  // Both are already supported platform post URLs. Ignore tracking queries and www aliases.
  const key = (value: string) => {
    const url = new URL(value);
    if (["instagram.com", "www.instagram.com"].includes(url.hostname)) {
      // Instagram exposes the same original shortcode through both post and reel URLs.
      const shortcode = /^\/(?:p|reel)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname)?.[1];
      if (shortcode) return `instagram.com:${shortcode}`;
    }
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`;
  };
  return key(left) === key(right);
}

function publication(value: string | null | undefined) {
  if (!value) return { datePrecision: "unknown" as const };
  const instant =
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
  return {
    publishedAt: value,
    datePrecision: instant ? ("instant" as const) : day ? ("day" as const) : ("unknown" as const),
  };
}

function inDateRange(item: CollectedItem, scope: CollectionRequest["scope"]) {
  if (!item.publishedAt || item.datePrecision === "unknown") return true;
  const date = new Date(item.publishedAt).toISOString().slice(0, 10);
  return (
    (!scope.publishedFrom || date >= scope.publishedFrom) &&
    (!scope.publishedTo || date <= scope.publishedTo)
  );
}

function postItem(
  platform: Platform,
  value: unknown,
  actor: Actor,
): { item: CollectedItem; post: PostContext } {
  const data = platform === "instagram" ? InstagramPost.parse(value) : TikTokPost.parse(value);
  const url = platform === "instagram" ? String(data.url) : String(data.webVideoUrl);
  if (!supportedUrl(url, platform, true)) throw new Error("malformed post URL");
  const id = String(data.id);
  const text =
    platform === "instagram"
      ? typeof data.caption === "string"
        ? data.caption
        : ""
      : String(data.text);
  let timestamp = platform === "instagram" ? data.timestamp : data.createTimeISO;
  if (!timestamp && platform === "tiktok" && typeof data.createTime === "number") {
    timestamp = new Date(data.createTime * 1000).toISOString();
  }
  const metadata = selected(
    data,
    platform === "instagram"
      ? [
          "id",
          "caption",
          "type",
          "shortCode",
          "ownerUsername",
          "ownerId",
          "paidPartnership",
          "affiliate",
          "sponsors",
          "alt",
          "isCommentsDisabled",
          "isPinned",
          "timestamp",
          "likesCount",
          "commentsCount",
          "hashtags",
          "mentions",
          "inputUrl",
        ]
      : [
          "textLanguage",
          "createTime",
          "createTimeISO",
          "isAd",
          "isSponsored",
          "isPinned",
          "locationCreated",
          "diggCount",
          "shareCount",
          "playCount",
          "commentCount",
          "hashtags",
          "submittedVideoUrl",
        ],
  );
  if (platform === "tiktok" && data.videoMeta && typeof data.videoMeta === "object") {
    metadata.videoMeta = selected(data.videoMeta as Record<string, unknown>, [
      "duration",
      "height",
      "width",
      "subtitleLinks",
    ]);
  }
  metadata.actor = actor;
  const item = CollectedItem.parse({
    provider: "apify",
    sourceId: id,
    sourceUrl: url,
    sourceTitle: `${platform === "instagram" ? "Instagram" : "TikTok"} post ${id}`,
    sourceKind: "other_web",
    recordId: id,
    recordType: text.length ? "passage" : "metadata",
    text,
    ...publication(typeof timestamp === "string" ? timestamp : undefined),
    ...(platform === "tiktok" && typeof data.textLanguage === "string"
      ? { language: data.textLanguage }
      : {}),
    threadId: id,
    locator: platform === "instagram" ? "caption" : "text",
    metadata,
    limitations: [
      "A post caption is source content, not an inferred customer opinion. Images and audio are not interpreted.",
    ],
  });
  return { item, post: { id: item.recordId, url, text } };
}

function commentItem(
  platform: Platform,
  value: unknown,
  post: PostContext,
  actor: Actor,
  parentId?: string,
  parentUrl?: string,
) {
  const data =
    platform === "instagram" ? InstagramComment.parse(value) : TikTokComment.parse(value);
  const id = platform === "instagram" ? String(data.id) : String(data.cid);
  const url = platform === "instagram" ? data.postUrl : data.videoWebUrl;
  if (typeof url === "string" && (!supportedUrl(url, platform, true) || !samePost(url, post.url))) {
    throw new Error("malformed comment post URL");
  }
  let sourceUrl = typeof url === "string" ? url : post.url;
  let timestamp = platform === "instagram" ? data.timestamp : data.createTimeISO;
  if (!timestamp && platform === "tiktok" && typeof data.createTime === "number") {
    timestamp = new Date(data.createTime * 1000).toISOString();
  }
  // Only the actor's explicit repliesToId establishes a TikTok reply relationship.
  if (platform === "tiktok" && typeof data.repliesToId === "string" && data.repliesToId.length) {
    parentId = data.repliesToId;
  }
  if (platform === "instagram" && typeof data.commentUrl === "string") {
    const permalink = new URL(data.commentUrl);
    const parentPath = permalink.pathname.replace(/\/c\/[^/]+\/?$/, "/");
    const parent = `${permalink.origin}${parentPath}`;
    if (
      !["instagram.com", "www.instagram.com"].includes(permalink.hostname) ||
      permalink.protocol !== "https:" ||
      permalink.username ||
      permalink.password ||
      permalink.port ||
      parentPath === permalink.pathname ||
      !supportedUrl(parent, platform, true) ||
      !samePost(parent, post.url)
    ) {
      throw new Error("malformed comment permalink");
    }
    sourceUrl = data.commentUrl;
  }
  return {
    item: CollectedItem.parse({
      provider: "apify",
      sourceId: post.id,
      sourceUrl,
      sourceTitle: `${platform === "instagram" ? "Instagram" : "TikTok"} comments on ${post.id}`,
      sourceKind: "other_web",
      recordId: id,
      recordType: typeof data.text === "string" ? "feedback" : "metadata",
      text: typeof data.text === "string" ? data.text : "",
      ...publication(typeof timestamp === "string" ? timestamp : undefined),
      parentId,
      threadId: post.id,
      context: post,
      locator: `comment ${id}`,
      metadata: {
        actor,
        contentType: "comment",
        ...(parentUrl ? { parentUrl } : {}),
        ...selected(
          data,
          platform === "instagram"
            ? [
                "text",
                "ownerUsername",
                "likesCount",
                "repliesCount",
                "postId",
                "postUrl",
                "commentUrl",
                "timestamp",
              ]
            : [
                "text",
                "cid",
                "uid",
                "uniqueId",
                "diggCount",
                "replyCommentTotal",
                "videoWebUrl",
                "createTime",
                "createTimeISO",
                "repliesToId",
              ],
        ),
      },
      limitations:
        platform === "tiktok" && !parentId
          ? ["No reply parent ID was supplied; no reply relationship is inferred."]
          : [],
    }),
    replies: platform === "instagram" && Array.isArray(data.replies) ? data.replies : [],
  };
}

function plan(
  request: CollectionRequest,
  platform: Platform,
  count: number,
  note: (message: string) => void,
): Job[] {
  const safeTikTokInput = {
    resultsPerPage: count,
    commentsPerPost: 0,
    maxRepliesPerComment: 0,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadAvatars: false,
    shouldDownloadSlideshowImages: false,
    shouldDownloadMusicCovers: false,
    downloadSubtitlesOptions: "NEVER_DOWNLOAD_SUBTITLES",
    aiVideoDescription: false,
    aiVideoSummary: false,
    scrapeRelatedVideos: false,
    scrapeAdditionalAuthorMeta: false,
    maxFollowersPerProfile: 0,
    maxFollowingPerProfile: 0,
  };
  if (request.scope.urls.length) {
    const urls = [...new Set(request.scope.urls)]
      .filter((value) => {
        const url = supportedUrl(value, platform);
        if (!url || !domainAllowed(url, request.scope)) {
          note(
            "Unsupported or domain-blocked explicit URL was skipped; explicit URLs do not fall back to search.",
          );
          return false;
        }
        return true;
      })
      .slice(0, count);
    if (!urls.length) return [];
    if (platform === "instagram") {
      const reels = urls.filter((value) => new URL(value).pathname.startsWith("/reel/"));
      const posts = urls.filter((value) => !new URL(value).pathname.startsWith("/reel/"));
      return [
        ...(posts.length
          ? [{ input: { directUrls: posts, resultsType: "posts", resultsLimit: count } }]
          : []),
        ...(reels.length
          ? [{ input: { directUrls: reels, resultsType: "reels", resultsLimit: count } }]
          : []),
      ];
    }
    const postURLs = urls.filter((url) => supportedUrl(url, platform, true));
    const profiles = urls
      .filter((url) => !supportedUrl(url, platform, true))
      .map((url) => new URL(url).pathname.slice(2).replace(/\/$/, ""));
    return [
      {
        input: {
          ...safeTikTokInput,
          ...(postURLs.length ? { postURLs } : {}),
          ...(profiles.length
            ? { profiles, profileScrapeSections: ["videos"], profileSorting: "latest" }
            : {}),
        },
      },
    ];
  }
  const site = new URL(
    platform === "instagram" ? "https://www.instagram.com" : "https://www.tiktok.com",
  );
  if (!domainAllowed(site, request.scope)) {
    note("Platform is excluded by the scope's domain restrictions.");
    return [];
  }
  const queries = [
    ...new Set(request.queries.length ? request.queries : request.scope.keywords),
  ].filter((query) => query.trim().length > 0);
  if (platform === "instagram") {
    const hashtags = queries.filter((query) => /^#[\p{L}\p{N}_]+$/u.test(query));
    if (hashtags.length !== queries.length || !hashtags.length)
      note(
        "Instagram does not support general keyword post search here. Supply supported URLs or literal #hashtag queries.",
      );
    return hashtags.slice(0, count).map((search) => ({
      input: {
        search,
        searchType: "hashtag",
        searchLimit: 1,
        resultsType: "posts",
        resultsLimit: count,
      },
    }));
  }
  if (!queries.length) note("TikTok requires supported URLs or keyword queries.");
  return queries.length
    ? [
        {
          input: {
            ...safeTikTokInput,
            searchQueries: queries.slice(0, count),
            searchSection: "/video",
          },
        },
      ]
    : [];
}

function safeFailure(error: unknown) {
  if (error instanceof ProviderError)
    return `Apify request failed (${error.code}${error.status ? `, HTTP ${error.status}` : ""}).`;
  if (error instanceof z.ZodError)
    return "Apify returned a malformed response that does not match the documented schema.";
  return "Apify request failed or returned a malformed response.";
}

function hasActorError(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return Boolean(data.error || data.errorCode);
}

async function execute(
  actor: Actor,
  input: Record<string, unknown>,
  rowLimit: number,
  ctx: ProviderContext,
  signal: AbortSignal,
  token: string,
  deadline: number,
  row: (value: unknown) => void,
  note: (message: string) => void,
  done: () => boolean,
) {
  if (
    !APIFY_ACTORS.includes(actor) ||
    ctx.config.approval !== "granted" ||
    !ctx.config.allowedActors.includes(actor)
  ) {
    throw new ProviderError("permission_required", "Exact actor approval is required.");
  }
  let runId: string | undefined;
  let terminal = false;
  let startAttempted = false;
  const json = async (path: string, method: "GET" | "POST" = "GET", body?: unknown) => {
    signal.throwIfAborted();
    if (ctx.http.requests >= ctx.limits.maxRequests)
      throw new ProviderError("limit_reached", "HTTP request budget reached.");
    return ctx.http.json(`${API}${path}`, {
      method,
      headers: headers(token),
      signal,
      ...(body ? { body } : {}),
    });
  };
  try {
    const parameters = new URLSearchParams({
      maxTotalChargeUsd: String(ctx.limits.maxApifyChargeUsd),
      memory: "1024",
      timeout: String(Math.max(1, Math.floor((deadline - Date.now()) / 1000))),
      waitForFinish: "0",
      restartOnError: "false",
      maxItems: String(rowLimit),
    });
    signal.throwIfAborted();
    startAttempted = true;
    const started = await json(
      `/actors/${actor.replace("/", "~")}/runs?${parameters}`,
      "POST",
      input,
    );
    // Retain a safe run ID even when the rest of the response is malformed, so cleanup remains possible.
    const identity = z.object({ data: z.object({ id: Identifier }) }).safeParse(started);
    if (identity.success) runId = identity.data.data.id;
    let run = Run.parse(started).data;
    terminal = TERMINAL.has(run.status);
    while (!terminal) {
      signal.throwIfAborted();
      const wait = Math.max(1, Math.min(5, Math.floor((deadline - Date.now()) / 1000)));
      run = Run.parse(await json(`/actor-runs/${runId}?waitForFinish=${wait}`)).data;
      if (run.id !== runId) throw new Error("malformed run identity");
      terminal = TERMINAL.has(run.status);
    }
    signal.throwIfAborted();
    if (run.status !== "SUCCEEDED")
      note(
        `${actor} ended with ${run.status}; existing dataset records are retained when available.`,
      );
    // Do not use clean/skipEmpty/unwind: offsets must refer to raw dataset items, including errors.
    let offset = 0;
    while (offset < rowLimit) {
      const limit = Math.min(50, rowLimit - offset);
      const parameters = new URLSearchParams({
        format: "json",
        clean: "false",
        offset: String(offset),
        limit: String(limit),
      });
      const page = await json(`/datasets/${run.defaultDatasetId}/items?${parameters}`);
      if (!Array.isArray(page)) throw new Error("malformed dataset envelope");
      signal.throwIfAborted();
      if (page.length > limit)
        note(
          `${actor} returned more dataset items than requested; excess records were not collected.`,
        );
      for (const value of page.slice(0, limit)) {
        if (done()) break;
        row(value);
      }
      offset += Math.min(page.length, limit);
      if (page.length < limit || done()) break;
    }
  } catch (error) {
    if (
      startAttempted &&
      !runId &&
      !(
        error instanceof ProviderError &&
        ["invalid_credentials", "permission_required", "limit_reached"].includes(error.code)
      )
    ) {
      note(
        "Actor start was not confirmed and its run ID is unknown; abort is impossible. Costs may continue until the server timeout.",
      );
    }
    throw error;
  } finally {
    if (runId && !terminal) {
      // The cancelled collection signal must not cancel its cleanup. Still use the common HTTP service.
      const cleanup = new AbortController();
      const timer = setTimeout(() => cleanup.abort(), 5000);
      try {
        const response = Run.parse(
          await ctx.http.json(`${API}/actor-runs/${runId}/abort?gracefully=false`, {
            method: "POST",
            headers: headers(token),
            signal: cleanup.signal,
          }),
        ).data;
        if (response.id !== runId || response.status !== "ABORTED") {
          note(
            "Actor abort was requested but final termination is not confirmed; costs may continue until termination or the server timeout.",
          );
        } else {
          note(
            "Actor was aborted; costs already incurred and costs during cancellation are not refunded.",
          );
        }
      } catch {
        note(
          "Actor abort is not confirmed; costs may continue until the server timeout. Check the Apify console.",
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/** Main-process adapter. Credentials and every HTTP operation are supplied by ProviderContext. */
export function createApifyAdapter(): ProviderAdapter {
  return {
    id: "apify",
    async collect(request, ctx): Promise<CollectionOutcome> {
      const items: CollectedItem[] = [];
      const limitations: string[] = [];
      let degraded = false;
      const note = (message: string) => {
        degraded = true;
        if (!limitations.includes(message)) {
          limitations.push(message);
          ctx.log(message);
        }
      };
      const outcome = (status: CollectionOutcome["status"]): CollectionOutcome => ({
        items,
        status,
        limitations,
      });
      if (request.agentId !== "instagram" && request.agentId !== "tiktok") {
        note("Apify supports only the instagram and tiktok research agents.");
        return outcome("blocked");
      }
      const config = ResearchProviderConfig.safeParse(ctx.config);
      if (!config.success || !config.data.enabled || config.data.approval !== "granted") {
        note(
          "Apify must be enabled with explicit granted approval and a valid exact actor allowlist.",
        );
        return outcome("blocked");
      }
      const platform = request.agentId;
      const actors = ACTORS[platform];
      if (!config.data.allowedActors.includes(actors.posts)) {
        note(
          `Explicit permission for ${actors.posts} is required for post discovery; no actor permission is inferred.`,
        );
        return outcome("blocked");
      }
      const token = ctx.credentials.apify_api_token;
      if (!token?.trim()) {
        note("Configure apify_api_token before collection.");
        return outcome("missing_credentials");
      }
      const limits = ResearchLimits.safeParse(ctx.limits);
      const scope = ResearchScope.safeParse(request.scope);
      const queries = z.array(z.string()).safeParse(request.queries);
      if (!limits.success || !scope.success || !queries.success) {
        note("Invalid Apify research scope, queries or limits.");
        return outcome("blocked");
      }
      ctx = { ...ctx, config: config.data, limits: limits.data };
      request = { ...request, scope: scope.data, queries: queries.data };
      if (ctx.signal.aborted) return outcome("cancelled");
      const commentsAllowed = config.data.allowedActors.includes(actors.comments);
      if (!commentsAllowed)
        note(`${actors.comments} is not explicitly allowed; only post captions will be collected.`);
      const postLimit = commentsAllowed
        ? Math.ceil(ctx.limits.maxResults / 2)
        : ctx.limits.maxResults;
      const jobs = plan(request, platform, postLimit, note);
      if (!jobs.length) return outcome("blocked");
      const deadline = Date.now() + ctx.limits.timeoutMs;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), ctx.limits.timeoutMs);
      const signal = AbortSignal.any([ctx.signal, timeout.signal]);
      const posts = new Map<string, PostContext>();
      const seen = new Set<string>();
      const add = (item: CollectedItem) => {
        if (
          !domainAllowed(new URL(item.sourceUrl), request.scope) ||
          !inDateRange(item, request.scope)
        )
          return;
        if (
          (request.scope.publishedFrom || request.scope.publishedTo) &&
          item.datePrecision === "unknown"
        ) {
          note(
            "A record has no usable explicit publication date; the requested date range cannot be proved for that record.",
          );
        }
        const key = `${item.metadata.contentType === "comment" ? "comment" : "post"}:${item.recordId}`;
        if (seen.has(key) || items.length >= ctx.limits.maxResults) return;
        seen.add(key);
        items.push(item);
      };
      const failure = (actor: Actor, error: unknown) => note(`${actor}: ${safeFailure(error)}`);
      try {
        for (const job of jobs) {
          if (posts.size >= postLimit || signal.aborted) break;
          try {
            await execute(
              actors.posts,
              job.input,
              postLimit - posts.size,
              ctx,
              signal,
              token,
              deadline,
              (value) => {
                if (hasActorError(value)) {
                  note(
                    `${actors.posts}: actor returned an individual error record; other records are retained.`,
                  );
                  return;
                }
                try {
                  const { item, post } = postItem(platform, value, actors.posts);
                  if (posts.size < postLimit && domainAllowed(new URL(post.url), request.scope))
                    posts.set(post.id, post);
                  add(item);
                } catch {
                  note(
                    `${actors.posts}: malformed post record was skipped; other records are retained.`,
                  );
                }
              },
              note,
              () => posts.size >= postLimit,
            );
          } catch (error) {
            failure(actors.posts, error);
          }
        }
        if (commentsAllowed)
          for (const post of posts.values()) {
            if (items.length >= ctx.limits.maxResults || signal.aborted) break;
            const remaining = ctx.limits.maxResults - items.length;
            const input =
              platform === "instagram"
                ? { directUrls: [post.url], resultsLimit: remaining, includeNestedComments: false }
                : {
                    postURLs: [post.url],
                    commentsPerPost: remaining,
                    topLevelCommentsPerPost: remaining,
                    maxRepliesPerComment: 0,
                  };
            const visit = (value: unknown, parentId?: string, parentUrl?: string, depth = 0) => {
              if (depth > 10) {
                note("Malformed comment nesting exceeded the safe depth limit.");
                return;
              }
              if (hasActorError(value)) {
                note(
                  `${actors.comments}: actor returned an individual error record; other records are retained.`,
                );
                return;
              }
              try {
                const { item, replies } = commentItem(
                  platform,
                  value,
                  post,
                  actors.comments,
                  parentId,
                  parentUrl,
                );
                add(item);
                for (const reply of replies) {
                  if (items.length >= ctx.limits.maxResults) break;
                  visit(
                    reply,
                    item.recordId,
                    typeof item.metadata.commentUrl === "string"
                      ? item.metadata.commentUrl
                      : undefined,
                    depth + 1,
                  );
                }
              } catch {
                note(
                  `${actors.comments}: malformed comment record was skipped; other records are retained.`,
                );
              }
            };
            try {
              await execute(
                actors.comments,
                input,
                remaining,
                ctx,
                signal,
                token,
                deadline,
                (value) =>
                  visit(
                    value,
                    platform === "instagram" ? post.id : undefined,
                    platform === "instagram" ? post.url : undefined,
                  ),
                note,
                () => items.length >= ctx.limits.maxResults,
              );
            } catch (error) {
              failure(actors.comments, error);
            }
          }
        if (ctx.signal.aborted) return outcome("cancelled");
        if (timeout.signal.aborted)
          note("Apify collection timeout reached; available records were retained.");
        return outcome(
          items.length ? (degraded ? "partial" : "success") : degraded ? "error" : "empty",
        );
      } finally {
        clearTimeout(timer);
      }
    },
    async test(ctx) {
      const limitations = [
        "Actor permissions and usage rights are NOT proved by this token test; explicit approval and an exact actor allowlist remain required.",
      ];
      const token = ctx.credentials.apify_api_token;
      if (!token?.trim())
        return {
          state: "not_configured",
          message: "Configure apify_api_token.",
          capabilities: [],
          limitations,
        };
      try {
        const response = await ctx.http.json(`${API}/users/me`, {
          headers: headers(token),
          signal: ctx.signal,
        });
        z.object({ data: z.object({ id: z.string().min(1) }) }).parse(response);
        return {
          state: "success",
          message: "Apify token authentication succeeded. No actor was run.",
          testedAt: ctx.now(),
          capabilities: ["token authentication"],
          limitations,
        };
      } catch (error) {
        const state =
          error instanceof ProviderError &&
          ["invalid_credentials", "permission_required", "rate_limited", "unsupported"].includes(
            error.code,
          )
            ? (error.code as
                "invalid_credentials" | "permission_required" | "rate_limited" | "unsupported")
            : "unreachable";
        return {
          state,
          message: safeFailure(error),
          testedAt: ctx.now(),
          capabilities: [],
          limitations,
        };
      }
    },
  };
}
