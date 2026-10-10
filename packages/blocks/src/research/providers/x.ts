import { z } from "zod";
import {
  CollectedItem,
  ResearchLimits,
  ResearchProviderConfig,
  ResearchScope,
} from "@reqflow/core";
import {
  ProviderError,
  type CollectionOutcome,
  type CollectionRequest,
  type ProviderAdapter,
  type ProviderContext,
} from "../provider";

const ATTRIBUTION =
  "Market, vehicle ownership and owner claims are unverified; query scope, language and free-form author location are not market attribution.";
const CONTENT =
  "Only provider-returned original post text is retained. Extended note_tweet text is preferred when available; unavailable long text and missing conversation context are not reconstructed. Search does not guarantee a complete conversation.";
const BILLING =
  "Requests, including connection checks, may bill under the account's current provider terms; no tariff is assumed.";
const Reference = z.object({ type: z.string(), id: z.string().min(1) });
const Post = z.object({
  id: z.string().min(1),
  text: z.string(),
  author_id: z.string().optional(),
  created_at: z.iso.datetime().optional(),
  lang: z.string().optional(),
  conversation_id: z.string().optional(),
  in_reply_to_user_id: z.string().optional(),
  referenced_tweets: z.array(Reference).optional(),
  note_tweet: z.object({ text: z.string() }).optional(),
  // Some current generated references use Post aliases. Accept returned aliases without guessing text.
  referenced_posts: z.array(Reference).optional(),
  note_post: z.object({ text: z.string() }).optional(),
});
const User = z.object({
  id: z.string(),
  username: z.string().optional(),
  name: z.string().optional(),
  location: z.string().optional(),
});
const Page = z
  .object({
    data: z.array(Post).optional(),
    includes: z
      .object({
        users: z.array(User).optional(),
        tweets: z.array(Post).optional(),
        posts: z.array(Post).optional(),
      })
      .optional(),
    meta: z
      .object({
        next_token: z.string().optional(),
        result_count: z.number().int().nonnegative().optional(),
      })
      .optional(),
    errors: z.array(z.object({ status: z.number().optional() })).optional(),
  })
  .refine(
    (p) => p.data !== undefined || p.meta !== undefined || Boolean(p.errors?.length),
    "Missing X search response fields",
  );
type PostData = z.infer<typeof Post>;
type UserData = z.infer<typeof User>;

function guard(ctx: ProviderContext) {
  if (ctx.signal.aborted) throw new ProviderError("cancelled", "X collection cancelled.");
  if (ctx.http.requests >= ctx.limits.maxRequests)
    throw new ProviderError("limit_reached", "X request limit reached.");
}

async function search(ctx: ProviderContext, params: Record<string, string>) {
  guard(ctx);
  const mode = ResearchProviderConfig.parse(ctx.config).xSearchMode;
  const url = new URL(
    mode === "full_archive"
      ? "https://api.x.com/2/tweets/search/all"
      : "https://api.x.com/2/tweets/search/recent",
  );
  url.search = new URLSearchParams({
    ...params,
    "tweet.fields":
      "id,text,created_at,conversation_id,in_reply_to_user_id,referenced_tweets,author_id,lang,note_tweet",
    expansions: "author_id,in_reply_to_user_id,referenced_tweets.id",
    "user.fields": "id,name,username,location",
  }).toString();
  return Page.parse(
    await ctx.http.json(url.href, {
      method: "GET",
      headers: { Authorization: `Bearer ${ctx.credentials.x_bearer_token!}` },
      signal: ctx.signal,
    }),
  );
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
  const message = `X collection stopped (${reason}); previously collected records are retained. No recent/archive fallback was attempted.`;
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

function returnedText(post: PostData) {
  return post.note_tweet?.text ?? post.note_post?.text ?? post.text;
}
function postUrl(id: string) {
  return `https://x.com/i/web/status/${encodeURIComponent(id)}`;
}

function item(
  post: PostData,
  authors: Map<string, UserData>,
  contextPosts: Map<string, PostData>,
): CollectedItem {
  const references = post.referenced_tweets ?? post.referenced_posts ?? [];
  const parentId = references.find((reference) => reference.type === "replied_to")?.id;
  const contextId =
    parentId ??
    (post.conversation_id !== post.id ? post.conversation_id : undefined) ??
    references[0]?.id;
  const parent = contextId ? contextPosts.get(contextId) : undefined;
  const author = post.author_id ? authors.get(post.author_id) : undefined;
  return CollectedItem.parse({
    provider: "x",
    sourceId: post.id,
    sourceUrl: postUrl(post.id),
    sourceTitle: `X post ${post.id}`,
    sourceKind: "other_web",
    publisher: author?.username ?? post.author_id,
    recordId: post.id,
    recordType: "feedback",
    text: returnedText(post),
    publishedAt: post.created_at,
    datePrecision: post.created_at ? "instant" : "unknown",
    language: post.lang,
    parentId,
    threadId: post.conversation_id,
    locator: `post ${post.id}`,
    context: contextId
      ? {
          id: contextId,
          url: postUrl(contextId),
          ...(parent ? { text: returnedText(parent) } : {}),
        }
      : undefined,
    metadata: {
      ...post,
      referenced_tweets: references,
      ...(author ? { author } : {}),
      textField: post.note_tweet ? "note_tweet.text" : post.note_post ? "note_post.text" : "text",
    },
    limitations: [
      ATTRIBUTION,
      CONTENT,
      ...(contextId && !parent
        ? ["Referenced context text was not returned by the provider."]
        : []),
    ],
  });
}

function checkProviderErrors(page: z.infer<typeof Page>) {
  if (page.errors?.length && !page.data?.length) {
    const status = page.errors.find(
      (error) => error.status === 401 || error.status === 403 || error.status === 429,
    )?.status;
    throw new ProviderError(
      status === 401
        ? "invalid_credentials"
        : status === 403
          ? "permission_required"
          : status === 429
            ? "rate_limited"
            : "unreachable",
      "X returned errors without usable posts.",
      status,
    );
  }
}

async function collect(
  request: CollectionRequest,
  ctx: ProviderContext,
): Promise<CollectionOutcome> {
  const items: CollectedItem[] = [];
  const limitations = [ATTRIBUTION, CONTENT, BILLING];
  try {
    const scope = ResearchScope.parse(request.scope);
    const limits = ResearchLimits.parse(ctx.limits);
    const config = ResearchProviderConfig.parse(ctx.config);
    if (ctx.signal.aborted) throw new ProviderError("cancelled", "Cancelled.");
    if (!config.enabled)
      return { items, status: "blocked", limitations: [...limitations, "X provider is disabled."] };
    if (!ctx.credentials.x_bearer_token?.trim())
      return {
        items,
        status: "missing_credentials",
        limitations: [...limitations, "Configure x_bearer_token."],
      };
    const queries = z
      .array(
        z
          .string()
          .min(1)
          .refine((s) => Boolean(s.trim())),
      )
      .parse(request.queries);
    const now = Date.parse(z.iso.datetime().parse(ctx.now()));
    const from = scope.publishedFrom ? Date.parse(`${scope.publishedFrom}T00:00:00Z`) : undefined;
    const to = scope.publishedTo
      ? Date.parse(`${scope.publishedTo}T00:00:00Z`) + 86400000
      : undefined;
    const oldestRecent = now - 7 * 86400000;
    if (
      (config.xSearchMode === "recent" &&
        ((from !== undefined && from < oldestRecent) ||
          (to !== undefined && to <= oldestRecent))) ||
      (from !== undefined && from >= now)
    ) {
      return {
        items,
        status: "blocked",
        limitations: [
          ...limitations,
          "Publication window is incompatible with the selected X search mode. Recent search only covers the last seven days; select full_archive for historical collection. No dates were silently truncated.",
        ],
      };
    }
    if (config.xSearchMode === "recent")
      limitations.push("Recent search covers only the last seven days, not historical posts.");
    const dates: Record<string, string> = {};
    if (from !== undefined) dates.start_time = new Date(from).toISOString();
    if (to !== undefined) {
      // X excludes end_time. Scope dates include the entire publishedTo day.
      dates.end_time = new Date(Math.min(to, now - 10000)).toISOString();
      if (to > now - 10000)
        limitations.push(
          "The publication end extends to the current/future day; end_time stops ten seconds before the connection clock, not at a historical cutoff.",
        );
    }
    const seen = new Set<string>();
    const authors = new Map<string, UserData>();
    const contextPosts = new Map<string, PostData>();
    let incomplete = false;
    for (const query of queries) {
      let next: string | undefined;
      const cursors = new Set<string>();
      do {
        if (items.length >= limits.maxResults)
          throw new ProviderError("limit_reached", "X result limit reached.");
        const page = await search(ctx, {
          query,
          ...dates,
          max_results: String(
            Math.max(
              10,
              Math.min(
                config.xSearchMode === "recent" ? 100 : 500,
                limits.maxResults - items.length,
              ),
            ),
          ),
          ...(next ? { next_token: next } : {}),
        });
        checkProviderErrors(page);
        if (page.errors?.length) {
          incomplete = true;
          limitations.push(
            "X returned partial resource/field errors; unavailable content was not reconstructed.",
          );
        }
        for (const author of page.includes?.users ?? []) authors.set(author.id, author);
        for (const post of [
          ...(page.includes?.tweets ?? []),
          ...(page.includes?.posts ?? []),
          ...(page.data ?? []),
        ])
          contextPosts.set(post.id, post);
        for (const post of page.data ?? []) {
          if (seen.has(post.id)) continue;
          if (items.length >= limits.maxResults)
            throw new ProviderError("limit_reached", "X result limit reached.");
          items.push(item(post, authors, contextPosts));
          seen.add(post.id);
        }
        next = page.meta?.next_token;
        if (next) {
          if (cursors.has(next))
            throw new ProviderError("unreachable", "Repeated X pagination cursor.");
          cursors.add(next);
        }
      } while (next);
    }
    if (ctx.signal.aborted) throw new ProviderError("cancelled", "Cancelled.");
    return {
      items,
      status: incomplete ? "partial" : items.length ? "success" : "empty",
      limitations,
    };
  } catch (error) {
    return failure(items, limitations, error, ctx);
  }
}

/** Official X API v2. The configured mode never falls back to a different time range. */
export function createXAdapter(): ProviderAdapter {
  return {
    id: "x",
    collect,
    async test(ctx) {
      if (!ctx.credentials.x_bearer_token?.trim())
        return {
          state: "not_configured",
          message: "Configure x_bearer_token.",
          capabilities: [],
          limitations: [BILLING],
        };
      try {
        ResearchLimits.parse(ctx.limits);
        const page = await search(ctx, { query: "BMW", max_results: "10" });
        checkProviderErrors(page);
        return {
          state: "success",
          message: `X ${ctx.config.xSearchMode} search access verified.`,
          testedAt: ctx.now(),
          capabilities: [
            ctx.config.xSearchMode === "full_archive" ? "full_archive_search" : "recent_search",
          ],
          limitations: [
            BILLING,
            CONTENT,
            ...(page.errors?.length
              ? ["Some resource/field permissions were unavailable during this check."]
              : []),
          ],
        };
      } catch (error) {
        const reason = code(error, ctx);
        return {
          state: reason === "cancelled" || reason === "limit_reached" ? "unreachable" : reason,
          message: `X connection check failed (${reason}); no search-mode fallback was attempted.`,
          testedAt: ctx.now(),
          capabilities: [],
          limitations: [BILLING],
        };
      }
    },
  };
}
