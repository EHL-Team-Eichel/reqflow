# Original web sources: Firecrawl and Tavily

## Integration contract

The factories return the final `ProviderAdapter` contract from
`packages/blocks/src/research/provider.ts`:

- `packages/blocks/src/research/providers/firecrawl.ts`: `createFirecrawlAdapter(): ProviderAdapter`
- `packages/blocks/src/research/providers/tavily.ts`: `createTavilyAdapter(): ProviderAdapter`

Both use only `ctx.credentials` and `ctx.http.json`. They do not read environment variables, use
global `fetch`, log secrets, or require a provider SDK. The caller owns provider selection,
configuration/approval gating, query construction, and persistence. The injected HTTP client owns
transport deadlines, retries, request accounting, and the shared budget. The adapters also stop
before sending a request when `ctx.http.requests` reaches `maxRequests`.

Firecrawl serves `owner_forums`, `editorial_reviews`, `competitor_models`, `market_studies`,
`regional_context`, `technology`, `bmw_sales`, and `bmw_strategy` through the same implementation.
It uses the supplied `request.queries`; it does not add sentiment-leading searches or substitute
agent-specific evidence categories. Scope domains, publication bounds, languages, and explicit URLs
are used where supported. Brand, vehicle, market, generation, and research questions belong to the
caller’s neutral query construction, not inferred attributes of collected pages. `EU` is not
silently translated to a particular country.

## Official documentation checked

Checked **2026-10-10**, using public documentation only. No requests were made with application
credentials, and no live connection or collection was run.

- Firecrawl v2 Search: <https://docs.firecrawl.dev/api-reference/endpoint/search>
- Firecrawl two-step search and cost guidance: <https://docs.firecrawl.dev/features/search>
- Firecrawl v2 Scrape: <https://docs.firecrawl.dev/api-reference/endpoint/scrape>
- Firecrawl Scrape OpenAPI, including the PDF parser fields:
  <https://docs.firecrawl.dev/api-reference/endpoint/scrape.md>
- Tavily Search: <https://docs.tavily.com/documentation/api-reference/endpoint/search>
- Tavily Extract:
  <https://docs.tavily.com/documentation/api-reference/endpoint/extract.md>

The Firecrawl reference is authoritative for the v2 `data.web` envelope. Some examples on its
feature page still show an older flat `data` array; this adapter deliberately rejects that shape.
No Firecrawl `research` category is requested, so its announced November 2026 response change does
not affect this adapter.

## Firecrawl collection

1. Scrape explicit `scope.urls` first, then search each supplied query with
   `POST https://api.firecrawl.dev/v2/search`. Search requests specify `sources: ["web"]`,
   `highlights: false`, `domainTools: false`, and no `scrapeOptions` or generated formats.
2. Read `data.web`, validate each source URL, and deduplicate URLs before a paid scrape. Limit each
   search to the remaining result budget, capped at the API maximum of 100. Ignore overlong provider
   hit arrays beyond the requested limit and report the truncation.
3. Read each eligible original through `POST https://api.firecrawl.dev/v2/scrape`, with
   `formats: ["markdown", "rawHtml"]`, `onlyMainContent: false`, `onlyCleanContent: false`, and
   `skipTlsVerification: false`. Keeping the entire page avoids dropping forum context or tables.
   The raw HTML, actual page metadata, and search discovery metadata remain available in the item.
   `maxAge` uses `cacheMaxAgeMs` (default 0); provider cache metadata is preserved when supplied.
4. Always send `parsers: [{ type: "pdf", maxPages: maxDocumentPages, pages: true }]`, including for
   URLs without a `.pdf` suffix. The live v2 API accepts a parser object with `maxPages` from 1 to
   10,000, not a top-level `pdfOptions`. ReqFlow’s contract limits the requested value to 500.
   Returned page markdown is retained in metadata. Responses exceeding the cap are rejected;
   `totalPages > numPages` makes the retained document explicitly partial.

One record contains the returned document markdown unchanged, including multilingual passages and
table markdown. No generated summary, structured AI extraction, or snippet is used as record text.
Missing original markdown is an error, even when search snippets or raw HTML exist.

## Tavily is an explicit alternative

`POST https://api.tavily.com/search` uses `search_depth: "basic"`, `topic: "general"`,
`auto_parameters: false`, `include_answer: false`, and `include_raw_content: "markdown"`.
Each search requests at most 20 results. Only nonempty `results[].raw_content` becomes evidence.
The `content` field is retained as search metadata, never substituted for a missing original.
Returned generated answers are ignored. Publication dates are requested but explicitly identified
as Tavily estimates that may describe an update rather than the original publication.

Explicit URLs use Tavily’s own `/extract`, one URL per request, with `extract_depth: "basic"` and
`format: "markdown"`. There is no `query` argument, so extraction does not request reranked chunks
instead of the full original. Both `results` and `failed_results` are checked, including HTTP-200
failures. A missing search original does **not** trigger an extraction purchase or Firecrawl call.

Tavily does not document a numeric PDF page cap. Known `.pdf` URLs and returned PDF content types
are excluded with a limitation; select Firecrawl explicitly for bounded PDF collection. PDFs behind
extensionless URLs cannot reliably be identified or page-bounded through Tavily’s documented
response. No automatic switch to Firecrawl is implemented, even if both credentials are present.

## Provenance, scope, and access limits

- Preserve the requested source URL, original text, supplied title/publisher/language/date, and
  actual metadata. A safe final redirect URL remains separately available as `metadata.finalUrl`.
  An absent title falls back to the source URL, not a fabricated document title.
- Records conservatively use `recordType: "passage"` and `sourceKind: "other_web"`. Agent names,
  search rank, requested vehicle, or domain names are not evidence types. An official product
  description must be explicit in the original source before downstream classification; choosing
  `competitor_models` does not make a page a product description. Search categories, when supplied
  by the provider, are retained only as discovery metadata.
- No market, vehicle, publication date, sentiment, score interpretation, or reliability is invented.
  Missing publication is `datePrecision: "unknown"`. Unknown or coarse dates within a requested
  date window are retained with a limitation, not assigned retrieval time. Known dates outside the
  window are excluded. Provider search date filtering alone does not prove source publication.
- Enforce allowed and blocked hostnames on discovered URLs, explicit URLs, and supplied
  `metadata.url`/`metadata.sourceURL`. Domain matching respects label boundaries and includes
  subdomains. Block rules take precedence. Firecrawl makes its include/exclude request fields
  mutually exclusive; the adapter sends include rules when both are configured and enforces both
  locally. Tavily supports both fields. Filters must be hostnames, not paths, wildcards, or URLs.
- Only public HTTP(S) hostname URLs without credentials or custom ports are accepted. Local names,
  reserved local suffixes, and all IP literals are rejected, including IPv6 and URL-normalized
  integer/hex IP forms. This is intentionally stricter than allowing public IP literals.
- Top-level API success is distinct from target access. Target `metadata.statusCode` must be 2xx
  when provided. Target errors, non-2xx bodies, recognizable access-denied/anti-bot documents, and
  empty originals are not evidence. Missing target status or final redirect URL makes a retained
  original partial, not an unqualified success. Requested but absent raw HTML is also a Firecrawl
  limitation for non-PDF pages.
- Tavily’s documented search/extract results do not promise target status or final redirect URL.
  Ordinary Tavily collection therefore reports those access limitations and is normally partial,
  even when useful original text is retained. Any such metadata actually returned is validated.
- URL checks cannot observe vendor-side DNS resolution or prevent DNS rebinding/hidden redirects
  before the vendor fetches a target. They reject detected unsafe targets before persistence. They
  are not a replacement for vendor network isolation. Challenge detection is conservative, not a
  guarantee that every soft-blocked page can be identified.
- Paywalls, logins, robots restrictions, anti-bot controls, missing forum pagination, hidden comments,
  OCR errors, and provider-cleaned content can limit access or completeness. Neither adapter claims
  to collect an entire discussion, crawl every linked page, authenticate to a source, or bypass
  access controls. A successful page read does not prove its claims or settle conflicting evidence.

Collections run sequentially, within result and request bounds. They pass `ctx.signal` on every
request and retain previously read originals after a later request failure, exhausted budget, or
cancellation. Affected runs are partial instead of losing all successful hits. Valid empty searches
are `empty`; malformed API envelopes are `error`; missing keys cause no requests.

## Connection tests and possible cost

Each `test(ctx)` sends only one deterministic query, `site:example.com Example Domain`, with one
result, no scrape, and no generated answer. Empty but valid search results still prove API access.
The test validates the protocol and reports missing/invalid credentials, permission failures, rate
limits, or unreachable APIs without echoing provider error bodies or keys.

These are **not free credential checks**. Firecrawl documents 2 credits per 1–10 search results,
rounded up; a one-result probe can cost 2 credits. Its regular HTML scrape costs 1 credit per page,
and PDF parsing costs 1 credit per parsed PDF page. Tavily documents 1 credit for a basic search and
1 credit per 5 successful basic URL extractions. Account rounding, retries, plan rules, and future
pricing changes can affect billing. Request/result/page limits are not an exact financial cap;
the injected HTTP budget and provider account limits must remain in force.

## Offline proof

```sh
npx vitest run packages/blocks/src/research/providers/firecrawl.test.ts packages/blocks/src/research/providers/tavily.test.ts
```

Tests inject deterministic HTTP responses. They cover multilingual originals and tables, unknown
publication, missing/invalid keys, target 403 and other failures, empty originals, snippets and
generated answers, malformed protocols, partial results, URL/domain/redirect policy, request and
result limits, PDF caps, explicit URLs, cancellation, and the small connection-test request shapes.
No test requires an API key or network access.
