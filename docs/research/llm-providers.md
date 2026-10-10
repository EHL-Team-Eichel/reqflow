# LLM provider transport

## Scope and implementation plan

This slice changes only `packages/llm/src` and this document. The core `LlmClient` contract,
main-process secret store, settings UI, manifests and repository history are outside its scope.

1. Preserve the injected-fetch Anthropic and deterministic mock clients and their upstream tests.
2. Add OpenAI Responses and Google Gemini REST requests, strict completion checks and provider-specific
   JSON Schema adapters. Keep the caller's original Zod schema authoritative.
3. Prove requests, response parsing, optional fields, schema limitations, cancellation and error
   redaction with synthetic offline tests. Run workspace typechecking and the root test suite.

No SDK, environment discovery, automatic retry, prompt-only structured-output fallback, construction-time
HTTP call or live-provider verification is part of this work.

## Official references

- [OpenAI Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Google generateContent](https://ai.google.dev/api/generate-content)
- [Google structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)

The provider model IDs come from settings, not an allowlist. Availability and schema limits remain
provider-dependent. The core defaults are OpenAI `gpt-4.1-2025-04-14` /
`gpt-4.1-mini-2025-04-14`, Google `gemini-3.8-flash` / `gemini-3.5-flash-lite`, and the unchanged
Anthropic `claude-opus-5-5` / `claude-haiku-5-5`.

## Requests and response validation

`createLlmClient(settings.llm, { apiKey, fetch })` accepts the key supplied by the main-process
secret store. `fetch` is optional and injectable for offline tests. Missing credentials fail at
construction; creating a configured client does not contact a provider. The transport uses the active
`model` or `fastModel`. Optional `modelProfiles` remain a settings concern; the transport does not
select, switch or persist profiles.

OpenAI uses `POST https://api.openai.com/v1/responses`, bearer authentication, `store: false`,
the prompt as `input`, optional `instructions`, and `max_output_tokens: 8192`. Structured requests
use `text.format` with `type: json_schema`, `name: reqflow_result` and `strict: true`.
The transport omits temperature for `gpt-5`, `gpt-6`, `o1`, `o3` and `o4` model families, including
their versioned/custom suffixes. Other free-text model IDs retain the configured temperature.
Only `output[].content` text from completed assistant messages is returned. Reasoning summaries
and the SDK-only top-level `output_text` are not answers. Refusals, errors, incomplete responses,
unexpected output types (including tool calls) and missing answer text fail explicitly.

Google uses `POST https://generativelanguage.googleapis.com/v1beta/models/<encoded-id>:generateContent`
with `x-goog-api-key`, never query-string credentials. An optional leading `models/` is removed;
the entire remaining custom model ID is encoded as one path segment. Requests contain user text
parts, optional `systemInstruction`, and `generationConfig` with one candidate, 8192 output tokens
and the configured temperature. Structured requests add `responseMimeType: application/json`
and `responseJsonSchema`. Responses require exactly one candidate, `finishReason: STOP` and
`modelVersion`, which is returned unchanged. Blocked prompts/candidates, non-STOP completion,
tool/media parts and missing answer text fail. Thought parts are excluded, including thought-only
parts without text.

## Schema semantics and limitations

The original caller-supplied Zod schema validates every returned object, including bounds,
formats, custom refinements and strict-object rules. No schema failure triggers a prompt-only
fallback or a second HTTP request. Unsupported schema conversion fails before HTTP.

OpenAI's adapter requires every declared property and sets `additionalProperties: false` on
every object. Originally optional nonnullable properties gain a null alternative on the wire.
Decoding removes null only at those declared optional positions. Required nulls, nullable properties,
null array elements and unknown properties are never blanket-stripped. Local references,
shared/recursive definitions, nested arrays and union branches retain this distinction. The untouched
value is validated first to preserve legitimate nullable values in ambiguous unions. Normalization
tries at most 128 candidate values with the original Zod schema; very ambiguous schemas can therefore
fail rather than consume unbounded validation work.

Non-object roots and root unions use a strict `{ result: ... }` envelope, which is validated and
removed before original-schema validation. References are rebased and definitions hoisted when
needed. Dynamic records, passthrough objects, tuples, intersections, external/unresolved references
and unrepresentable Zod schemas are unsupported by this OpenAI adapter.

Google keeps its supported JSON Schema bounds, references, arrays, unions and typed records.
It does not apply OpenAI's optional-null conversion. Unsupported scalar constraints become schema
descriptions but remain mandatory in original Zod validation. Both new adapters convert scalar
`const` to `enum`, adapt discriminated-union `oneOf` to `anyOf`, and reject unsupported structural
keywords rather than discard them. Unsupported intersections and unrepresentable Zod schemas fail
before HTTP. Existing Anthropic schema adaptation and mock protocols remain in place.

## Cancellation and errors

The existing cancellable transport races both fetch and response-body reading against the caller's
signal, including injected transports that ignore that signal. Abort listeners are removed on all
terminal paths. A late fetch response after cancellation is not read. There are no automatic retries.

HTTP failures include only the provider and status, without reading the error body. Transport,
response-shape, JSON and schema errors use fixed messages with no original error cause, response text,
refusal text, prompt, credentials or schema issue details. Caller-supplied cancellation reasons remain
unchanged to preserve the existing cancellation contract; callers must not put secrets in those reasons.

## Offline verification

Run:

```sh
npm run typecheck -w @reqflow/llm
npx vitest run packages/llm/src
npx prettier --check packages/llm/src/index.ts packages/llm/src/json-schema.ts packages/llm/src/openai-schema.ts packages/llm/src/google-schema.ts packages/llm/src/providers.test.ts packages/llm/src/schema.test.ts docs/research/llm-providers.md
npm run typecheck && npm test
```

`index.test.ts` retains the upstream Anthropic/mock regressions. `providers.test.ts` covers exact
offline requests, tier/custom-model selection, strict response parsing, local validation, error
redaction, aborts during fetch/body reading, late completion/rejection and listener cleanup.
`schema.test.ts` covers definitions, recursive references, envelopes, nullable distinctions,
union refinements, supported Google records and unsupported schema shapes.

No real provider credentials or live generation calls were used. Main-process credential wiring,
settings/UI integration, actual model availability and native-platform smoke checks are outside this
slice. The root gates currently encounter unrelated integration/dependency failures (including main
merge markers, `read-excel-file/node`, Mastra planner signatures and `LocalFileStore.resolvePath`).
Those files are outside this slice's ownership and were not changed.
