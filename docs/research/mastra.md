# Raw research experts and optional Mastra query planning

## Boundary

`packages/blocks/src/research/agents.ts` declares the 13 experts from the immutable
`@reqflow/core` contract. These definitions describe retrieval capabilities, not analytical roles.
`mastra.ts` creates real `Agent` instances from the installed `@mastra/core` **1.75.0**.
The agents plan search queries only. They do not collect sources, read documents, orchestrate a
workflow, interpret content, produce findings or make decisions.

The parent owns provider selection, approval, credentials, HTTP requests, collection, source
filters, raw record persistence and request accounting. No collected content is sent to these
agents. There are no tools, subagents, browser, workspace, skills, memory or storage. Original
source text must remain with the raw collection adapters; query normalization never touches it.

## All 13 definitions

| Expert ID           | Raw retrieval focus                                         | Required adapters              |
| ------------------- | ----------------------------------------------------------- | ------------------------------ |
| `reddit`            | Submissions, comments and thread context                    | `reddit`                       |
| `youtube`           | Video metadata, available transcripts and comments          | `youtube`                      |
| `instagram`         | Captions and comments from approved actors                  | `apify`                        |
| `tiktok`            | Video descriptions and comments from approved actors        | `apify`                        |
| `x`                 | Posts and conversation context within configured access     | `x`                            |
| `owner_forums`      | Owner discussions and replies                               | `firecrawl`                    |
| `editorial_reviews` | Road tests, review passages and published tables            | `firecrawl`                    |
| `competitor_models` | Configured model descriptions and equipment tables          | `firecrawl`                    |
| `market_studies`    | Customer studies, publications and research passages/tables | `firecrawl`, `openalex`        |
| `regional_context`  | Regional statistics and contextual publications             | `eurostat`, `firecrawl`        |
| `technology`        | Technology publications and published forecasts             | `firecrawl`, `openalex`        |
| `bmw_sales`         | Official BMW delivery tables and sales publications         | `firecrawl`, `local_documents` |
| `bmw_strategy`      | Official BMW strategy statements and document passages      | `firecrawl`, `local_documents` |

The definition list does not include Tavily. The parent may use Tavily only when the user has
explicitly selected and configured it as the search provider. A missing, disabled, unapproved,
rate-limited or failing adapter must not silently trigger Tavily or another paid fallback.
These factories do not select or invoke any source adapter.

## Public factories

```ts
export const RESEARCH_AGENTS: ResearchAgentDefinition[];

export function buildQueries(agentId: ResearchAgentId, scope: ResearchScope): string[];

export interface MastraResearchOptions {
  provider?: LiveLlmProvider; // "anthropic" | "openai" | "google"; default: "anthropic"
  apiKey: string;
  modelId: string;
}

export function createMastraResearchAgents(
  options: MastraResearchOptions,
): Record<ResearchAgentId, Agent>;

export function createMastraQueryPlanner(
  options: MastraResearchOptions,
): (agentId: ResearchAgentId, scope: ResearchScope, signal: AbortSignal) => Promise<string[]>;
```

`buildQueryRoot(scope)` is the shared deterministic anchor used by both modules. It is not a
collection API and never attributes a customer to a market.

Constructing either factory performs no model request. The model is configured with the object
`{ providerId: provider, modelId, apiKey }`, not a router string that looks up credentials.
Anthropic, OpenAI and Google Gemini use their actual selected providers; no provider is emulated.
Omitting `provider` preserves existing Anthropic callers. `mock` is not a Mastra provider here.
The injected key is required; the factory never reads environment variables or a secrets store.
The key is supplied only to the model transport, never to instructions, prompts, tools or logs.

Model IDs are trimmed and limited to 200 characters. Bare IDs and a matching
`anthropic/`, `openai/` or `google/` prefix are accepted. The selected provider prefix is removed
before configuring the model. Google also accepts `models/<id>` and `google/models/<id>`;
the native `models/` prefix is removed. The resulting ID starts with an ASCII letter or digit
and contains only ASCII letters, digits, `.`, `_`, `:`, and `-`. OpenAI fine-tune IDs such as
`ft:gpt-4.1-mini:synthetic:planner:abc` and custom aliases such as `custom-planner.v2` are accepted
without a model allowlist. Known Claude, GPT/chatGPT/o-series/fine-tune and Gemini families cannot
be routed to another provider. Foreign provider prefixes, URLs, residual paths, whitespace,
query strings, fragments, blank IDs and blank keys fail validation. Custom aliases do not prove
that the provider serves that model or that the model supports structured output.
The factory does not substitute a model, fake response or fallback provider.

The parent must call the planner **only after query planning is explicitly enabled for the selected provider**.
A `mock` LLM setting, missing key or disabled optional planning must use `buildQueries` directly,
not construct a fake Mastra model. Deterministic raw collection is a valid complete mode; it does
not need optional LLM calls. A planner failure propagates. Any user-authorized deterministic-only
rerun must be labelled separately by the parent, not silently presented as successful model planning.

## Deterministic search context

Every query retains brand, model, supplied current and previous generations, derivative,
propulsion, model year, all search markets and any publication date boundaries. Market terms
are labelled `market context`; they are not customer-country evidence. Date terms are search
context and do not establish that a returned source is inside the date range.

The first query is always a neutral expert query, not an exclusively complaint- or advantage-led
search. Up to two additional queries use the user's questions and keywords. With both supplied,
questions are combined into one additional query and keywords into another. Without keywords,
the first two questions are used separately. Duplicate queries are removed. All queries are
single-line, nonempty and at most 500 characters. User terms are whitespace-normalized, stripped
of double quotes/backticks and truncated to the available suffix budget. Required identity and
expert context are never truncated; oversized context fails clearly. These transformations apply
to search inputs only, never original source text or excerpts.

Competitor queries use the configured brand, model and generation identities. No competitor
names are invented. The BMW queries include `site:bmwgroup.com` and
`site:press.bmwgroup.com`. Market-study and technology queries include the explicit horizon in
years; they do not invent a current year or forecast findings.

Languages are **not search keywords**. The caller must pass the unchanged scope to adapters so
they apply supported API language filters. Dates, allowed/blocked domains, URLs, document IDs
and Eurostat dataset filters also remain adapter responsibilities. For example, OpenAlex can
use publication/language filters and Eurostat can select a dataset language; a search language
hint is not proof of an author's language or country. Unsupported filters must be reported as
collection limitations by the adapter. Neither query builder claims universal filter enforcement.

## Mastra execution and validation

The installed modern API is `agent.generate(messages, options)`. The implementation uses:

```ts
await agent.generate(prompt, {
  structuredOutput: {
    schema: z
      .object({
        queries: z.array(z.string().trim().min(1).max(500)).min(1).max(3),
      })
      .strict(),
    errorStrategy: "strict",
  },
  abortSignal: signal,
  maxSteps: 1,
  maxProcessorRetries: 0,
  savePerStep: false,
  toolChoice: "none",
  activeTools: [],
  modelSettings: {
    // Include temperature: 0 only when supported by the selected provider/model family.
    maxOutputTokens: 768,
    maxRetries: 0,
  },
  tracingOptions: { hideInput: true, hideOutput: true },
});
```

Anthropic, Google and non-reasoning OpenAI models receive `temperature: 0`. OpenAI o-series
and reasoning GPT-5+ families omit temperature at both the agent defaults and call options;
fine-tuned models use their base model family for this check. GPT chat variants retain zero
temperature. OpenAI search-preview models also omit temperature. The wrapper does not change
reasoning effort to enable sampling parameters. Unknown custom aliases receive zero temperature;
their capabilities cannot be inferred. A custom model with incompatible sampling settings fails
without retry or substitution. Reasoning tokens may consume the 768-token output allowance,
leaving insufficient room for a query plan; truncation is an explicit failure, not repaired output.

There is **no** `structuredOutput.model`: the official guide documents that this would add a
second structuring-agent call and additional latency/cost. Native structured output is used;
there is no JSON repair call. Compatibility depends on the explicitly configured model's
structured-output support. Unsupported models fail instead of switching providers or models.

The prompt is a whitelist containing the expert ID, deterministic scope root, neutral query,
language/date/horizon context and bounded user terms. It excludes source URLs, uploaded document
IDs, records, excerpts, tables, HTTP responses and all credentials. User input is explicitly
treated as untrusted search context. Prompt limits retain at most 10 language entries of 80
characters, 3 questions of 500 characters and 20 keywords of 100 characters. Root and neutral
query are each capped at 500 characters. Source documents have no prompt budget because they
are never accepted as model context.

An explicit `result.error` propagates. When Mastra exposes `finishReason`, only normalized `stop`
is accepted. Truncation, content filtering/refusal, tool calls, suspension, errors and unknown
completion reasons fail even if the result contains a valid-looking query object. Older response
shapes that omit `finishReason` remain compatible; their completion state cannot be checked
beyond the explicit error and strict object validation.

The returned `result.object` is explicitly parsed again with the original strict Zod schema.
Google's SDK removes string and array bounds from its transport schema, so those remote schema
constraints are not relied upon. Local parsing still enforces every count and length bound.
Missing
output, extra fields such as sentiment/evidence/recommendations, empty queries and excess
count/length fail. Conservative checks also reject quoted or multiline content and obvious
interpretations such as “owners are dissatisfied” or “BMW should improve charging”. These checks
are not a claim of perfect semantic neutrality. The first returned query is always the unchanged
deterministic neutral query, so model suggestions cannot create an exclusively biased plan.
Up to two distinct suggestions are retained. Each suggestion keeps the whole neutral query as
its deterministic prefix, retaining expert constraints (including competitor identities and BMW
domains) as well as the scope root. An existing full prefix or exact root is removed before adding
the suggestion suffix, so it is not duplicated. Every suggestion, including those beyond the
retained slots, is checked. Rooted model queries
that exceed 500 characters fail rather than being silently truncated.

An already aborted signal prevents `generate`. The same signal is passed to Mastra, and checked
again after generation so late output cannot escape cancellation. Provider errors and structured
output failures propagate without local retry or silent fallback. The parent supplies cancellation
and the overall timeout through its signal.

## Privacy, limits, cost and accounting

The agents are standalone: no `Mastra` runtime, telemetry exporter or persistent memory is
configured. The no-op logger suppresses model/input error logging. Tracing hides inputs and
outputs. The current official `generate` reference lists a `telemetry` option, but installed
1.75.0's modern `AgentExecutionOptionsBase` and `MastraModelSettings` do not expose that switch.
The implementation does not use an unsupported cast or claim that hidden spans disable an
external exporter. Do not attach these agents to a separate observable runtime or add memory
without reviewing the privacy boundary.

- One invocation calls one selected expert's `generate` once. Constructing all 13 agents costs
  zero model calls. Planning all 13 separately schedules up to 13 model requests.
- Both agent-level `maxRetries` and call-time `modelSettings.maxRetries` are zero. Processor retries
  are zero and `errorProcessorDefaults: false` disables Mastra's automatic stability processors.
  Thus a failure cannot trigger an unaccounted repair or provider retry in this layer.
- Each call permits one step and at most 768 output tokens. Input tokens are billed too. These are
  not dollar or total-token budgets; actual cost depends on the selected model, tokenization and
  provider pricing. A failed/cancelled request may still incur provider usage.
- Mastra's full result exposes `usage`, per-step usage and provider response metadata. The required
  planner contract returns only `string[]`, so this wrapper does **not** return/persist token usage,
  dollar cost or request IDs. No usage values are fabricated. Callers needing those fields must use
  the real-agent factory at an explicitly designed accounting seam or request a contract change.
- Direct Mastra requests do not pass through the parent collection HTTP adapter. Its `requests`
  counter therefore does not count model calls. The parent must reserve/count one planning request
  per invocation, including failed attempts, separately or against its overall `maxRequests` budget.
  Any parent retry is another counted, potentially paid request. Source-provider credits and Apify
  charge limits are unrelated to the selected LLM's query-planning charge.

## Verification

The tests use the real installed `Agent` constructor and model configuration. `generate`
is mocked and network access is stubbed to reject unexpected requests, so tests make no paid request.
The provider matrix covers all 13 experts with Anthropic, OpenAI and Google, normalized/custom
model IDs, mismatched providers, missing injected credentials, model-specific temperature,
unsuccessful completion and strict local query bounds. Existing tests retain neutral and
bounded queries, full vehicle/market/date context, configured competitors, BMW domains, language
filter separation, no analytical fields, direct credentials without environment fallback, no
tools/memory/runtime, strict output validation and cancellation before/during generation.
The collector tests additionally exercise all three providers with opt-in, Off/access gates,
shared HTTP/planner request budgets, retries, in-flight cancellation and retained partial originals.
These offline tests do not certify live model availability or endpoint compatibility.

```sh
npm test -- packages/blocks/src/research/agents.test.ts packages/blocks/src/research/mastra.test.ts
npm run typecheck && npm test
```

Official references checked on 2026-10-10, alongside the installed declaration files:

- [Agent.generate](https://mastra.ai/reference/agents/generate): modern call options, abort signal,
  output-token limits, one-step execution and full result/usage fields.
- [Structured output](https://mastra.ai/docs/agents/structured-output): strict validation, native
  schema output and the extra model call caused by a separate structuring model.
- Installed declarations: `dist/agent/agent.d.ts`, `dist/agent/agent.types.d.ts`,
  `dist/agent/types.d.ts`, `dist/llm/model/shared.types.d.ts` and
  `dist/llm/model/model-settings.d.ts` under `node_modules/@mastra/core`.
