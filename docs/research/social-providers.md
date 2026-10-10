# Official social provider adapters

## Scope and implementation plan

This slice owns only `youtube.ts`, `x.ts`, `reddit.ts`, their colocated tests in
`packages/blocks/src/research/providers/`, and this document. Shared contracts,
manifests, workstream status, user files, branches, and commits remain untouched.

1. Independently check official API documentation and the shared contracts.
2. Write offline contract and pagination tests using synthetic credentials.
3. Implement the three factories through the injected `ProviderContext` HTTP client.
4. Run focused tests, repository typecheck and tests; document limits and handoff.

No live credential tests or confidential data access are authorized for this slice.

## Exports and integration

- `packages/blocks/src/research/providers/youtube.ts`: `createYouTubeAdapter(): ProviderAdapter`
- `packages/blocks/src/research/providers/x.ts`: `createXAdapter(): ProviderAdapter`
- `packages/blocks/src/research/providers/reddit.ts`: `createRedditAdapter(): ProviderAdapter`

Factories take no keys and do not read environment variables. The main process
injects credentials, configuration, limits, clock, cancellation signal, and HTTP
client. All requests use `ctx.http.json` with explicit method, headers and signal.
Reddit's OAuth request additionally supplies a URL-encoded **string** body; the
shared HTTP client must transmit string bodies unchanged, not JSON-encode them.
The registry/main-process wiring is outside this slice's ownership.

Collection checks `config.enabled`. Connection tests intentionally work without
enabling collection, but Reddit's approval gate still applies. Boundary input and
provider response shapes are validated with Zod. Each output record is parsed
with the shared `CollectedItem` schema.

Only fixed HTTPS provider hosts receive requests. Reddit thread paths contain
validated ID36 identifiers, not provider-supplied permalinks. Queries are supplied
unchanged; the adapters do not add positive/negative, sentiment or ownership
filters. No scraping fallback, model call, source credibility score, sentiment,
inferred market, or inferred vehicle/ownership classification is added.

## YouTube Data API v3

Credential: `youtube_api_key`, transmitted in `X-Goog-Api-Key`, not in the URL.

1. `GET /youtube/v3/search`: `part=snippet`, `type=video`, supplied `q`, bounded
   `maxResults`, optional video publication dates, and `pageToken`.
2. `GET /youtube/v3/videos`: batch hydration with `part=snippet` and video IDs.
   The full author description is a separate `metadata` record. The video title,
   channel ID/name, publication time, default text language and default audio
   language remain metadata. Audio language is not treated as text language.
3. `GET /youtube/v3/commentThreads`: `part=snippet,replies`, `textFormat=plainText`,
   `videoId`, and paginated thread results. Top-level audience comments and
   embedded replies become independent `feedback` records.
4. If embedded distinct replies are fewer than `totalReplyCount`,
   `GET /youtube/v3/comments` with `parentId` follows **every** `nextPageToken`
   until completion or an injected limit/failure. Embedded and fetched comments
   are deduplicated by original comment ID. Embedded partial replies are never
   treated as the complete thread.

Source/video, record/comment, parent and thread IDs remain provider IDs.
Publication timestamps and available author metadata remain intact. Reply
context contains the top-level comment; top-level context identifies the video
description. Comment language is unknown: video language and query language do
not establish audience language. Publication search dates constrain videos, not
the dates of all comments on those videos; comment timestamps remain explicit.

`textOriginal` is used when returned. Official documentation says it is only
available to the comment's author. Most public responses instead contain
`textDisplay`: this is requested as plain text and retained exactly as returned,
with a per-record warning that it may differ from the author's original text.
No HTML stripping, translation or text reconstruction is performed.

**Transcripts are not available without supported authorized captions access.**
This adapter has only an API-key contract, not an authorized captions credential.
It does not call captions endpoints, reconstruct arbitrary transcripts, or
represent descriptions/comments as transcripts. Deleted/private videos, disabled
comments, moderated/deleted replies and search coverage can prevent complete
collection. Hydration gaps and short reply counts are reported as partial.

Connection test: one `videos.list(part=id, chart=mostPopular, maxResults=1)` request.
It consumes quota and does not prove permissions for every video's comments or
for subsequent searches.

## X API v2

Credential: `x_bearer_token`, transmitted as `Authorization: Bearer …`.

`config.xSearchMode` selects exactly one endpoint:

- `recent`: `GET https://api.x.com/2/tweets/search/recent`, last seven days only.
- `full_archive`: `GET https://api.x.com/2/tweets/search/all`, account access required.

The adapter requests `created_at`, `conversation_id`, `in_reply_to_user_id`,
`referenced_tweets`, `author_id`, `lang`, original `text` and `note_tweet`, plus
author/referenced-post expansions. Author identifiers and returned names,
handles and free-form location remain metadata. Location does not establish a
market. Reply parent IDs, conversation IDs, reference types, original timestamps
and provider language tags remain intact. Returned expanded parent text is
context; missing parent text is not fabricated or independently scraped.

`note_tweet.text` takes precedence for long posts. The short `text` field is also
retained in metadata. Some generated current references use `note_post`,
`referenced_posts` and `includes.posts`; returned aliases are accepted. Requests
use the `tweet.fields`/`referenced_tweets.id` names verified in the official recent
and archive quickstarts and data dictionary. The generated recent endpoint
reference currently differs in its Post naming; no speculative retry with a
different request contract is performed.

Pagination follows `meta.next_token`, retains supplied query/date parameters,
deduplicates post IDs, and stops at injected limits. The API minimum page size
is ten posts even when `limits.maxResults` is smaller; only the allowed number of
records is emitted. No tariff or currency cost is hardcoded. Bounded requests
**can bill**; request limits are not a guarantee of a particular monetary cost.

An explicit publication start older than the recent window, an end entirely
outside that window, or a future start returns `blocked` before HTTP. The
adapter does not silently move a historical start into the recent window.
Inclusive `publishedTo` days become exclusive next-day `end_time` values. An end
on the current/future day stops ten seconds before the injected clock and is
explicitly disclosed. Recent mode without explicit dates still reports its
seven-day limitation. Archive 403 returns `blocked`; it never falls back to
recent search. A later 403 preserves earlier records and returns `partial`.

Connection test: one minimum-size search (`query=BMW`, `max_results=10`) on the
**configured endpoint**. This may bill and does not test a different access mode.

## Reddit Data API

Collection and connection tests require `config.approval === "granted"` and all
three injected credentials: `reddit_client_id`, `reddit_client_secret` and
`reddit_refresh_token`. Missing refresh tokens never yield success. Approval
must represent permission for this specific use, not merely OAuth consent or an
app registration. Current Reddit policy distinguishes commercial data-use
permission and the Reddit For Researchers program; a local flag cannot acquire
permission or prove eligibility. Do not enable this adapter without the
applicable permission. No provider terms are accepted automatically.

Authentication uses documented OAuth refresh only:

- `POST https://www.reddit.com/api/v1/access_token`
- HTTP Basic client ID/secret; configured `redditUserAgent` on every request.
- `Content-Type: application/x-www-form-urlencoded`
- Body: `grant_type=refresh_token&refresh_token=…`
- Returned Bearer token must have `read` (or `*`) scope.

There are no user passwords, client-credentials substitution, unauthenticated
successes, or environment-derived secrets. Access tokens are held only within
the current call, not persisted or logged.

Search uses `GET https://oauth.reddit.com/search.json`, `q`, `type=link`, `sort=new`,
`t=all`, bounded `limit`, and listing `after`/`count` pagination. `raw_json=1`
avoids Reddit's legacy HTML entity substitutions. Original submission body (or
title when the body is empty), author, subreddit, IDs, permalink and UTC
timestamp are preserved. Arbitrary publication ranges are filtered locally;
the API's search coverage and date-filter limitations remain explicit.

Each selected thread uses `GET /comments/{ID36}.json`, `sort=new`, bounded `limit`
and `showmore=true`. Returned nested comments are walked as a tree. Original
comment bodies, fullname IDs, parent IDs, link/thread IDs, timestamps and
available parent/thread context are retained. Removed/deleted placeholders are
not treated as evidence. Reddit does not supply reliable per-comment language
or market in this API; both remain unknown.

**MoreComments expansion is not implemented.** Every encountered stub, including
nested stubs, marks the result `partial` and identifies the thread in limitations.
The supported future extension is serialized, bounded `/api/morechildren` calls
with at most 100 ID36 children per request. Comment-tree endpoints do not document
listing-style `after` pagination; unexpected comment/reply cursors also mark the
result partial rather than silently discarding the continuation. Submission
search pages do use `after` pagination. No claim of complete Reddit conversation
coverage is made.

Connection test: OAuth refresh plus one OAuth search with `limit=1`. It requires
`read`, not the unrelated `identity` scope used by `/api/v1/me`. Account-specific
fees and access restrictions may still apply.

## Failure, cancellation and bounds

`ctx.http` owns retries, provider budget enforcement, rate-limit handling and
timeouts. Adapters add no retries, sleeps, direct fetches or parallel unbounded
requests. They check cancellation and the shared request counter before every
request; `maxResults` bounds all emitted records, including video metadata.
Repeated pagination cursors stop collection instead of looping.

If a later page/request fails, prior records remain in `items` with `partial`.
Cancellation always returns `cancelled`, retaining prior records. Initial rejected
credentials return `missing_credentials`; initial permission denial returns
`blocked`; other initial failures return `error`. A reached collection bound is
explicitly partial, not a claim of complete collection. Malformed provider JSON
does not become synthetic evidence or an empty success.

Connection reports use core states: missing configuration `not_configured`, 401
`invalid_credentials`, 403 `permission_required`, 429 `rate_limited`, and transport
or malformed-response failures `unreachable`. Cancelled/limit-stopped tests use
`unreachable` with the precise stop code in a safe message, since core has no
cancelled connection state. Known `ProviderError` codes are preserved.

Only fixed messages and stop codes enter logs/reports. Raw exception messages,
provider error bodies, credentials and request headers are never logged.

## Official documentation independently checked

Checked 2026-10-10 by reading public official documentation, without provider
credentials. These are documentation checks, **not live API compatibility tests**.

### YouTube / Google

- https://developers.google.com/youtube/v3/docs/search/list
- https://developers.google.com/youtube/v3/docs/videos/list
- https://developers.google.com/youtube/v3/docs/videos
- https://developers.google.com/youtube/v3/docs/commentThreads/list
- https://developers.google.com/youtube/v3/docs/commentThreads
- https://developers.google.com/youtube/v3/docs/comments/list
- https://developers.google.com/youtube/v3/docs/comments
- https://developers.google.com/youtube/v3/docs/captions/download
- https://cloud.google.com/apis/docs/system-parameters

### X

- https://docs.x.com/x-api/posts/search/introduction
- https://docs.x.com/x-api/posts/search/quickstart/recent-search
- https://docs.x.com/x-api/posts/search/quickstart/full-archive-search
- https://docs.x.com/x-api/posts/search/integrate/paginate
- https://docs.x.com/x-api/posts/recent-search
- https://docs.x.com/x-api/fundamentals/data-dictionary
- https://docs.x.com/fundamentals/authentication/oauth-2-0/bearer-tokens

X pages were read using their corresponding `.md` representations.

### Reddit

- https://github.com/reddit-archive/reddit/wiki/OAuth2 (official archived OAuth
  guide; refresh flow, Basic authentication and OAuth API host)
- https://www.reddit.com/dev/api/ (current generated documentation: listings,
  `raw_json`, search, comment trees and `/api/morechildren`)
- https://support.reddithelp.com/hc/en-us/articles/14945211791892-Reddit-Data-API-Wiki
  (currently titled “Developer Platform & Accessing Reddit Data”, updated
  2026-05-28; separate data-use and research approval restrictions)

The separate `16160319875092` Data API Wiki URL returned HTTP 403 to the public
documentation fetch. It was not used as verified evidence.

## Offline verification and handoff

Verification snapshot, 2026-10-10:

- Focused `vitest run packages/blocks/src/research/providers/{youtube,x,reddit}.test.ts`:
  **3 files passed, 47 tests passed**. Coverage includes approval/missing
  credentials, original text and unknown attribution, search/thread/reply
  pagination, extended X text, archive refusal, 401/403/429, malformed responses,
  bounded requests/results, safe fixed hosts, cancellation and partial runs.
- Root `npm test -- --reporter=dot`: **24 files passed, 333 tests passed** at
  19:15:24 local time. Other agents were concurrently implementing unrelated slices.
- Root `npm run typecheck && npm test`: the typecheck gate failed before the
  chained tests could run. The final diagnostics were outside this ownership:
  `packages/core/src/research.ts:31` (`ResearchApiSettings` casts default-wrapped
  schemas to non-default schema types), and
  `apps/desktop/src/main/handlers.ts:54` (missing `exports.research` handler).
  No diagnostic named these three adapters or their tests. No shared file was
  changed to resolve these concurrent integration blockers.
- Prettier was applied only to these seven owned files; their formatting check
  and `git diff --check` passed.

The integration owner must register the three factories and preserve Reddit's
URL-encoded string body in the HTTP implementation. The integration owner must
also resolve the shared typecheck blockers and rerun repository gates. No branch
change, commit, live provider-key request, secret access or BMW-data access was
performed. `docs/STATUS.md` and existing untracked `* 2.*` user files were not
edited by this slice.
