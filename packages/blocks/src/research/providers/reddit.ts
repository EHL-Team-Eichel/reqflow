import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
  type ResearchScope as Scope,
} from "@reqflow/core";
import {
  ProviderError,
  type CollectionOutcome,
  type CollectionRequest,
  type ProviderAdapter,
  type ProviderContext,
} from "../provider";

const ATTRIBUTION =
  "Market, language, vehicle ownership and owner claims are unverified. Text is retained without owner-claim extraction; subreddit and query scope are not market attribution.";
const APPROVAL =
  "Reddit data-use approval for this specific purpose is required separately from OAuth consent. Credentials do not grant commercial or research data-use permission.";
const COVERAGE =
  "Search selects submissions, not all Reddit comments. MoreComments stubs are not expanded with /api/morechildren in this adapter; any encountered omissions are reported as partial. No scraping fallback is used.";
const Thing = z.object({ kind: z.string(), data: z.record(z.string(), z.unknown()) });
const Listing = z.object({
  kind: z.literal("Listing"),
  data: z.object({ children: z.array(Thing), after: z.string().nullable().optional() }),
});
const Post = z.object({
  id: z.string().regex(/^[a-zA-Z0-9]+$/),
  name: z.string().regex(/^t3_[a-zA-Z0-9]+$/),
  title: z.string().min(1),
  selftext: z.string(),
  created_utc: z.number().nonnegative(),
  author: z.string().optional(),
  subreddit: z.string().optional(),
  permalink: z.string().optional(),
  url: z.string().optional(),
  num_comments: z.number().optional(),
  is_self: z.boolean().optional(),
});
const Comment = z.object({
  id: z.string().regex(/^[a-zA-Z0-9]+$/),
  name: z.string().regex(/^t1_[a-zA-Z0-9]+$/),
  body: z.string(),
  created_utc: z.number().nonnegative(),
  parent_id: z.string().min(1),
  link_id: z.string().optional(),
  author: z.string().optional(),
  subreddit: z.string().optional(),
  permalink: z.string().optional(),
  replies: z.unknown().optional(),
});
const Token = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((s) => s.toLowerCase() === "bearer"),
  scope: z.string(),
  expires_in: z.number().positive(),
});
type PostData = z.infer<typeof Post>;
type CommentData = z.infer<typeof Comment>;

function guard(ctx: ProviderContext) {
  if (ctx.signal.aborted) throw new ProviderError("cancelled", "Reddit collection cancelled.");
  if (ctx.http.requests >= ctx.limits.maxRequests)
    throw new ProviderError("limit_reached", "Reddit request limit reached.");
}

function configured(ctx: ProviderContext) {
  return Boolean(
    ctx.credentials.reddit_client_id?.trim() &&
    ctx.credentials.reddit_client_secret?.trim() &&
    ctx.credentials.reddit_refresh_token?.trim(),
  );
}

async function refresh(ctx: ProviderContext) {
  guard(ctx);
  const raw = await ctx.http.json("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    signal: ctx.signal,
    headers: {
      Authorization: `Basic ${Buffer.from(`${ctx.credentials.reddit_client_id!}:${ctx.credentials.reddit_client_secret!}`, "utf8").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": ctx.config.redditUserAgent,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: ctx.credentials.reddit_refresh_token!,
    }).toString(),
  });
  const oauthError = z.object({ error: z.string() }).safeParse(raw);
  if (oauthError.success)
    throw new ProviderError(
      oauthError.data.error === "invalid_grant" || oauthError.data.error === "invalid_client"
        ? "invalid_credentials"
        : "permission_required",
      "Reddit OAuth refresh failed.",
    );
  const token = Token.parse(raw);
  if (!token.scope.split(/\s+/).some((scope) => scope === "read" || scope === "*"))
    throw new ProviderError("permission_required", "Reddit refresh token requires read scope.");
  return token.access_token;
}

async function get(
  ctx: ProviderContext,
  accessToken: string,
  path: string,
  params: Record<string, string>,
) {
  guard(ctx);
  // Paths are adapter constants or constructed exclusively from validated ID36s, never provider URLs.
  const url = new URL(`https://oauth.reddit.com${path}`);
  url.search = new URLSearchParams({ ...params, raw_json: "1" }).toString();
  return ctx.http.json(url.href, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": ctx.config.redditUserAgent },
    signal: ctx.signal,
  });
}

function code(error: unknown, ctx: ProviderContext): ProviderError["code"] {
  if (ctx.signal.aborted || (error instanceof Error && error.name === "AbortError"))
    return "cancelled";
  if (error instanceof ProviderError) return error.code;
  const status =
    typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
  return status === 401
    ? "invalid_credentials"
    : status === 403
      ? "permission_required"
      : status === 429
        ? "rate_limited"
        : "unreachable";
}

function failure(
  items: CollectedItem[],
  limitations: string[],
  error: unknown,
  ctx: ProviderContext,
): CollectionOutcome {
  const reason = code(error, ctx);
  const message = `Reddit collection stopped (${reason}); previously collected records are retained. No scraping fallback was attempted.`;
  ctx.log(message);
  return {
    items,
    limitations: [...limitations, message],
    status:
      reason === "cancelled"
        ? "cancelled"
        : items.length || reason === "limit_reached"
          ? "partial"
          : reason === "invalid_credentials"
            ? "missing_credentials"
            : reason === "permission_required" || reason === "unsupported"
              ? "blocked"
              : "error",
  };
}

function threadUrl(post: PostData) {
  return `https://www.reddit.com/comments/${post.id}/`;
}
function commentUrl(post: PostData, comment: CommentData) {
  return `https://www.reddit.com/comments/${post.id}/_/${comment.id}/`;
}
function postText(post: PostData) {
  return post.selftext || post.title;
}
function instant(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}
function inWindow(seconds: number, scope: Scope) {
  const timestamp = seconds * 1000;
  return (
    (!scope.publishedFrom || timestamp >= Date.parse(`${scope.publishedFrom}T00:00:00Z`)) &&
    (!scope.publishedTo || timestamp < Date.parse(`${scope.publishedTo}T00:00:00Z`) + 86400000)
  );
}
function base(post: PostData) {
  return {
    provider: "reddit" as const,
    sourceId: post.name,
    sourceUrl: threadUrl(post),
    sourceTitle: post.title,
    sourceKind: "other_web" as const,
    publisher: post.subreddit ? `r/${post.subreddit}` : "Reddit",
  };
}

async function collect(
  request: CollectionRequest,
  ctx: ProviderContext,
): Promise<CollectionOutcome> {
  const items: CollectedItem[] = [];
  const limitations = [ATTRIBUTION, APPROVAL, COVERAGE];
  try {
    const scope = ResearchScope.parse(request.scope);
    const limits = ResearchLimits.parse(ctx.limits);
    const config = ResearchProviderConfig.parse(ctx.config);
    if (ctx.signal.aborted) throw new ProviderError("cancelled", "Cancelled.");
    if (!config.enabled)
      return {
        items,
        status: "blocked",
        limitations: [...limitations, "Reddit provider is disabled."],
      };
    if (config.approval !== "granted")
      return {
        items,
        status: "blocked",
        limitations: [...limitations, "Reddit data-use approval has not been granted."],
      };
    if (!configured(ctx))
      return {
        items,
        status: "missing_credentials",
        limitations: [
          ...limitations,
          "Configure reddit_client_id, reddit_client_secret and reddit_refresh_token with read scope.",
        ],
      };
    const queries = z
      .array(
        z
          .string()
          .min(1)
          .refine((s) => Boolean(s.trim())),
      )
      .parse(request.queries);
    if (!queries.length) return { items, status: "empty", limitations };
    const accessToken = await refresh(ctx);
    let incomplete = false;
    if (scope.publishedFrom || scope.publishedTo)
      limitations.push(
        "Reddit search has no arbitrary publication-date range parameter here. Returned submissions and comments are filtered by their own timestamps; comments in older, unselected threads can be missed.",
      );
    const seen = new Set<string>();
    const seenThreads = new Set<string>();
    const add = (item: CollectedItem) => {
      if (seen.has(item.recordId)) return;
      if (items.length >= limits.maxResults)
        throw new ProviderError("limit_reached", "Reddit result limit reached.");
      items.push(item);
      seen.add(item.recordId);
    };
    for (const query of queries) {
      let after: string | undefined;
      let count = 0;
      const cursors = new Set<string>();
      do {
        if (items.length >= limits.maxResults)
          throw new ProviderError("limit_reached", "Reddit result limit reached.");
        const page = Listing.parse(
          await get(ctx, accessToken, "/search.json", {
            q: query,
            type: "link",
            sort: "new",
            t: "all",
            limit: String(Math.min(100, limits.maxResults - items.length)),
            ...(after ? { after, count: String(count) } : {}),
          }),
        );
        count += page.data.children.length;
        for (const thing of page.data.children) {
          if (thing.kind !== "t3") {
            incomplete = true;
            limitations.push("A non-submission search result was not interpreted as evidence.");
            continue;
          }
          const post = Post.parse(thing.data);
          if (seenThreads.has(post.name)) continue;
          seenThreads.add(post.name);
          if (!inWindow(post.created_utc, scope)) continue;
          if (post.selftext === "[removed]" || post.selftext === "[deleted]") {
            incomplete = true;
            limitations.push(
              "A removed/deleted submission body is unavailable and was not treated as evidence.",
            );
          } else {
            add(
              CollectedItem.parse({
                ...base(post),
                recordId: post.name,
                recordType: "feedback",
                text: postText(post),
                publishedAt: instant(post.created_utc),
                datePrecision: "instant",
                threadId: post.name,
                locator: `submission ${post.name}`,
                metadata: {
                  ...post,
                  contentRole: post.selftext ? "submission_body" : "submission_title",
                },
                limitations: [ATTRIBUTION],
              }),
            );
          }
          if (items.length >= limits.maxResults)
            throw new ProviderError("limit_reached", "Reddit result limit reached.");
          const tree = z.tuple([Listing, Listing]).parse(
            await get(ctx, accessToken, `/comments/${post.id}.json`, {
              limit: String(Math.min(100, limits.maxResults - items.length)),
              sort: "new",
              showmore: "true",
            }),
          );
          if (tree[1].data.after) {
            incomplete = true;
            limitations.push(
              "An unexpected comment-tree cursor was returned; comments endpoints do not document listing-style after pagination, so remaining comments were not fetched.",
            );
          }
          const stack = [...tree[1].data.children].reverse();
          const comments = new Map<string, CommentData>();
          const ordered: CommentData[] = [];
          while (stack.length) {
            if (ctx.signal.aborted) throw new ProviderError("cancelled", "Cancelled.");
            const node = stack.pop()!;
            if (node.kind === "more") {
              incomplete = true;
              limitations.push(
                `MoreComments omitted in thread ${post.name}; bounded /api/morechildren expansion is not implemented.`,
              );
              continue;
            }
            if (node.kind !== "t1") {
              incomplete = true;
              limitations.push("An unknown comment-tree node was not interpreted as evidence.");
              continue;
            }
            const comment = Comment.parse(node.data);
            comments.set(comment.name, comment);
            ordered.push(comment);
            if (comment.replies !== undefined && comment.replies !== "") {
              const replies = Listing.parse(comment.replies);
              if (replies.data.after) {
                incomplete = true;
                limitations.push(
                  "An unexpected reply-tree cursor was returned; undocumented reply pagination was not attempted.",
                );
              }
              stack.push(...replies.data.children.slice().reverse());
            }
          }
          for (const comment of ordered) {
            if (!inWindow(comment.created_utc, scope)) continue;
            if (comment.body === "[removed]" || comment.body === "[deleted]") {
              incomplete = true;
              limitations.push(
                "A removed/deleted comment body is unavailable and was not treated as evidence.",
              );
              continue;
            }
            const parent = comments.get(comment.parent_id);
            add(
              CollectedItem.parse({
                ...base(post),
                recordId: comment.name,
                recordType: "feedback",
                text: comment.body,
                publishedAt: instant(comment.created_utc),
                datePrecision: "instant",
                parentId: comment.parent_id,
                threadId: comment.link_id ?? post.name,
                locator: `comment ${comment.name}`,
                context: parent
                  ? {
                      id: parent.name,
                      url: commentUrl(post, parent),
                      ...(parent.body !== "[removed]" && parent.body !== "[deleted]"
                        ? { text: parent.body }
                        : {}),
                    }
                  : comment.parent_id === post.name
                    ? {
                        id: post.name,
                        url: threadUrl(post),
                        ...(post.selftext !== "[removed]" && post.selftext !== "[deleted]"
                          ? { text: postText(post) }
                          : {}),
                      }
                    : { id: comment.parent_id },
                metadata: {
                  id: comment.id,
                  name: comment.name,
                  author: comment.author,
                  subreddit: comment.subreddit ?? post.subreddit,
                  parent_id: comment.parent_id,
                  link_id: comment.link_id ?? post.name,
                  created_utc: comment.created_utc,
                  permalink: comment.permalink,
                },
                limitations: [
                  ATTRIBUTION,
                  ...(!parent && comment.parent_id !== post.name
                    ? ["Parent comment text was not returned by the provider."]
                    : []),
                ],
              }),
            );
          }
        }
        after = page.data.after ?? undefined;
        if (after) {
          if (cursors.has(after))
            throw new ProviderError("unreachable", "Repeated Reddit pagination cursor.");
          cursors.add(after);
        }
      } while (after);
    }
    if (ctx.signal.aborted) throw new ProviderError("cancelled", "Cancelled.");
    return {
      items,
      status: incomplete ? "partial" : items.length ? "success" : "empty",
      limitations: [...new Set(limitations)],
    };
  } catch (error) {
    return failure(items, limitations, error, ctx);
  }
}

/** Approved Reddit Data API access using a previously authorized refresh token, never passwords. */
export function createRedditAdapter(): ProviderAdapter {
  return {
    id: "reddit",
    collect,
    async test(ctx) {
      if (ctx.config.approval !== "granted")
        return {
          state: "permission_required",
          message: "Reddit data-use approval has not been granted.",
          capabilities: [],
          limitations: [APPROVAL],
        };
      if (!configured(ctx))
        return {
          state: "not_configured",
          message:
            "Configure reddit_client_id, reddit_client_secret and reddit_refresh_token with read scope.",
          capabilities: [],
          limitations: [APPROVAL],
        };
      try {
        ResearchLimits.parse(ctx.limits);
        ResearchProviderConfig.parse(ctx.config);
        const token = await refresh(ctx);
        Listing.parse(
          await get(ctx, token, "/search.json", {
            q: "BMW",
            type: "link",
            limit: "1",
            sort: "new",
            t: "all",
          }),
        );
        return {
          state: "success",
          message: "Reddit OAuth refresh and approved read/search access verified.",
          testedAt: ctx.now(),
          capabilities: ["submission_search", "returned_comment_trees"],
          limitations: [
            APPROVAL,
            COVERAGE,
            "The connection check makes two requests; account-specific fees and access limits may apply.",
          ],
        };
      } catch (error) {
        const reason = code(error, ctx);
        return {
          state: reason === "cancelled" || reason === "limit_reached" ? "unreachable" : reason,
          message: `Reddit connection check failed (${reason}).`,
          testedAt: ctx.now(),
          capabilities: [],
          limitations: [APPROVAL],
        };
      }
    },
  };
}
