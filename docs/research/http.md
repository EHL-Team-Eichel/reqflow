# Shared research HTTP service

`packages/blocks/src/research/http.ts` is the main-process transport boundary for
research adapters. Tests inject a synthetic `fetchImpl`; they never use live
providers, API credentials, or confidential data.

## Contract and request accounting

```ts
export interface RequestBudget {
  used: number;
}

export interface ProviderHttpOptions {
  limits: ResearchLimits;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  budget?: RequestBudget;
}

export interface ProviderHttpClient extends ProviderHttp {
  readonly cleanupRequests: number;
}

export function createProviderHttp(options: ProviderHttpOptions): ProviderHttpClient;
```

For a run that also uses query planning, create one `const budget = { used: 0 }`
and pass that exact object to `createProviderHttp`. Before each external planner
call, check `budget.used < limits.maxRequests` and increment `budget.used`
synchronously, with no intervening `await`. Every ordinary HTTP attempt performs
the same check and reservation. Retries and failed attempts consume the budget.
Separate HTTP clients can share this object, although their concurrency and
provider-credit limits remain local to each client. Prefer one HTTP client per
run for a shared concurrency and credit limit.

`http.requests` counts **HTTP attempts only**, including actor cleanup. It never
counts planner calls, cache hits, queued requests cancelled before dispatch, or
requests rejected before dispatch. `http.cleanupRequests` is the cleanup subset.
The shared `budget.used` includes planner and ordinary HTTP attempts but excludes
the explicitly reserved cleanup allowance. Consequently, `http.requests` can
exceed `limits.maxRequests` by at most four reserved cleanup attempts. Report
cleanup as an additional allowance rather than claiming that `maxRequests` is
an absolute limit on all network traffic. A total external-attempt report can
use `budget.used + http.cleanupRequests`; a transport-only report uses
`http.requests`.

## Endpoint and failure policy

Only HTTPS requests to the explicit provider hosts are accepted: Firecrawl,
Tavily, Google/YouTube, Apify, X/Twitter, Reddit, OpenAlex, and the Eurostat host.
URL credentials, explicit ports (including `:443`), alternate hosts, IP literals,
and malformed URLs are rejected before transport. Fetch uses `redirect: "error"`
and never follows a provider redirect to another endpoint.

Authentication headers are redacted before generic key/value fields, so
`Authorization: Bearer ...` and `Authorization: Basic ...` cannot leave the token
behind. Explicit secret values are also removed in raw, percent-encoded, and
form-encoded representations. Percent escape casing does not affect redaction;
the case of literal secret characters remains significant.

Network exceptions, response-stream exceptions, malformed JSON, and body cleanup
exceptions never retain transport messages or response content. HTTP failures
retain only the status and a fixed `ProviderError` message. Responses are limited
to 16 MiB, both by declared content length and by actual streamed bytes. Unicode
is decoded after byte collection, preserving characters split across chunks.

## Concurrency, cancellation, and retries

One FIFO semaphore holds each slot through response-body consumption. Release
transfers the occupied slot directly to the next waiter, so new callers cannot
steal a queued caller's slot or increase the configured upper bound. A queued
request listens to its own combined run/request signal; cancellation removes it
from the queue immediately without consuming a transport attempt or leaking a
slot.

Fetch and stream reads race their signal even if the injected transport ignores
cancellation. Body cancellation is best-effort and is not awaited: an
uncooperative stream cleanup must not keep the caller pending. This guarantees
local settlement, not physical termination of a noncooperative transport or
remote work. Retry timers and abort listeners are removed on both completion and
cancellation.

Only GET requests retry transport failures, HTTP 429, or HTTP 5xx responses.
Retries use bounded exponential backoff or a finite `Retry-After` of at most
30 seconds. Authentication/permission failures never retry. POST and DELETE
requests never retry; no paid-operation idempotency guarantee is assumed.

## Conservative credit reservations

Reservations happen before transport and are not refunded for failed purchases.
For the operations used by the current adapters:

- Firecrawl search reserves `2 * ceil(limit / 10)` credits. Limits of 11, 50,
  and 100 therefore reserve 4, 10, and 20 credits. An omitted limit reserves two
  credits; malformed result counts are rejected. Serialized JSON bodies follow
  the same calculation.
- Firecrawl scrape reserves `limits.maxDocumentPages` credits even for a page
  that ultimately costs less. The adapter sends that maximum in its PDF parser
  options. Search does not purchase inline scraping; document collection uses
  separately budgeted scrape requests.
- Tavily search reserves two credits conservatively, including basic search.
  Extraction reserves at least two credits and otherwise two per started batch
  of five URLs: 1–5 URLs reserve two, 6–10 reserve four, and 11 reserve six.
- Other supported transport operations do not consume this cross-provider credit
  counter. Provider-specific quotas and Apify monetary limits remain separate.

These are conservative reservations for the current adapter requests, not an
invoice prediction or a guarantee about future vendor add-ons. The Apify adapter
still supplies its existing per-actor-run charge limit. This HTTP change does not
aggregate actor charges or alter actor inputs.

## Original-document reuse

Only Firecrawl `/v1/scrape` and `/v2/scrape` POST requests are reused, within one
HTTP client/run. Keys are SHA-256 digests of URL, method, body, and normalized
headers. The cache does not store those inputs or plaintext credentials as keys.
Different authentication or page/body parameters do not share an entry. Failed
transport promises and malformed JSON are evicted. Paid search POSTs are not
deduplicated. A new run has a fresh cache and can observe document revisions.

## Independent Apify cleanup allowance

Cancelling collection or exhausting its ordinary request budget must not prevent
an attempt to stop a known paid actor run. The service grants reserved cleanup
only when all of these conditions hold:

1. A successful POST to the exact `/v2/actors/{actor}/runs` endpoint for one of
   `APIFY_ACTORS` returned a safe run ID. The rest of that response need not be
   valid for the adapter; retaining a valid identity still permits cleanup.
2. Cleanup is a POST to `https://api.apify.com/v2/actor-runs/{sameRunId}/abort`,
   without a body or fragment. The ID contains only ASCII letters, digits,
   underscores, or hyphens and is at most 128 characters. Optional query
   parameters may only be `gracefully=true` or `gracefully=false`.
3. The authorization header matches the start request. Only its SHA-256 digest
   is retained with the run identity.
4. That run has not reserved cleanup before, and fewer than four cleanup attempts
   have been reserved by this client. Cleanup never retries.

Cleanup uses an independent five-second deadline, rather than the cancelled run
signal. A caller-supplied cleanup signal can shorten that deadline. It still uses
the same FIFO semaphore, response bounds, endpoint policy, error sanitation, and
request accounting. It can therefore expire while waiting for a slot; no
unbounded dedicated queue or concurrency bypass exists.

Unknown run IDs, mismatched credentials, other endpoints, actor launches, polling,
and dataset reads never receive this exception. An unconfirmed start with no
known ID cannot be aborted. An abort request or timeout does not prove remote
termination or refund charges; the adapter records that uncertainty.

## Offline verification

```sh
npx vitest run packages/blocks/src/research/http.test.ts
npm run typecheck -w @reqflow/blocks
```

The HTTP suite includes the real Apify adapter over a fake transport. One test
cancels an outstanding poll after exhausting the ordinary two-request allowance
and verifies that an independent abort is actually dispatched, counted, and
confirmed by the synthetic response.
