import { isIP } from "node:net";
import { z } from "zod";
import {
  CollectedItem,
  ResearchAgentId,
  ResearchLimits,
  ResearchScope,
  type CollectionStatus,
  type ConnectionReport,
  type SecretName,
} from "@reqflow/core";
import {
  ProviderError,
  type CollectionOutcome,
  type CollectionRequest,
  type ProviderAdapter,
  type ProviderContext,
} from "../provider";

const API = "https://api.firecrawl.dev/v2";
const CONNECTION_QUERY = "site:example.com Example Domain";
const CollectionInput = z
  .object({
    agentId: ResearchAgentId,
    scope: ResearchScope,
    queries: z.array(z.string().trim().min(1).max(500)).max(1000),
  })
  .strict();
const ObjectValue = z.record(z.string(), z.unknown());
type ObjectValue = z.infer<typeof ObjectValue>;
type IssueStatus = "partial" | "blocked" | "error" | "cancelled";

function object(value: unknown): ObjectValue {
  return ObjectValue.parse(value);
}

function string(value: unknown): string | undefined {
  if (Array.isArray(value))
    return value.find((v): v is string => typeof v === "string" && v.trim().length > 0);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function credential(ctx: ProviderContext, name: SecretName): string {
  const key = ctx.credentials[name];
  if (!key?.trim()) throw new ProviderError("invalid_credentials", "API key is not configured.");
  // Reject header injection locally, without relying on the network implementation.
  if (!/^[\x21-\x7e]+$/.test(key) || key.length > 4096) {
    throw new ProviderError("invalid_credentials", "API key has invalid header characters.");
  }
  return key;
}

/** Read vendor errors, but never expose their body (it may echo credentials). */
function apiError(value: ObjectValue): void {
  const detail =
    typeof value.detail === "object" && value.detail !== null && !Array.isArray(value.detail)
      ? object(value.detail)
      : {};
  if (value.success !== false && value.error == null && value.detail == null) return;
  const error =
    `${string(value.code) ?? ""} ${string(value.error) ?? ""} ${string(detail.error) ?? ""}`.toLowerCase();
  if (/unauthori[sz]ed|invalid.*(?:key|token|credential)|missing.*api.?key/.test(error)) {
    throw new ProviderError("invalid_credentials", "Provider rejected the API credentials.");
  }
  if (/rate.?limit|excessive requests|too many requests/.test(error)) {
    throw new ProviderError("rate_limited", "Provider rate limit reached.");
  }
  if (
    /insufficient.?credits|payment required|usage limit|pay.as.you.go limit|plan.*limit/.test(error)
  ) {
    throw new ProviderError("limit_reached", "Provider credit or usage limit reached.");
  }
  if (/forbidden|permission|terms_required/.test(error)) {
    throw new ProviderError("permission_required", "Provider access requires permission.");
  }
  throw new ProviderError("unreachable", "Provider returned an API error.");
}

function publicUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // Hostnames only: all literal IPs (including URL-normalized integer/hex IPs) are excluded.
  // DNS resolution happens at the vendor; this cannot defend against DNS rebinding there.
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    isIP(host.replace(/^\[|\]$/g, "")) ||
    !host.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|localdomain|test|invalid|example|onion)$/.test(
      host,
    ) ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new Error(
      "Only public HTTP(S) hostname URLs without credentials or custom ports are supported.",
    );
  }
  return url;
}

function domains(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => {
        const trimmed = value.trim();
        if (!trimmed || /[/:?#@\s*]/.test(trimmed))
          throw new Error("Domain filters must be hostnames only.");
        return publicUrl(`https://${trimmed}`).hostname.toLowerCase().replace(/\.$/, "");
      }),
    ),
  ];
}

function urlKey(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

function precision(value: string | undefined): CollectedItem["datePrecision"] {
  if (!value) return "unknown";
  if (/^\d{4}$/.test(value)) return "year";
  if (/^\d{4}-\d{2}$/.test(value)) return "month";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))) return "day";
  if (/(?:T|\d{2}:\d{2})/.test(value) && Number.isFinite(Date.parse(value))) return "instant";
  return "unknown";
}

function blockedOriginal(text: string): boolean {
  // Reject recognizable challenge documents, not ordinary passages discussing access problems.
  return /^(?:#{1,6}\s*)?(?:access denied|(?:403\s+)?forbidden|just a moment\.{0,3}|checking your browser|verify (?:that )?you are human|attention required!?(?:\s*\|\s*cloudflare)?|you have been blocked)(?:[.!:]*\s*(?:\n|$))/i.test(
    text.trim(),
  );
}

class WebCollection {
  readonly items: CollectedItem[] = [];
  readonly limitations: string[] = [];
  readonly allowed: string[];
  readonly blocked: string[];
  readonly limits: ResearchLimits;
  private readonly issues: IssueStatus[] = [];
  private readonly seen = new Set<string>();
  stopped = false;

  constructor(
    readonly request: CollectionRequest,
    readonly ctx: ProviderContext,
  ) {
    this.limits = ResearchLimits.parse(ctx.limits);
    this.allowed = domains(request.scope.allowedDomains);
    this.blocked = domains(request.scope.blockedDomains);
  }

  note(status: IssueStatus, message: string): void {
    this.issues.push(status);
    if (!this.limitations.includes(message)) this.limitations.push(message);
  }

  checkUrl(value: string): void {
    const host = publicUrl(value).hostname.toLowerCase().replace(/\.$/, "");
    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);
    if (this.blocked.some(matches) || (this.allowed.length > 0 && !this.allowed.some(matches))) {
      throw new Error("URL excluded by the domain policy.");
    }
  }

  hasRoom(): boolean {
    if (this.stopped) return false;
    if (this.items.length < this.limits.maxResults) return true;
    this.note("partial", "Result limit reached; remaining sources or queries were not collected.");
    this.stopped = true;
    return false;
  }

  candidate(value: string, retryUnread = false): boolean {
    try {
      this.checkUrl(value);
    } catch {
      this.note("blocked", "A source URL was excluded by the public-URL or domain policy.");
      return false;
    }
    const key = urlKey(value);
    if (
      this.seen.has(key) &&
      (!retryUnread || this.items.some((item) => urlKey(item.sourceUrl) === key))
    )
      return false;
    if (!this.hasRoom()) return false;
    this.seen.add(key);
    return true;
  }

  async post(url: string, key: string, body: ObjectValue): Promise<ObjectValue> {
    if (this.ctx.signal.aborted) throw new ProviderError("cancelled", "Collection cancelled.");
    if (this.ctx.http.requests >= this.limits.maxRequests)
      throw new ProviderError("limit_reached", "Request limit reached.");
    // Retry, timeout, total budget, and request accounting belong to ProviderHttp.
    return object(
      await this.ctx.http.json(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: this.ctx.signal,
      }),
    );
  }

  failed(error: unknown): void {
    if (this.ctx.signal.aborted || (error instanceof ProviderError && error.code === "cancelled")) {
      this.note("cancelled", "Collection cancelled; previously read originals were retained.");
      this.stopped = true;
    } else if (error instanceof ProviderError) {
      const messages: Record<ProviderError["code"], string> = {
        invalid_credentials: "Provider rejected the API credentials.",
        permission_required: "Provider access is blocked or requires permission.",
        rate_limited: "Provider rate limit reached; remaining sources were not collected.",
        unreachable: "Provider request failed; no original was collected for that request.",
        unsupported: "Provider does not support this request.",
        limit_reached:
          "Request or provider usage limit reached; remaining sources were not collected.",
        cancelled: "Collection cancelled.",
      };
      this.note(
        error.code === "permission_required"
          ? "blocked"
          : error.code === "limit_reached"
            ? "partial"
            : "error",
        messages[error.code],
      );
      if (
        ["invalid_credentials", "permission_required", "rate_limited", "limit_reached"].includes(
          error.code,
        )
      )
        this.stopped = true;
    } else {
      this.note(
        "error",
        "Provider returned an invalid response or the request failed; no original was collected for that request.",
      );
    }
  }

  warning(value: unknown): void {
    if (string(value) || (Array.isArray(value) && value.length > 0)) {
      this.note("partial", "Provider reported a response warning; collection may be incomplete.");
    }
  }

  boundedHits(values: unknown[], limit: number): unknown[] {
    if (values.length > limit)
      this.note(
        "partial",
        "Provider returned more search hits than requested; extra hits were not collected.",
      );
    return values.slice(0, limit);
  }

  /** API success is not target success. Validate both target status and all returned redirect URLs. */
  accept(
    provider: "firecrawl" | "tavily",
    url: string,
    text: unknown,
    metadata: ObjectValue,
    extra: ObjectValue,
    title?: string,
    publishedAt?: string,
  ): void {
    const limitations: string[] = [];
    const limited = (message: string) => {
      limitations.push(message);
      this.note("partial", `${url}: ${message}`);
    };
    for (const key of ["url", "sourceURL"]) {
      if (metadata[key] !== undefined) {
        if (typeof metadata[key] !== "string") {
          this.note("error", `${url}: Invalid target URL metadata.`);
          return;
        }
        try {
          this.checkUrl(metadata[key]);
        } catch {
          this.note(
            "blocked",
            `${url}: Redirect or source metadata URL violates the public-URL or domain policy.`,
          );
          return;
        }
      }
    }
    if (metadata.statusCode !== undefined) {
      const status = metadata.statusCode;
      if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
        this.note("error", `${url}: Invalid target status metadata.`);
        return;
      }
      if (status < 200 || status >= 300) {
        this.note(
          [401, 403, 407, 429, 451].includes(status) ? "blocked" : "error",
          `${url}: Target returned HTTP ${status}; its body is not evidence.`,
        );
        return;
      }
    }
    if (metadata.error != null && metadata.error !== "") {
      this.note(
        "error",
        `${url}: Provider reported a target read error; its body is not evidence.`,
      );
      return;
    }
    if (typeof text !== "string" || !text.trim()) {
      this.note(
        "error",
        `${url}: No original page content was returned; search snippets and generated summaries are not evidence.`,
      );
      return;
    }
    if (blockedOriginal(text)) {
      this.note(
        "blocked",
        `${url}: Original content is an access-denied or anti-bot challenge, not source evidence.`,
      );
      return;
    }
    const isPdf =
      /\.pdf$/i.test(new URL(url).pathname) || /pdf/i.test(string(metadata.contentType) ?? "");
    if (provider === "tavily" && isPdf) {
      this.note(
        "partial",
        `${url}: Tavily PDF extraction has no document page cap; select Firecrawl explicitly for bounded PDFs.`,
      );
      return;
    }
    const pageCount = metadata.numPages;
    if (
      pageCount !== undefined &&
      (typeof pageCount !== "number" ||
        !Number.isInteger(pageCount) ||
        pageCount < 1 ||
        pageCount > this.limits.maxDocumentPages)
    ) {
      this.note("error", `${url}: Provider returned a document outside the requested page cap.`);
      return;
    }
    if (
      Array.isArray(extra.pages) &&
      (extra.pages.length > this.limits.maxDocumentPages ||
        extra.pages.some((page) => {
          const parsed = z
            .object({
              pageNumber: z.number().int().min(1).max(this.limits.maxDocumentPages),
              markdown: z.string(),
            })
            .safeParse(page);
          return !parsed.success;
        }))
    ) {
      this.note(
        "error",
        `${url}: Provider returned page content outside the requested page cap or invalid page metadata.`,
      );
      return;
    }
    if (
      typeof metadata.totalPages === "number" &&
      typeof pageCount === "number" &&
      metadata.totalPages > pageCount
    ) {
      limited(`PDF truncated: ${pageCount} of ${metadata.totalPages} pages parsed.`);
    } else if (isPdf && metadata.totalPages === undefined) {
      limited("PDF total page count was not provided; document completeness is unknown.");
    }
    if (metadata.statusCode === undefined)
      limited(
        "Target HTTP status was not provided; target access cannot be independently confirmed.",
      );
    if (metadata.url === undefined)
      limited(
        "Final redirect URL was not provided; redirect domain policy cannot be fully verified.",
      );
    if (provider === "firecrawl" && !isPdf && !string(extra.rawHtml))
      limited(
        "Requested original raw HTML was not returned; only provider-parsed markdown is available.",
      );

    const date =
      publishedAt ??
      string(metadata["article:published_time"]) ??
      string(metadata.publishedTime) ??
      string(metadata.datePublished) ??
      string(metadata.publishedAt);
    const datePrecision = precision(date);
    const scope = this.request.scope;
    if (scope.publishedFrom || scope.publishedTo) {
      if (date && ["day", "instant"].includes(datePrecision)) {
        const day = datePrecision === "day" ? date : new Date(date).toISOString().slice(0, 10);
        if (
          (scope.publishedFrom && day < scope.publishedFrom) ||
          (scope.publishedTo && day > scope.publishedTo)
        ) {
          this.note(
            "partial",
            `${url}: Provided publication date is outside the requested window; original excluded.`,
          );
          return;
        }
      } else
        limited(
          "Publication date is unknown or too imprecise to verify the requested date window.",
        );
    }
    if (provider === "tavily" && publishedAt)
      limited(
        "Tavily publication date is a provider estimate and may describe an update, not the original publication.",
      );
    this.items.push(
      CollectedItem.parse({
        provider,
        sourceId: url,
        sourceUrl: url,
        sourceTitle: string(metadata.title) ?? string(title) ?? url,
        sourceKind: "other_web",
        recordId: `document:${url}`,
        recordType: "passage",
        text,
        ...(string(metadata.publisher) ? { publisher: string(metadata.publisher) } : {}),
        ...(string(metadata.language) ? { language: string(metadata.language) } : {}),
        ...(date ? { publishedAt: date } : {}),
        datePrecision,
        metadata: {
          ...metadata,
          ...extra,
          ...(typeof metadata.url === "string" ? { finalUrl: metadata.url } : {}),
        },
        limitations,
      }),
    );
  }

  outcome(): CollectionOutcome {
    const status: CollectionStatus =
      this.issues.length === 0
        ? this.items.length
          ? "success"
          : "empty"
        : this.items.length
          ? "partial"
          : this.issues.includes("cancelled")
            ? "cancelled"
            : this.issues.includes("error")
              ? "error"
              : this.issues.includes("blocked")
                ? "blocked"
                : "partial";
    return { items: this.items, status, limitations: this.limitations };
  }
}

async function collect(
  request: CollectionRequest,
  ctx: ProviderContext,
  secret: SecretName,
  work: (collection: WebCollection, key: string) => Promise<void>,
): Promise<CollectionOutcome> {
  if (ctx.signal.aborted)
    return { items: [], status: "cancelled", limitations: ["Collection cancelled."] };
  if (!ctx.credentials[secret]?.trim())
    return {
      items: [],
      status: "missing_credentials",
      limitations: ["API key is not configured."],
    };
  let collection: WebCollection;
  let key: string;
  try {
    key = credential(ctx, secret);
    collection = new WebCollection(CollectionInput.parse(request), ctx);
  } catch {
    return {
      items: [],
      status: "error",
      limitations: [
        "Invalid API key, collection input, limits, or domain filters; no requests were sent.",
      ],
    };
  }
  try {
    await work(collection, key);
  } catch (error) {
    collection.failed(error);
  }
  return collection.outcome();
}

async function test(
  ctx: ProviderContext,
  secret: SecretName,
  capabilities: string[],
  run: (collection: WebCollection, key: string) => Promise<void>,
): Promise<ConnectionReport> {
  if (!ctx.credentials[secret]?.trim())
    return {
      state: "not_configured",
      message: "API key is not configured.",
      capabilities: [],
      limitations: [],
    };
  const limitations = [
    "This connection test uses a billable one-result search. It checks API access, not access to any original target page.",
  ];
  try {
    const key = credential(ctx, secret);
    const collection = new WebCollection(
      { agentId: "editorial_reviews", scope: ResearchScope.parse({}), queries: [] },
      ctx,
    );
    await run(collection, key);
    return {
      state: "success",
      message: "Search API access confirmed.",
      testedAt: ctx.now(),
      capabilities,
      limitations,
    };
  } catch (error) {
    const states: Partial<Record<ProviderError["code"], ConnectionReport["state"]>> = {
      invalid_credentials: "invalid_credentials",
      permission_required: "permission_required",
      rate_limited: "rate_limited",
      unsupported: "unsupported",
    };
    const state =
      error instanceof ProviderError ? (states[error.code] ?? "unreachable") : "unreachable";
    return {
      state,
      message: `Search connection test failed (${state}).`,
      testedAt: ctx.now(),
      capabilities: [],
      limitations,
    };
  }
}

// Shared by the alternative adapter in this directory. No network fallback is shared or invoked.
export const webProvider = {
  collect,
  test,
  object,
  string,
  apiError,
  connectionQuery: CONNECTION_QUERY,
};

function searchResults(response: ObjectValue): unknown[] {
  apiError(response);
  return z
    .object({ success: z.literal(true), data: z.object({ web: z.array(z.unknown()) }) })
    .parse(response).data.web;
}

function searchBody(collection: WebCollection, query: string, limit: number): ObjectValue {
  const scope = collection.request.scope;
  const date = (value: string) => {
    const [year, month, day] = value.split("-");
    return `${month}/${day}/${year}`;
  };
  return {
    query,
    limit,
    sources: ["web"],
    highlights: false,
    domainTools: false,
    // The API makes includeDomains/excludeDomains mutually exclusive; enforce both locally.
    ...(collection.allowed.length
      ? { includeDomains: collection.allowed }
      : collection.blocked.length
        ? { excludeDomains: collection.blocked }
        : {}),
    ...(scope.publishedFrom || scope.publishedTo
      ? {
          tbs: `cdr:1${scope.publishedFrom ? `,cd_min:${date(scope.publishedFrom)}` : ""}${scope.publishedTo ? `,cd_max:${date(scope.publishedTo)}` : ""}`,
        }
      : {}),
  };
}

/** One adapter for all web research agents. Agent IDs never determine content classifications. */
export function createFirecrawlAdapter(): ProviderAdapter {
  return {
    id: "firecrawl",
    collect: (request, ctx) =>
      collect(request, ctx, "firecrawl_api_key", async (collection, key) => {
        const scrape = async (url: string, search?: ObjectValue) => {
          if (!collection.candidate(url)) return;
          try {
            const response = await collection.post(`${API}/scrape`, key, {
              url,
              formats: ["markdown", "rawHtml"],
              onlyMainContent: false,
              onlyCleanContent: false,
              skipTlsVerification: false,
              maxAge: collection.limits.cacheMaxAgeMs,
              parsers: [{ type: "pdf", maxPages: collection.limits.maxDocumentPages, pages: true }],
              ...(collection.request.scope.languages.length
                ? { location: { languages: collection.request.scope.languages } }
                : {}),
            });
            apiError(response);
            const data = z
              .object({ success: z.literal(true), data: ObjectValue })
              .parse(response).data;
            const metadata = data.metadata === undefined ? {} : object(data.metadata);
            collection.warning(response.warning);
            collection.warning(data.warning);
            collection.accept(
              "firecrawl",
              url,
              data.markdown,
              metadata,
              {
                ...(typeof data.rawHtml === "string" ? { rawHtml: data.rawHtml } : {}),
                ...(data.pages !== undefined && data.pages !== null ? { pages: data.pages } : {}),
                ...(search ? { search } : {}),
              },
              string(search?.title),
            );
          } catch (error) {
            collection.failed(error);
          }
        };
        for (const url of collection.request.scope.urls) {
          if (collection.stopped) break;
          await scrape(url);
        }
        for (const query of collection.request.queries) {
          if (!collection.hasRoom()) break;
          try {
            const limit = Math.min(100, collection.limits.maxResults - collection.items.length);
            const response = await collection.post(
              `${API}/search`,
              key,
              searchBody(collection, query, limit),
            );
            const results = collection.boundedHits(searchResults(response), limit);
            collection.warning(response.warning);
            collection.warning(response.warnings);
            for (const value of results) {
              if (collection.stopped) break;
              try {
                const hit = z
                  .object({
                    url: z.string(),
                    title: z.string().optional(),
                    description: z.string().optional(),
                    category: z.string().optional(),
                    position: z.number().optional(),
                  })
                  .parse(value);
                await scrape(hit.url, hit);
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
      test(
        ctx,
        "firecrawl_api_key",
        ["web_search", "original_markdown", "bounded_public_pdf"],
        async (collection, key) => {
          const results = searchResults(
            await collection.post(
              `${API}/search`,
              key,
              searchBody(collection, CONNECTION_QUERY, 1),
            ),
          );
          z.array(z.object({ url: z.string() })).parse(results);
        },
      ),
  };
}
