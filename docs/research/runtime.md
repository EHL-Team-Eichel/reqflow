# Research collector runtime

`packages/blocks/src/research/runtime.ts` coordinates raw source collection. The
Research block in `index.ts` supplies a validated request and exposes its original
sources and records to the pipeline. Neither component creates findings,
requirements, source excerpts, reliability scores, or human decisions.

## Provider selection and access

The 13 agents and their provider mappings in `agents.ts` remain unchanged. Agents
run in selection order; duplicate selections run once.

The global web-provider selection is authoritative for every `firecrawl` mapping:

- `off` blocks both Firecrawl and Tavily, even if their API switches and credentials
  are configured.
- `firecrawl` selects only Firecrawl.
- `tavily` selects only Tavily, explicitly replacing the web mapping.
- `anthropic_web_search` is unsupported for collecting raw originals. The agent
  records a `blocked` result with that limitation, without substituting a vendor.

An unavailable, disabled, uncredentialed, or failing selected provider never causes
an automatic paid fallback. Social providers, OpenAlex, Eurostat, and authorized
local documents remain independent of the web-provider selection.

Before collection, the runtime checks the API switch, required usage approval,
credentials, installed adapter, source-domain policy, and remaining result and
request allowances. Reddit and Apify require granted approval. Apify also requires
permission for the exact application-owned post-discovery actor for the selected
platform. OpenAlex credentials are optional; other credential requirements are
listed in `PROVIDER_SECRETS`. Connection tests are never run implicitly.

## Domain policy

Global Settings restrictions cannot be cleared by advanced block JSON or by a
caller of the collector:

- Blocked domains are the union of global and scoped restrictions.
- An empty scoped allowlist inherits the global allowlist.
- Two nonempty allowlists are intersected by hostname containment. For example,
  `example.org` intersected with `news.example.org` permits only the latter.
- A disjoint intersection produces a clear error at the block boundary. A direct
  collector call instead saves blocked network-agent results; it never changes the
  intersection into unrestricted `[]`.

Hostnames are normalized to lowercase with trailing dots removed. HTTP(S) domain
URLs and leading `*.` notation normalize to hostnames. Matching requires an exact
hostname or a dot-delimited subdomain, not a substring or a lookalike suffix.
Malformed filters fail closed. Public sources must use HTTP(S) hostname URLs
without credentials, literal IP addresses, private/reserved hostnames, or custom
ports. These checks do not replace vendor-side protection against DNS rebinding.

Provider source domains are checked before social API calls and again for every
returned original:

- Reddit: `reddit.com`.
- YouTube: `youtube.com` and `youtu.be`.
- X: `x.com` and `twitter.com`.
- Apify: `instagram.com` or `tiktok.com`, according to the selected agent.
- OpenAlex work records: `openalex.org`.
- Eurostat source datasets: `ec.europa.eu`.

API endpoint hosts are not source-domain restrictions. For example, allowing
`youtube.com` does not prohibit the YouTube API endpoint on `www.googleapis.com`.
Endpoint security remains the responsibility of the common provider HTTP service.

BMW sales and strategy web collection additionally narrows access to
`bmwgroup.com` and `press.bmwgroup.com`. The narrowed scope is supplied to the
selected web adapter before searching or retrieving originals, so its public URL
and redirect checks enforce the same restriction. Returned originals are checked
again by the runtime. Authorized local `reqflow-file:` originals bypass public
network-domain filtering; their file identity is validated by the local adapter.

A returned original excluded by the provider or source-domain policy is reported
as a collection limitation and makes that collection partial, including when no
originals survive. Filtering is not silently reported as a legitimate empty search.

## Optional Mastra query planning

Planning is disabled by default. The collector accepts `queryPlanning?: boolean`
as a factory-level opt-in. A per-run collector context field, `planQueries?:
boolean`, takes precedence, including an explicit `false` override. The block
forwards `params.queryPlanning === true` through that context, not through the
strict `ResearchRequest` schema.

A real Mastra planner is constructed lazily only when:

1. Planning is explicitly enabled.
2. `settings.llm.provider` is `anthropic`.
3. An injected nonblank Anthropic API key and fast model are configured.
4. At least one query-based collection provider passes the access and domain gates.
5. Results can still be retained and the request allowance has room for both one
   planning call and at least one collection attempt.
6. The collection has not been cancelled.

Local document reads and explicit Eurostat dataset requests need no planner.
Explicit-URL Apify work and unsupported Instagram general-query discovery do not
trigger paid planning. Disabled, uncredentialed, unapproved, domain-blocked, or
result-budget-exhausted selections do not initialize the planner.

Without eligible planning, the existing deterministic neutral query builder is
used. Query planning receives search scope only, never previously collected source
text, file contents, or provider credentials. A planner failure is an explicit
error for query-based collection, not a silent deterministic fallback. Independent
local or non-query collection can still retain its originals.

## Budgets, records, and persistence

Each collection supplies the same mutable `{ used: number }` request budget to the
HTTP service and reserves a unit immediately before each model planning attempt.
`AgentCollectionResult.requests` is the agent's physical HTTP counter delta plus
its planner-attempt delta. Retries consume physical HTTP requests; cached original
reuse does not invent another physical request. Any separately bounded cleanup
requests exposed by the HTTP service are included in reported physical requests;
the HTTP service owns their cancellation and limit policy.

`maxResults` counts unique normalized record IDs across the run. A duplicate BMW
publication, repeated source URL, or repeated local record does not consume another
result slot. Duplicate originals can still add collecting-agent attribution.
Overfetched new unique records are excluded with a partial-result limitation.

Original records are validated individually. A malformed later record or a later
provider exception does not discard already accepted originals from that provider
outcome, earlier providers, or earlier agents. No text is generated to replace
missing originals.

After every selected agent, the collector saves the cumulative dataset, including
empty unsuccessful results and their detailed limitations. Cancellation and time
limits retain accepted originals and save cancelled results. Persistence failures
propagate instead of claiming an unsaved success. Logs redact injected credentials.
Progress reaches one even when the selection contained duplicate agent IDs.

The block rejects an empty agent selection instead of selecting every agent. After
the collector has persisted its dataset, an empty run whose results are all
blocked, uncredentialed, erroneous, partial, or cancelled throws an error containing
the per-agent statuses and limitations. The engine can then mark the block failed.
A legitimate empty search completes normally. A dataset with retained originals
remains usable, including partial collection or cancellation; result details remain
available in the saved dataset.

## Shared contract integration

The parent integration supplies:

- `ResearchCollector.collect` context: optional `planQueries?: boolean` in
  `packages/core/src/services.ts`.
- Research block parameter: boolean `queryPlanning`, default `false`, in
  `packages/core/src/blocks.ts`, including the parent-owned inspector toggle.

Neither field belongs in strict `ResearchRequest`: planning is an explicit execution
context option supplied by the block, defaulting off.

The HTTP integration supplies `createProviderHttp({ ..., budget: { used: 0 } })`;
the collector uses the same object for planner reservations. Tests cover the actual
shared HTTP implementation rather than a local counter-only substitute.

## Offline verification

All fixtures and credentials in tests are synthetic. No provider or model endpoint
is contacted.

```sh
npx vitest run packages/blocks/src/research/runtime.test.ts packages/blocks/src/research/index.test.ts
npm run typecheck && npm test
```
