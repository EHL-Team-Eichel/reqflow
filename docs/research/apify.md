# Apify Instagram and TikTok adapter

## Interface and approval boundary

`packages/blocks/src/research/providers/apify.ts` exports:

```ts
export function createApifyAdapter(): ProviderAdapter;
```

The factory takes no credentials, actor IDs, actor input overrides, or network client.
`collect(request, ctx)` and `test(ctx)` use the shared adapter contract from
`packages/blocks/src/research/provider.ts`. Credentials come only from
`ctx.credentials.apify_api_token`. All HTTP calls use `ctx.http`; the renderer must
not instantiate this adapter.

Collection supports only `request.agentId === "instagram"` or `"tiktok"`. It
requires a valid core provider configuration with `enabled: true`,
`approval: "granted"`, and the **exact actor being run** in `allowedActors`.
Actor selection is hard-coded to the core `APIFY_ACTORS` list:

- `apify/instagram-scraper`
- `apify/instagram-comment-scraper`
- `clockworks/tiktok-scraper`
- `clockworks/tiktok-comments-scraper`

There is no arbitrary actor configuration or fallback actor. Post discovery
requires approval for the platform's post actor. The comment actor requires its
own allowlist entry; a post actor, valid token, public page, or successful previous
run does not imply permission for comments. If the comment actor is not approved,
post results are retained with `partial` status and a named limitation. Approving
only a comment actor does not enable discovery; that configuration is blocked.
Neither configuration nor token authentication establishes legal permission to
collect, store, redistribute, or use social content. The operator must check
platform terms, actor terms, privacy requirements, and intended usage rights.

## Official schemas verified

Checked on **2026-10-10** against official actor input/output pages and README
examples, independently of ReqFlow's existing research documentation. Only public
documentation was fetched. No actor was run and no real token was tested.

Instagram posts:

- [Input schema](https://apify.com/apify/instagram-scraper/input-schema)
- [Output schema](https://apify.com/apify/instagram-scraper/output-schema)
- [README and output examples](https://apify.com/apify/instagram-scraper)

Instagram comments:

- [Input schema](https://apify.com/apify/instagram-comment-scraper/input-schema)
- [Output schema](https://apify.com/apify/instagram-comment-scraper/output-schema)
- [README and nested-reply example](https://apify.com/apify/instagram-comment-scraper)

TikTok posts:

- [Input schema](https://apify.com/clockworks/tiktok-scraper/input-schema)
- [Output page](https://apify.com/clockworks/tiktok-scraper/output-schema)
- [README and output examples](https://apify.com/clockworks/tiktok-scraper)

TikTok comments:

- [Input schema](https://apify.com/clockworks/tiktok-comments-scraper/input-schema)
- [Output schema](https://apify.com/clockworks/tiktok-comments-scraper/output-schema)
- [README and output example](https://apify.com/clockworks/tiktok-comments-scraper)

The TikTok post output page did not expose usable row definitions in the retrieved
content. Its official README provides `id`, `text`, `textLanguage`, `createTime`,
`createTimeISO`, `isAd`, `isSponsored`, `webVideoUrl`, and
`videoMeta.subtitleLinks`. The adapter validates this documented shape; it does
not assume an undocumented generic social-media schema. The Instagram comment
README shows `replies` arrays, whereas its current output schema documents
`postUrl`, `commentUrl`, `id`, `text`, and `timestamp`. Both forms are supported.
The TikTok comment output schema explicitly documents `repliesToId` and
`createTime`, in addition to its README's `cid`, `videoWebUrl`, and
`createTimeISO`.

The published output schemas make many fields optional or nullable. Collection
still needs an original ID and supported source URL to create traceable records.
Instagram numeric IDs are accepted only when JavaScript can represent them
exactly; unsafe numeric IDs are rejected rather than silently rounded. Large IDs
must arrive as strings. Null/missing captions and comment text become empty-text
`metadata` records, never fabricated opinions. Error rows without usable evidence
are reported rather than converted into records.

Actors run their configured/default build. These public schemas can change;
offline tests are compatibility checks against documented examples, not proof
that a future build or every account tier returns the same fields.

## Supported access paths and gaps

When `scope.urls` is nonempty, those URLs take precedence. Unsupported URLs are
reported, not replaced with a keyword search. Supported HTTPS URLs have no user
credentials or nonstandard port and use the exact bare or `www` platform host.
Domain allow/block restrictions apply before actor launch and to returned records.

For Instagram:

- `/p/<shortcode>/` and `/reel/<shortcode>/` post URLs;
- public profile URLs, such as `https://www.instagram.com/example/`;
- `/explore/tags/<hashtag>/` URLs;
- without URLs, **literal `#hashtag` queries only**, using `search`,
  `searchType: "hashtag"`, `searchLimit: 1`, `resultsType: "posts"`, and
  `resultsLimit`.

Explicit reel URLs use the documented `resultsType: "reels"`; other supported
Instagram inputs use `"posts"`. Original `/reel/` context and `/p/` comment
permalinks are both retained when they identify the same original shortcode.

The actor documents hashtag/profile/place search, **not a general full-text post
search**. ReqFlow does not convert `BMW 5 Series comfort` into a guessed hashtag
or profile. A query-only request of that kind returns `blocked`, requiring
supported URLs or literal hashtags. Place search, stories, mentions, private
content, and login/session scraping are not implemented. The actor documents
limited free comments and additional paid access; approval does not prove the
subscription supports those features.

For TikTok:

- full `/@<handle>/video/<numeric-id>` URLs using `postURLs`;
- `/@<handle>` profile URLs, translated to the documented `profiles` usernames
  input, with `profileScrapeSections: ["videos"]` and `profileSorting: "latest"`;
- without URLs, documented `searchQueries` with `searchSection: "/video"` and
  `resultsPerPage`.

Short redirect links, profile follower/following scraping, related videos, paid
search/date filters, downloads, transcription, and AI video interpretation are
not enabled. The post actor receives `commentsPerPost: 0`; feedback comes from
the separately approved comments actor, not an automatically followed dataset
link or another actor.

Both platforms reuse **retrieved post URLs** as the comment actor input. One
comment run handles one retrieved post, so Instagram's documented comment rows
that omit a post URL can still be linked to that exact actor input. The adapter
retains post context even when a date filter excludes the caption, since an
independently dated comment on an older post can still satisfy the requested
range. Explicit publication dates are filtered locally; unknown dates remain
with a limitation when a date range was requested. Requested markets and
languages are not guaranteed search restrictions. No market is inferred from a
profile, proxy country, author name, or location of creation.

Replies are not requested as paid add-ons: Instagram uses
`includeNestedComments: false`; TikTok uses `maxRepliesPerComment: 0`. If a
documented Instagram nested reply is nevertheless supplied, its original text,
ID, date, and structural parent are retained within the result limit. TikTok
`repliesToId` is retained when present. Neither a mention in the text nor a reply
count establishes a parent ID. Complete comment/reply coverage is not promised.

## Raw record mapping

All records validate against core `CollectedItem`. Social records use the
existing `sourceKind: "other_web"`; no new core category is introduced.

- Post `caption` (Instagram) and `text` (TikTok) are separate `passage` records.
  Empty captions become `metadata`. Post captions are not labeled as customer
  feedback and are not merged with comments.
- Original comment `text` is a `feedback` record. Unicode, leading/trailing
  whitespace, emoji, and newlines are copied verbatim, with no sentiment or
  inferred ownership/vehicle classification.
- `recordId` preserves the original post ID, Instagram comment `id`, or TikTok
  comment `cid`. Original numeric Instagram values also remain in metadata.
  Deduplication distinguishes post IDs from comment IDs.
- Comment `sourceId`/`threadId` identify the retrieved post; `context` retains its
  original ID, URL, and caption. An explicit Instagram `commentUrl` is retained
  as `sourceUrl`; otherwise the post URL is used. Explicit post/permalink fields
  are retained in metadata. A contradictory post URL is reported as malformed,
  rather than assigned another post's context.
- Instagram top-level `parentId` is the input post; supplied nested replies use
  the containing comment's ID. `metadata.parentUrl` preserves the known parent
  post/permalink URL. TikTok reply `parentId` comes only from `repliesToId`; no
  parent permalink is invented when the actor does not supply one.
- Original `timestamp`/`createTimeISO` strings are preserved. Explicit Unix
  `createTime` is retained and can be represented as an ISO instant when the ISO
  field is absent. Missing dates never use collection time as publication time.
- TikTok `textLanguage` is copied as reported, including its unknown-language
  marker. Instagram's checked post/comment outputs do not establish a language
  field; the adapter does not detect one.
- Instagram `paidPartnership`, `affiliate`, and `sponsors`, plus TikTok `isAd` and
  `isSponsored`, are retained when supplied. Missing flags are not converted to
  `false`. TikTok `locationCreated` remains raw metadata, not market attribution.
- Existing TikTok `videoMeta.subtitleLinks` retain language, links, source,
  translation attribution, and version exactly as supplied. The documented
  examples supply subtitle **links**, not inline timed cue text. This adapter
  does not fetch those files, assert they are human-authored, invent timestamps,
  or claim to return a video transcript. `downloadSubtitlesOptions` is
  `NEVER_DOWNLOAD_SUBTITLES`; machine transcription and AI summary/description
  options are explicitly disabled. Instagram reel transcription is not supplied
  by a separate, unapproved reel actor.

Original captions/comments are the evidence. The adapter does not infer opinions
from images, alt text, music, video, popularity counts, or profile information.

## Run lifecycle, limits, and cost safety

The API was verified against the official API documentation:

- [Run Actor](https://docs.apify.com/api/v2/actors-runs-post)
- [Get run](https://docs.apify.com/api/v2/actor-run-get)
- [Get dataset items](https://docs.apify.com/api/v2/dataset-items-get)
- [Abort run](https://docs.apify.com/api/v2/actor-run-abort-post)
- [Authentication](https://docs.apify.com/api/v2#authentication)
- [Get private user data](https://docs.apify.com/api/v2/users-me-get)

Each actor starts asynchronously with
`POST /v2/actors/<owner>~<actor>/runs`, JSON input, and:

```text
maxTotalChargeUsd = ctx.limits.maxApifyChargeUsd
memory = 1024 MB
timeout = remaining collection time in whole seconds, minimum 1 second
waitForFinish = 0
restartOnError = false
maxItems = bounded raw dataset item allowance
```

Memory is fixed and bounded; a memory failure does not trigger automatic larger
runs. A collection deadline and `ctx.signal` bound client work. The timeout on
each remote run also bounds execution if the client loses connectivity. Polling
uses `GET /v2/actor-runs/<id>?waitForFinish=<1–5 seconds>` until `SUCCEEDED`,
`FAILED`, `TIMED-OUT`, or `ABORTED`. Transitional `TIMING-OUT` and `ABORTING` are
not treated as completion. Unknown status, changing run identity, and malformed
run/dataset responses are failures.

Completed runs, including failed/timed-out runs, can have useful partial
datasets. Those records are retained with a limitation. Dataset requests use
`GET /v2/datasets/<id>/items?format=json&clean=false&offset=<items>&limit=<items>`.
Pages contain at most 50 requested raw items. Offsets count **items**, not pages;
no `unwind`, `clean=true`, or empty/error filtering changes offset semantics.
Rows are validated individually, and successes survive malformed rows, later
page failures, and individual comment actor failures.

`maxResults` is a combined record limit, including captions, comments, nested
replies, and metadata. When comments are approved, discovery reserves up to
`ceil(maxResults / 2)` posts; remaining capacity is available to comments. The
adapter does not promise a representative or complete sample. Actor input
limits are per URL/query and `maxItems` is a **billing** limit, not an exact
output guarantee; the adapter separately bounds scanned rows and returned
records. Excess output is reported and not added.

**The Apify charge cap is per actor run, not a collection-wide dollar cap.** A
collection can launch post discovery plus multiple comment runs, each with the
specified `maxApifyChargeUsd`. Subscription charges, prior runs, reads, and other
account usage are not proved by this cap. A strict aggregate spending guarantee
requires a host-level budget policy; the current adapter contract does not
provide one. Immediate run costs are not reliable final accounting: the official
Get run documentation warns that final costs/event counts can remain preliminary
for roughly 10 seconds after completion. The adapter does not use preliminary
costs to authorize more actors or claim remaining funds.

Cancellation, timeout, or an interrupted known nonterminal run triggers a
best-effort `POST /v2/actor-runs/<id>/abort?gracefully=false`. Cleanup uses a
**fresh independent signal** bounded to five seconds, not the already-aborted
collection signal. It still uses `ctx.http`, so a denied/exhausted HTTP budget or
unreachable service can prevent abort. The HTTP host must honor the per-call
cleanup signal rather than forcibly reusing the cancelled collection signal.
An `ABORTING` response is not confirmation of final termination.

**Abort is not a refund.** Costs already incurred and work during cancellation
can still be billed. If abort fails or actor start succeeded but its response/run
ID was lost, the adapter cannot prove termination; costs may continue until the
remote timeout. It reports that limitation and does not silently claim cleanup.
The official graceful option can allow 30 more seconds, so it is not enabled.
Check the Apify console when termination was not confirmed.

Retries, timeouts, and common request budgets belong to `ctx.http`; this adapter
does not add retry loops. The HTTP host must not blindly replay a non-idempotent
actor-start POST after an ambiguous transport failure: duplicate runs may cost
money and no checked API contract establishes an actor-start idempotency key.
Ordinary adapter calls stop at the common request count; cleanup is still
attempted through that same service and may be rejected by its budget policy.

Authentication is always `Authorization: Bearer <token>`. No token is placed in
query parameters, actor input, metadata, logs, or returned error messages. Remote
error messages and run status messages are not echoed; failures name the actor
and safe error category instead.

## Connection test and offline proof

`test(ctx)` calls only `GET /v2/users/me`. It validates the account response and
reports token authentication, never actor permissions, account spending
capacity, subscription features, platform access, or usage rights. This check
does not run an actor or change the configuration/approval/allowlist.

`apify.test.ts` contains deterministic synthetic fixtures using official field
names. It covers approval/token gates, the exact actor allowlist, async polling,
terminal statuses, pagination, limits, captions versus comments, Unicode and
newlines, IDs and explicit dates, ad flags, subtitle-link provenance, reply
parents, null text, search limitations, domain restrictions, partial failures,
cancellation/timeout cleanup, secret-free URLs/errors, and the cheap connection
test. The mock HTTP queue cannot perform actual network requests.

```sh
npx vitest run packages/blocks/src/research/providers/apify.test.ts
npm run typecheck && npm test
```

No live actor acceptance run has been performed. Integration wiring, settings UI,
shared manifests/contracts, and aggregate cost policy are outside this file-only
slice.
