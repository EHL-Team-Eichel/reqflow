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

const TRANSCRIPTS =
  "YouTube transcripts are not available without supported authorized captions access; this adapter does not retrieve or reconstruct captions.";
const ATTRIBUTION =
  "Audience language, market, vehicle ownership and owner claims are unverified; query scope and video language are not audience attribution.";
const Comment = z.object({
  id: z.string().min(1),
  snippet: z
    .object({
      textOriginal: z.string().optional(),
      textDisplay: z.string().optional(),
      publishedAt: z.iso.datetime(),
      updatedAt: z.iso.datetime().optional(),
      parentId: z.string().optional(),
      authorDisplayName: z.string().optional(),
      authorChannelId: z.object({ value: z.string() }).optional(),
      authorChannelUrl: z.string().optional(),
      likeCount: z.number().optional(),
    })
    .refine(
      (s) => s.textOriginal !== undefined || s.textDisplay !== undefined,
      "Missing comment text",
    ),
});
const CommentPage = z.object({ items: z.array(Comment), nextPageToken: z.string().optional() });
const ThreadPage = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      snippet: z.object({
        videoId: z.string().optional(),
        totalReplyCount: z.number().int().nonnegative(),
        topLevelComment: Comment,
      }),
      replies: z.object({ comments: z.array(Comment) }).optional(),
    }),
  ),
  nextPageToken: z.string().optional(),
});
const SearchPage = z.object({
  items: z.array(z.object({ id: z.object({ videoId: z.string().min(1) }) })),
  nextPageToken: z.string().optional(),
});
const Video = z.object({
  id: z.string().min(1),
  snippet: z.object({
    title: z.string().min(1),
    description: z.string(),
    publishedAt: z.iso.datetime(),
    channelId: z.string(),
    channelTitle: z.string(),
    defaultLanguage: z.string().optional(),
    defaultAudioLanguage: z.string().optional(),
  }),
});
const VideoPage = z.object({ items: z.array(Video) });
type VideoData = z.infer<typeof Video>;
type CommentData = z.infer<typeof Comment>;

function guard(ctx: ProviderContext) {
  if (ctx.signal.aborted) throw new ProviderError("cancelled", "YouTube collection cancelled.");
  if (ctx.http.requests >= ctx.limits.maxRequests)
    throw new ProviderError("limit_reached", "YouTube request limit reached.");
}

async function get(
  ctx: ProviderContext,
  path: "search" | "videos" | "commentThreads" | "comments",
  params: Record<string, string>,
) {
  guard(ctx);
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  url.search = new URLSearchParams(params).toString();
  return ctx.http.json(url.href, {
    method: "GET",
    headers: { "X-Goog-Api-Key": ctx.credentials.youtube_api_key! },
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
  // Do not include error messages, URLs, tokens or provider bodies in logs or output.
  const message = `YouTube collection stopped (${reason}); previously collected records are retained.`;
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

function base(video: VideoData) {
  return {
    provider: "youtube" as const,
    sourceId: video.id,
    sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
    sourceTitle: video.snippet.title,
    sourceKind: "other_web" as const,
    publisher: video.snippet.channelTitle,
  };
}

function audience(
  video: VideoData,
  comment: CommentData,
  threadId: string,
  parent?: CommentData,
): CollectedItem {
  const original = comment.snippet.textOriginal !== undefined;
  return CollectedItem.parse({
    ...base(video),
    recordId: comment.id,
    recordType: "feedback",
    text: comment.snippet.textOriginal ?? comment.snippet.textDisplay!,
    publishedAt: comment.snippet.publishedAt,
    datePrecision: "instant",
    parentId: comment.snippet.parentId ?? parent?.id ?? video.id,
    threadId,
    locator: `comment ${comment.id}`,
    context: parent
      ? {
          id: parent.id,
          url: `${base(video).sourceUrl}&lc=${encodeURIComponent(parent.id)}`,
          text: parent.snippet.textOriginal ?? parent.snippet.textDisplay,
        }
      : { id: video.id, url: base(video).sourceUrl, text: video.snippet.description },
    metadata: {
      ...comment.snippet,
      videoId: video.id,
      threadId,
      textField: original ? "textOriginal" : "textDisplay",
      textFormat: "plainText",
    },
    limitations: [
      ATTRIBUTION,
      ...(!original
        ? [
            "textOriginal is not available for this public comment; textDisplay is retained exactly as returned in plainText format and may differ from the author's original.",
          ]
        : []),
    ],
  });
}

async function collect(
  request: CollectionRequest,
  ctx: ProviderContext,
): Promise<CollectionOutcome> {
  const items: CollectedItem[] = [];
  const limitations = [TRANSCRIPTS, ATTRIBUTION];
  const seenVideos = new Set<string>();
  const seenComments = new Set<string>();
  try {
    const scope = ResearchScope.parse(request.scope);
    const limits = ResearchLimits.parse(ctx.limits);
    const config = ResearchProviderConfig.parse(ctx.config);
    if (ctx.signal.aborted) throw new ProviderError("cancelled", "Cancelled.");
    if (!config.enabled)
      return {
        items,
        status: "blocked",
        limitations: [...limitations, "YouTube provider is disabled."],
      };
    if (!ctx.credentials.youtube_api_key?.trim())
      return {
        items,
        status: "missing_credentials",
        limitations: [...limitations, "Configure youtube_api_key."],
      };
    const queries = z
      .array(
        z
          .string()
          .min(1)
          .refine((s) => Boolean(s.trim())),
      )
      .parse(request.queries);
    const add = (item: CollectedItem) => {
      if (items.length >= limits.maxResults)
        throw new ProviderError("limit_reached", "YouTube result limit reached.");
      items.push(item);
    };
    const addComment = (
      video: VideoData,
      comment: CommentData,
      threadId: string,
      parent?: CommentData,
    ) => {
      if (!seenComments.has(comment.id)) {
        add(audience(video, comment, threadId, parent));
        seenComments.add(comment.id);
      }
    };
    for (const query of queries) {
      let searchToken: string | undefined;
      const searchTokens = new Set<string>();
      do {
        if (items.length >= limits.maxResults)
          throw new ProviderError("limit_reached", "YouTube result limit reached.");
        const params: Record<string, string> = {
          part: "snippet",
          type: "video",
          q: query,
          maxResults: String(Math.min(50, limits.maxResults - items.length)),
        };
        if (searchToken) params.pageToken = searchToken;
        if (scope.publishedFrom) params.publishedAfter = `${scope.publishedFrom}T00:00:00Z`;
        if (scope.publishedTo)
          params.publishedBefore = new Date(
            Date.parse(`${scope.publishedTo}T00:00:00Z`) + 86400000,
          ).toISOString();
        const page = SearchPage.parse(await get(ctx, "search", params));
        const ids = [...new Set(page.items.map((item) => item.id.videoId))].filter(
          (id) => !seenVideos.has(id),
        );
        if (ids.length) {
          const videos = VideoPage.parse(
            await get(ctx, "videos", { part: "snippet", id: ids.join(",") }),
          );
          const returned = new Set(videos.items.map((video) => video.id));
          if (ids.some((id) => !returned.has(id)))
            limitations.push("Some search videos were unavailable during videos.list hydration.");
          for (const video of videos.items) {
            if (seenVideos.has(video.id)) continue;
            add(
              CollectedItem.parse({
                ...base(video),
                recordId: video.id,
                recordType: "metadata",
                text: video.snippet.description,
                publishedAt: video.snippet.publishedAt,
                datePrecision: "instant",
                language: video.snippet.defaultLanguage,
                locator: "video author description",
                threadId: video.id,
                metadata: { ...video.snippet, contentRole: "video_author_description" },
                limitations: [TRANSCRIPTS, ATTRIBUTION],
              }),
            );
            seenVideos.add(video.id);
            let threadToken: string | undefined;
            const threadTokens = new Set<string>();
            do {
              if (items.length >= limits.maxResults)
                throw new ProviderError("limit_reached", "YouTube result limit reached.");
              const threads = ThreadPage.parse(
                await get(ctx, "commentThreads", {
                  part: "snippet,replies",
                  videoId: video.id,
                  textFormat: "plainText",
                  order: "time",
                  maxResults: String(Math.min(100, limits.maxResults - items.length)),
                  ...(threadToken ? { pageToken: threadToken } : {}),
                }),
              );
              for (const thread of threads.items) {
                const top = thread.snippet.topLevelComment;
                addComment(video, top, thread.id);
                const embedded = thread.replies?.comments ?? [];
                for (const reply of embedded) addComment(video, reply, thread.id, top);
                if (
                  new Set(embedded.map((reply) => reply.id)).size < thread.snippet.totalReplyCount
                ) {
                  let replyToken: string | undefined;
                  const replyTokens = new Set<string>();
                  const replyIds = new Set(embedded.map((reply) => reply.id));
                  do {
                    if (items.length >= limits.maxResults)
                      throw new ProviderError("limit_reached", "YouTube result limit reached.");
                    const replies = CommentPage.parse(
                      await get(ctx, "comments", {
                        part: "snippet",
                        parentId: top.id,
                        textFormat: "plainText",
                        maxResults: String(Math.min(100, limits.maxResults - items.length)),
                        ...(replyToken ? { pageToken: replyToken } : {}),
                      }),
                    );
                    for (const reply of replies.items) {
                      addComment(video, reply, thread.id, top);
                      replyIds.add(reply.id);
                    }
                    replyToken = replies.nextPageToken;
                    if (replyToken) {
                      if (replyTokens.has(replyToken))
                        throw new ProviderError("unreachable", "Repeated YouTube reply cursor.");
                      replyTokens.add(replyToken);
                    }
                  } while (replyToken);
                  if (replyIds.size < thread.snippet.totalReplyCount)
                    limitations.push(
                      "Some replies were unavailable or removed during comments.list pagination.",
                    );
                }
              }
              threadToken = threads.nextPageToken;
              if (threadToken) {
                if (threadTokens.has(threadToken))
                  throw new ProviderError("unreachable", "Repeated YouTube thread cursor.");
                threadTokens.add(threadToken);
              }
            } while (threadToken);
          }
        }
        searchToken = page.nextPageToken;
        if (searchToken) {
          if (searchTokens.has(searchToken))
            throw new ProviderError("unreachable", "Repeated YouTube search cursor.");
          searchTokens.add(searchToken);
        }
      } while (searchToken);
    }
    if (ctx.signal.aborted) throw new ProviderError("cancelled", "Cancelled.");
    return {
      items,
      status: limitations.length > 2 ? "partial" : items.length ? "success" : "empty",
      limitations,
    };
  } catch (error) {
    return failure(items, limitations, error, ctx);
  }
}

/** Official YouTube Data API v3; credentials and all network policy are injected. */
export function createYouTubeAdapter(): ProviderAdapter {
  return {
    id: "youtube",
    collect,
    async test(ctx) {
      if (!ctx.credentials.youtube_api_key?.trim())
        return {
          state: "not_configured",
          message: "Configure youtube_api_key.",
          capabilities: [],
          limitations: [TRANSCRIPTS],
        };
      try {
        ResearchLimits.parse(ctx.limits);
        z.object({ items: z.array(z.object({ id: z.string() })) }).parse(
          await get(ctx, "videos", { part: "id", chart: "mostPopular", maxResults: "1" }),
        );
        return {
          state: "success",
          message: "YouTube videos.list access verified. This check consumes provider quota.",
          testedAt: ctx.now(),
          capabilities: ["video_search", "video_metadata", "public_comments", "public_replies"],
          limitations: [
            TRANSCRIPTS,
            "Search and per-video comment permissions can still fail during collection.",
          ],
        };
      } catch (error) {
        const reason = code(error, ctx);
        return {
          state: reason === "cancelled" || reason === "limit_reached" ? "unreachable" : reason,
          message: `YouTube connection check failed (${reason}).`,
          testedAt: ctx.now(),
          capabilities: [],
          limitations: [TRANSCRIPTS],
        };
      }
    },
  };
}
