import { z } from "zod";
import type { ProviderAdapter } from "../provider";
import { webProvider } from "./firecrawl";

const API = "https://api.tavily.com";
const SearchResult = z
  .object({
    url: z.string(),
    title: z.string().optional(),
    content: z.string().nullish(),
    raw_content: z.string().nullish(),
    published_date: z.string().nullish(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

function searchResults(response: Record<string, unknown>): unknown[] {
  webProvider.apiError(response);
  return z.object({ results: z.array(z.unknown()) }).parse(response).results;
}

/** Explicit alternative only. No Firecrawl calls, credentials, or automatic paid fallback. */
export function createTavilyAdapter(): ProviderAdapter {
  return {
    id: "tavily",
    collect: (request, ctx) =>
      webProvider.collect(request, ctx, "tavily_api_key", async (collection, key) => {
        for (const url of collection.request.scope.urls) {
          if (collection.stopped) break;
          if (!collection.candidate(url)) continue;
          if (/\.pdf$/i.test(new URL(url).pathname)) {
            collection.note(
              "partial",
              `${url}: Tavily PDF extraction has no document page cap; select Firecrawl explicitly for bounded PDFs.`,
            );
            continue;
          }
          try {
            const response = await collection.post(`${API}/extract`, key, {
              urls: [url],
              extract_depth: "basic",
              format: "markdown",
              include_images: false,
              include_usage: true,
            });
            webProvider.apiError(response);
            const parsed = z
              .object({ results: z.array(z.unknown()), failed_results: z.array(z.unknown()) })
              .parse(response);
            for (const failure of parsed.failed_results) {
              try {
                const failed = z.object({ url: z.string(), error: z.string() }).parse(failure);
                collection.note(
                  /403|401|forbidden|blocked|captcha/i.test(failed.error) ? "blocked" : "error",
                  `${url}: Tavily could not read the original URL.`,
                );
              } catch (error) {
                collection.failed(error);
              }
            }
            if (parsed.results.length === 0 && parsed.failed_results.length === 0) {
              collection.note("error", `${url}: Tavily returned no original extraction result.`);
            }
            for (const value of parsed.results) {
              try {
                const result = SearchResult.parse(value);
                try {
                  collection.checkUrl(result.url);
                } catch {
                  collection.note(
                    "blocked",
                    `${url}: Extracted URL violates the public-URL or domain policy.`,
                  );
                  continue;
                }
                collection.accept(
                  "tavily",
                  url,
                  result.raw_content,
                  result.metadata ?? {},
                  {
                    extractionUrl: result.url,
                    ...(response.request_id !== undefined
                      ? { requestId: response.request_id }
                      : {}),
                    ...(response.usage !== undefined ? { usage: response.usage } : {}),
                  },
                  result.title,
                );
                // A one-URL extraction cannot legitimately return unrelated multiple originals.
                if (parsed.results.length > 1)
                  collection.note(
                    "partial",
                    `${url}: Tavily returned extra extraction results; only the first was retained.`,
                  );
                break;
              } catch (error) {
                collection.failed(error);
              }
            }
          } catch (error) {
            collection.failed(error);
          }
        }
        for (const query of collection.request.queries) {
          if (!collection.hasRoom()) break;
          try {
            const scope = collection.request.scope;
            const limit = Math.min(20, collection.limits.maxResults - collection.items.length);
            const response = await collection.post(`${API}/search`, key, {
              query,
              search_depth: "basic",
              topic: "general",
              auto_parameters: false,
              max_results: limit,
              include_answer: false,
              include_raw_content: "markdown",
              include_images: false,
              include_published_date: true,
              include_usage: true,
              ...(collection.allowed.length ? { include_domains: collection.allowed } : {}),
              ...(collection.blocked.length ? { exclude_domains: collection.blocked } : {}),
              ...(scope.publishedFrom ? { start_date: scope.publishedFrom } : {}),
              ...(scope.publishedTo ? { end_date: scope.publishedTo } : {}),
              ...(scope.languages.length === 1 ? { language: scope.languages[0] } : {}),
            });
            const results = collection.boundedHits(searchResults(response), limit);
            for (const value of results) {
              if (collection.stopped) break;
              try {
                const result = SearchResult.parse(value);
                // A later caller-supplied query may contain an original absent from an earlier hit.
                // This reads the new response only; it does not buy an extraction fallback.
                if (!collection.candidate(result.url, true)) continue;
                const { raw_content, metadata, ...search } = result;
                collection.accept(
                  "tavily",
                  result.url,
                  raw_content,
                  metadata ?? {},
                  {
                    search,
                    ...(response.request_id !== undefined
                      ? { requestId: response.request_id }
                      : {}),
                    ...(response.usage !== undefined ? { usage: response.usage } : {}),
                  },
                  result.title,
                  webProvider.string(result.published_date),
                );
              } catch (error) {
                collection.failed(error);
              }
            }
          } catch (error) {
            collection.failed(error);
          }
        }
      }),
    test: (ctx) =>
      webProvider.test(
        ctx,
        "tavily_api_key",
        ["web_search", "original_markdown", "explicit_url_extraction"],
        async (collection, key) => {
          const results = searchResults(
            await collection.post(`${API}/search`, key, {
              query: webProvider.connectionQuery,
              search_depth: "basic",
              topic: "general",
              max_results: 1,
              include_answer: false,
              include_raw_content: false,
              include_images: false,
              auto_parameters: false,
            }),
          );
          z.array(z.object({ url: z.string() })).parse(results);
        },
      ),
  };
}
