import { CollectedItem, ResearchLimits, ResearchScope, type ConnectionReport } from "@reqflow/core";
import { z } from "zod";
import { ProviderError, type ProviderAdapter, type ProviderContext } from "../provider";

const Location = z
  .object({
    is_oa: z.boolean().optional(),
    pdf_url: z.string().nullable().optional(),
    landing_page_url: z.string().nullable().optional(),
    source: z
      .object({
        display_name: z.string().nullable().optional(),
        host_organization_name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
const Work = z
  .object({
    id: z.string().regex(/^https:\/\/openalex\.org\/W\d+$/),
    title: z.string().nullable().optional(),
    display_name: z.string().nullable().optional(),
    doi: z.string().nullable().optional(),
    publication_date: z.string().nullable().optional(),
    publication_year: z.number().int().nullable().optional(),
    language: z.string().nullable().optional(),
    type: z.string().optional(),
    abstract_inverted_index: z
      .record(z.string(), z.array(z.number().int().nonnegative()))
      .nullable()
      .optional(),
    primary_location: Location.nullable().optional(),
    best_oa_location: Location.nullable().optional(),
    authorships: z.array(z.unknown()).optional(),
    biblio: z.unknown().optional(),
    ids: z.unknown().optional(),
    open_access: z.unknown().optional(),
    is_retracted: z.boolean().optional(),
  })
  .passthrough();
const Page = z.object({
  meta: z.object({ next_cursor: z.string().nullable().optional() }),
  results: z.array(Work),
});
const COVERAGE = [
  "OpenAlex collects publication metadata and available abstracts, not complete commercial market studies.",
  "No full text is retrieved. Primary original URLs are references reported by OpenAlex, not verified downloads.",
  "Search scope is not evidence of a study's geographic or vehicle applicability. Metadata language may differ from full text.",
];

function headers(ctx: ProviderContext): Record<string, string> | undefined {
  const key = ctx.credentials.openalex_api_key;
  // Official API supports bearer authentication; avoid secrets in URLs/logging middleware.
  return key ? { Authorization: `Bearer ${key}` } : undefined;
}
function abstract(index: z.infer<typeof Work>["abstract_inverted_index"]): string | undefined {
  if (!index) return undefined;
  const words = new Map<number, string>();
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) {
      if (position > 100_000 || words.has(position)) return undefined;
      words.set(position, word);
    }
  }
  if (!words.size || Math.max(...words.keys()) !== words.size - 1) return undefined;
  return Array.from({ length: words.size }, (_, i) => words.get(i)!).join(" ");
}
function publicUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return undefined;
    if ([...url.searchParams.keys()].some((key) => /key|token|signature|credential/i.test(key)))
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
function item(work: z.infer<typeof Work>): CollectedItem {
  const content = abstract(work.abstract_inverted_index);
  const location = work.primary_location;
  const original = location?.is_oa === true ? publicUrl(location.pdf_url) : undefined;
  const title = work.title || work.display_name || work.id;
  return CollectedItem.parse({
    provider: "openalex",
    sourceId: work.id,
    sourceUrl: work.id,
    sourceTitle: title,
    sourceKind: "market_trend",
    publisher:
      location?.source?.host_organization_name || location?.source?.display_name || undefined,
    recordId: `${work.id}:${content === undefined ? "metadata" : "abstract"}`,
    recordType: content === undefined ? "metadata" : "passage",
    text: content === undefined ? title : `ABSTRACT\n${content}`,
    locator: content === undefined ? "publication metadata" : "abstract_inverted_index (ABSTRACT)",
    publishedAt:
      work.publication_date || (work.publication_year ? String(work.publication_year) : undefined),
    datePrecision: work.publication_date ? "day" : work.publication_year ? "year" : "unknown",
    language: work.language || undefined,
    metadata: {
      contentLevel: content === undefined ? "metadata" : "abstract",
      fullTextRetrieved: false,
      doi: publicUrl(work.doi),
      publication_year: work.publication_year,
      type: work.type,
      authorships: work.authorships,
      biblio: work.biblio,
      ids: work.ids,
      open_access: work.open_access,
      is_retracted: work.is_retracted,
      primaryLandingPage: publicUrl(location?.landing_page_url),
      primaryOriginal: original
        ? { url: original, retrieved: false, accessibility: "provider_metadata" }
        : undefined,
    },
    limitations: [
      "ABSTRACT or publication metadata only; not full text.",
      ...(content === undefined
        ? [
            work.abstract_inverted_index
              ? "Abstract inverted index is incomplete or ambiguous; no abstract reconstructed."
              : "No abstract supplied by OpenAlex.",
          ]
        : []),
      ...(work.is_retracted ? ["OpenAlex marks this work as retracted."] : []),
    ],
  });
}
function failure(
  error: unknown,
  ctx: ProviderContext,
): { state: ConnectionReport["state"]; message: string } {
  const code = error instanceof ProviderError ? error.code : undefined;
  if (ctx.signal.aborted || code === "cancelled")
    return { state: "unreachable", message: "OpenAlex request cancelled." };
  if (code === "invalid_credentials")
    return { state: "invalid_credentials", message: "OpenAlex rejected credentials." };
  if (code === "permission_required")
    return { state: "permission_required", message: "OpenAlex permission required." };
  if (code === "rate_limited")
    return { state: "rate_limited", message: "OpenAlex rate limit reached." };
  if (code === "limit_reached")
    return { state: "unreachable", message: "OpenAlex request budget reached." };
  return { state: "unreachable", message: "OpenAlex request failed or returned invalid metadata." };
}

export function createOpenAlexAdapter(): ProviderAdapter {
  return {
    id: "openalex",
    async collect(request, ctx) {
      const scope = ResearchScope.parse(request.scope);
      const limits = ResearchLimits.parse(ctx.limits);
      const queries = [
        ...new Set(
          (request.queries.length
            ? request.queries
            : scope.questions.length
              ? scope.questions
              : [
                  scope.keywords.length
                    ? scope.keywords.join(" ")
                    : [scope.brand, scope.model, scope.derivative, ...scope.markets]
                        .filter(Boolean)
                        .join(" "),
                ]
          )
            .map((q) => q.trim())
            .filter(Boolean),
        ),
      ];
      const filters = [
        scope.publishedFrom && `from_publication_date:${scope.publishedFrom}`,
        scope.publishedTo && `to_publication_date:${scope.publishedTo}`,
      ].filter(Boolean) as string[];
      const languages = [
        ...new Set(
          scope.languages
            .filter((language) => /^[a-z]{2}$/i.test(language))
            .map((language) => language.toLowerCase()),
        ),
      ];
      if (languages.length) filters.push(`language:${languages.join("|")}`);
      const items: CollectedItem[] = [],
        limitations = [...COVERAGE],
        seen = new Set<string>();
      let requests = 0;
      try {
        for (const [queryIndex, query] of queries.entries()) {
          let cursor: string | null = "*";
          const cursors = new Set<string>();
          while (cursor) {
            if (ctx.signal.aborted) throw new ProviderError("cancelled", "Cancelled");
            if (
              requests >= limits.maxRequests ||
              ctx.http.requests >= limits.maxRequests ||
              items.length >= limits.maxResults
            ) {
              limitations.push(
                "OpenAlex collection truncated by request/result limit; more results may exist.",
              );
              return { items, status: "partial", limitations };
            }
            if (cursors.has(cursor)) throw new ProviderError("unsupported", "Repeated cursor");
            cursors.add(cursor);
            const url = new URL("https://api.openalex.org/works");
            url.searchParams.set("search", query);
            if (filters.length) url.searchParams.set("filter", filters.join(","));
            url.searchParams.set("cursor", cursor);
            url.searchParams.set(
              "per_page",
              String(Math.min(100, limits.maxResults - items.length)),
            );
            if (url.toString().length > 4000)
              throw new ProviderError("unsupported", "Search too long");
            requests++;
            const page = Page.parse(
              await ctx.http.json(url.toString(), { headers: headers(ctx), signal: ctx.signal }),
            );
            for (const work of page.results) {
              if (seen.has(work.id)) continue;
              if (items.length >= limits.maxResults) {
                limitations.push("OpenAlex collection truncated by result limit.");
                return { items, status: "partial", limitations };
              }
              seen.add(work.id);
              items.push(item(work));
            }
            cursor = page.meta.next_cursor ?? null;
            if (items.length >= limits.maxResults && (cursor || queryIndex < queries.length - 1)) {
              limitations.push(
                "OpenAlex collection truncated by result limit; more results may exist.",
              );
              return { items, status: "partial", limitations };
            }
          }
        }
        return { items, status: items.length ? "success" : "empty", limitations };
      } catch (error) {
        const report = failure(error, ctx);
        return {
          items,
          status:
            ctx.signal.aborted || (error instanceof ProviderError && error.code === "cancelled")
              ? "cancelled"
              : items.length
                ? "partial"
                : report.state === "invalid_credentials"
                  ? "missing_credentials"
                  : "error",
          limitations: [...limitations, report.message],
        };
      }
    },
    async test(ctx) {
      try {
        if (ctx.signal.aborted) throw new ProviderError("cancelled", "Cancelled");
        if (ctx.http.requests >= ctx.limits.maxRequests)
          throw new ProviderError("limit_reached", "Budget reached");
        Page.parse(
          await ctx.http.json(
            "https://api.openalex.org/works?search=mobility&per_page=1&select=id,title",
            { headers: headers(ctx), signal: ctx.signal },
          ),
        );
        return {
          state: "success",
          message: "OpenAlex metadata search available.",
          testedAt: ctx.now(),
          capabilities: ["publication_metadata", "abstracts", "cursor_pagination"],
          limitations: [...COVERAGE],
        };
      } catch (error) {
        return {
          ...failure(error, ctx),
          testedAt: ctx.now(),
          capabilities: [],
          limitations: [...COVERAGE],
        };
      }
    },
  };
}
