# Raw research in ReqFlow

Implementation snapshot: **2026-10-10**. ReqFlow is a **native Electron desktop app**, not a hosted
research service. Use a Research block to collect provider-returned originals and authorized local
documents, inspect access/completeness limitations, and export the raw dataset. Collection does not
create findings, sentiment, reliability scores, priorities, requirements, or human decisions.

The adapters are real implementations, not canned research results. Offline tests inject synthetic
responses; they do not establish live access or production readiness. See
[verification](verification.md) for the evidence and the parent-owned final gates.

## Start with a Research-only workflow

1. Open ReqFlow and go to **Settings → AI & research → Web research → Provider**. Select
   **Firecrawl (recommended)** for original web collection, **Tavily (alternative)** deliberately,
   or **Off (no web search)** for local-only work. Wait for settings to save before running.
2. Open **Settings → Research APIs & Zugänge**. Save the selected provider's credential in its
   masked input, then turn on its **Enabled** switch. Saving a credential does not enable a
   provider, grant approval, test it, or start collection. Configure other providers separately
   using the access table below.
3. Optionally choose **Test connection**. This is an explicit, potentially quota-consuming or
   paid probe, not a research run. Read the returned capabilities and limitations; a successful
   probe does not prove source access, platform permission, or complete collection.
4. Go to **Data Flow** and click or drag **Research** from **Building Blocks** onto the root
   workplace. For the first run, use only Research blocks: unrelated Raw/AI/HIL/Add to Car
   implementations and requirement handlers are separate workstreams and may fail with
   `not_implemented`. No downstream connection is required to collect or export.
5. Select the block. Set **Research question**, **Market**, **Research agents**, and the result,
   request, document-page, time, and concurrency limits. Select at least one agent. The current
   collector uses **Research agents**; the older **Look at** categories do not select agents.
   Leave **Mastra query planning (paid Anthropic request)** off for deterministic query building.
6. Optionally enter **Advanced research scope (JSON)** or use **Local original document** to
   open the native file picker. Keep the Research inner workplace untouched to use the builtin
   collector. Adding inner blocks or even a boundary-to-boundary edge overrides that builtin.
7. Click **Run workflow**. The controls save the **whole root graph** and its scope before
   starting. Expand **Last run** for block states and logs; **Inspect output** shows a preview
   limited to 20,000 characters, not the complete dataset.
8. Read the research summary's per-agent states, record/request counts, and limitations. Once the
   run completes, fails, or is cancelled, choose **Export JSON**, **Export XLSX**, or **Export CSV**
   and a destination in the native save dialog. Cancelling that dialog writes no export.

**Off blocks both Firecrawl and Tavily**, even with saved keys and enabled switches. YouTube,
Apify, X, Reddit, OpenAlex, Eurostat, and local documents are independently controlled. There is
no automatic vendor fallback. An old `anthropic_web_search` setting is readable but unsupported
for raw originals; explicitly select Firecrawl, Tavily, or Off instead.

For an offline first collection, leave web search Off, leave local documents enabled, select
`bmw_sales` and/or `bmw_strategy`, and import an authorized synthetic UTF-8 TXT or XLSX. These are
the two agents with a local-document adapter. Their web branch can be blocked while local originals
remain available, so read `partial` limitations rather than treating the whole agent as inaccessible.
The editor and latest-run identity survive tab navigation in the current session; the editor does
not restore its graph automatically after an app restart. Main persists saved workflows, run
snapshots, datasets, and outputs; interrupted active runs become failed, not silently restarted.

## Provider access, permission, and cost

Enable only access you are authorized to use. An app switch is not permission from a platform,
actor publisher, source owner, or data subject. Check current account entitlements, quotas, terms,
and usage rights before testing or collecting. No fixed subscription prices are promised here.

| Provider        | Credential names                                                   | What you must configure or expect                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firecrawl       | `firecrawl_api_key`                                                | Select Firecrawl in AI & research **and** enable it here. Search discovers URLs; a separate bounded scrape retains returned document markdown, not generated summaries or search snippets.                                                                                                                          |
| Tavily          | `tavily_api_key`                                                   | Explicit alternative selection and enablement. Only returned raw content/extracts become records; generated answers and snippets do not. Target-access metadata is often unavailable, making useful results partial. Known PDFs are excluded because this adapter cannot enforce a numeric PDF page cap.            |
| YouTube         | `youtube_api_key`                                                  | Enable Data API access/quota. Collect video descriptions/metadata and available comments/replies. The API-key-only adapter cannot download authorized captions; **transcripts are not guaranteed or collected by this adapter**. Public `textDisplay` may differ from the author's original and is flagged.         |
| Apify           | `apify_api_token`                                                  | Enable, record granted usage approval, and allow each exact post/comment actor below. Instagram needs supported URLs or literal hashtags, not arbitrary full-text queries. TikTok supports documented search inputs. No downloads, transcription, or paid reply add-ons are enabled.                                |
| X               | `x_bearer_token`                                                   | Choose `recent` (last seven days) or `full_archive` with the account access required for that endpoint. Historical dates incompatible with recent access block before HTTP. Archive denial never falls back to recent. Queries and minimum-size probes may bill.                                                    |
| Reddit          | `reddit_client_id`, `reddit_client_secret`, `reddit_refresh_token` | Obtain approval for this intended use, record it explicitly, and configure an identifiable user-agent. OAuth refresh requires `read` or `*` scope. App registration/OAuth consent alone is not research or commercial data-use permission. MoreComments expansion is not implemented; affected threads are partial. |
| OpenAlex        | `openalex_api_key` (optional in the app contract)                  | Enable separately; actual access/quota depends on the service/account. Records contain reconstructed original abstracts or labeled metadata, **not downloaded full text**. OA PDF links are unretrieved references, not proof that the PDF was read.                                                                |
| Eurostat        | None                                                               | Enabled by default; select explicit dataset codes and dimension filters in scope. No dataset selection means blocked, not invented statistics. Tables preserve observations/status flags, not conclusions.                                                                                                          |
| Local documents | None                                                               | Enabled by default; import/select a document in Data Flow. TXT/XLSX are local; complex formats require optional local Docling. There is no automatic cloud parser.                                                                                                                                                  |

Apify's application-owned allowlist contains exactly:

- `apify/instagram-scraper`
- `apify/instagram-comment-scraper`
- `clockworks/tiktok-scraper`
- `clockworks/tiktok-comments-scraper`

Allowing a post actor does not allow its comment actor. A comment-only allowlist cannot enable
post discovery; a missing comment permission preserves posts with a named partial limitation.
Actor outputs/builds and account features can change. No arbitrary actor or actor-input override
is accepted. Returned subtitle links remain links; they are not fetched transcripts.

For Reddit, replace the contact in `desktop:ReqFlow:0.1 (by /u/your_reddit_username)` with your
approved client's identifiable contact. The Settings input requires 10–200 characters and checks
the identifiable format. Neither this input nor the approval switch obtains platform approval.

### Credentials stay in the main process

Use the masked Settings inputs, not scope JSON, workflow parameters, prompts, or source URLs.
**Save** accepts a nonblank draft; **Remove** is the separate deletion action. Drafts clear on
submission, errors, and leaving the section. Stored values are never returned to credential inputs.

Main encrypts credential values with Electron `safeStorage` and persists only ciphertext in
`secrets.enc.json`. Reads across IPC return configured booleans/source status, never saved keys.
Unavailable OS encryption fails explicitly; Linux's `basic_text` backend is rejected instead of
allowing plaintext fallback. The implemented Research secret store does not read environment keys,
even though the broader IPC status type/UI can represent `env` for compatibility.

General settings autosave cannot change provider enablement/approval/actor flags: dedicated
`research.configure` owns them. Credential/configuration changes invalidate old connection reports.
Running jobs use their starting settings/credential snapshot. Revoking access applies to subsequent
runs; press **Cancel run** to stop an active collection immediately.
Connection states are `not_configured`, `untested`, `success`, `invalid_credentials`,
`permission_required`, `rate_limited`, `unreachable`, and `unsupported`. These are distinct from
collection outcomes. See [Settings](settings.md) for controller behavior.

Only credentials have this OS-encryption guarantee. Imported originals, datasets, workflow state,
audit events, and exports are local files, not encrypted evidence stores. Protect their directory
and exported files with appropriate OS access controls; raw public comments can still contain
personal information.

## The 13 research agents

The inspector displays IDs with underscores replaced by spaces. Definition labels below come
from `packages/blocks/src/research/agents.ts`; selection is by the stable shared IDs.

| ID                  | Definition label             | Adapters                               |
| ------------------- | ---------------------------- | -------------------------------------- |
| `reddit`            | Reddit discussions           | Reddit                                 |
| `youtube`           | YouTube videos and comments  | YouTube                                |
| `instagram`         | Instagram posts and comments | Apify                                  |
| `tiktok`            | TikTok videos and comments   | Apify                                  |
| `x`                 | X posts and conversations    | X                                      |
| `owner_forums`      | Owner forums                 | Selected web provider                  |
| `editorial_reviews` | Editorial reviews            | Selected web provider                  |
| `competitor_models` | Competitor models            | Selected web provider                  |
| `market_studies`    | Market studies               | Selected web provider, OpenAlex        |
| `regional_context`  | Regional context             | Eurostat, selected web provider        |
| `technology`        | Technology publications      | Selected web provider, OpenAlex        |
| `bmw_sales`         | BMW sales publications       | Selected web provider, local documents |
| `bmw_strategy`      | BMW strategy publications    | Selected web provider, local documents |

All selected agents share one collector request's allowances; duplicate selections run once.
An agent name is a retrieval focus, not a classification of returned material. For example,
web documents remain passages unless their source supplies a stronger type. BMW sales/strategy
web access is narrowed to `bmwgroup.com` and `press.bmwgroup.com` before retrieval.

### Optional native Mastra query planning

The default neutral query builder is deterministic **query construction**, not mock research.
It still retrieves real originals through the explicitly configured adapters. To opt into paid
planning, select **Anthropic Claude** in AI & research, set **Fast model** to an Anthropic model ID
your account actually supports, save an Anthropic key in **API keys**, and turn on the block's
**Mastra query planning** toggle. Do not assume the preset model strings prove account access.

`mastra.ts` constructs **13 real standalone `@mastra/core` Agent instances** (installed 1.75.0)
with `{ providerId: "anthropic", modelId, apiKey }`. The key and user-configured model ID are
injected explicitly; there is no environment-key lookup, model substitution, or fake Mastra model.
Construction makes no model request. Eligible query-based agents may each make one planning call;
local reads and explicit Eurostat requests do not need planning. Planning is gated by enabled access,
credentials, approval, domains, remaining results/requests, and cancellation.

Only bounded search scope/query context goes to the model. **Collected originals, document contents,
tables, excerpts, source URLs, document IDs, and provider credentials never become planner input.**
There are no tools, browser, memory, workspace, or analytical outputs. Native structured output
returns at most three validated queries, with the deterministic neutral query retained. One step,
768 maximum output tokens, and zero model/processor retries are configured; no extra structuring
model or repair call is used. Planning failure is visible, not silently replaced with deterministic
success. Other independent local/non-query collection can still preserve its originals.

## Advanced research scope

Paste a **scope object**, not a `ResearchRequest` or budget object, into **Advanced research scope
(JSON)**. Unknown keys fail strict validation. The following is configuration only: the official
BMW URL is an illustrative input, **not a gathered source, a live-access claim, or example evidence**.
Competitors and dataset filters are operator selections, not findings about these vehicles/markets.

```json
{
  "brand": "BMW",
  "model": "5 Series",
  "currentGeneration": "G60",
  "previousGeneration": "G30",
  "derivative": "Sedan",
  "propulsion": "BEV",
  "modelYear": "2026",
  "markets": ["EU"],
  "languages": ["en", "de"],
  "publishedFrom": "2024-01-01",
  "publishedTo": "2026-10-10",
  "horizonYears": 5,
  "questions": ["What experiences are reported about rear-seat comfort?"],
  "keywords": ["rear-seat comfort", "charging experience"],
  "competitors": [{ "brand": "Mercedes-Benz", "model": "E-Class", "generation": "W214" }],
  "allowedDomains": [],
  "blockedDomains": [],
  "urls": ["https://www.bmwgroup.com/en.html"],
  "documentIds": [],
  "eurostatDatasets": [
    {
      "id": "demo_pjan",
      "filters": { "geo": "DE", "sex": "T", "age": "TOTAL", "time": "2024" }
    }
  ]
}
```

- Advanced values override the block's question/market/default scope and the automatically computed
  **Max. age** publication start. Dates are inclusive ISO days; start must not follow end. The
  example's historical window is incompatible with X recent search: request authorized archive
  access or choose a compatible window explicitly.
- `documentIds` accepts imported `file_…` IDs only, not paths or URLs. The native file picker adds
  its imported ID automatically. **Omit `documentIds` when using that picker**: even an explicit
  empty array in advanced JSON overrides the picker's selection. For multiple documents, supply
  the actual IDs returned by `files.import`, never a fabricated ID.
- Domains are hostname restrictions. Use bare hostnames in examples/configuration. Global blocked
  domains are unioned with scope blocks; nonempty allowlists intersect. Empty advanced lists cannot
  clear global restrictions, and a disjoint intersection fails closed. Source hosts, not API endpoint
  hosts, are checked; an allowlist restricted to BMW will exclude social/OpenAlex/Eurostat sources.
- Eurostat filters select observation dimensions/periods exactly. The example selects Germany
  explicitly; `markets: ["EU"]` does not select a Eurostat EU aggregate or rewrite `geo`. A selection
  is capped at 20,000 observation cells; narrow oversized filters. Publication dates are not
  observation periods. Language filters are used where each API supports them, not universally.
- **Requested markets, vehicle identity, query language, author location, and domain names are
  not customer-country or vehicle metadata.** Missing original Country/Brand/vehicle fields remain
  blank in feedback views; unknown publication/language/author metadata stays unknown. Never infer
  customer nationality, ownership, or language from the retrieval scope.

## Bounds, cancellation, and partial results

Set limits before a potentially paid run. The inspector defaults to 10 results, 100 requests,
20 document pages, 120,000 ms, and concurrency 3. Its result input permits 1–50; the shared
`ResearchLimits` API permits up to 1,000 results/requests, 500 pages, 900,000 ms, concurrency 8, and
three GET retries. The block currently forwards the five inspector limits; other shared-limit fields
(`retries`, `cacheMaxAgeMs`, `maxProviderCredits`, `maxApifyChargeUsd`) are not `scopeJson` settings.
Shared defaults are two GET retries, cache age zero, no optional credit cap, and $1 per Apify actor run.

- **One Research block invocation = one `ResearchRequest` budget.** All agents/adapters within it
  share ordinary HTTP attempts (including retries/failures) and planner reservations. Multiple
  Research blocks in the same workflow receive separate budgets; the merged run dataset is not
  proof of a workflow-wide spending cap.
- `maxResults` counts unique normalized raw-record IDs across that request, including passages,
  metadata, and tables, not just opinions. Duplicate records can add agent attribution without
  another result slot. Repeated VFC rows are associations with one opinion, not independent results.
  Agent record counts can overlap; do not sum them as unique opinions.
- **`maxRequests` is not an absolute physical-network cap.** Up to **four additional, reserved
  Apify cleanup attempts per HTTP client/request** can abort known actor runs after exhaustion or
  cancellation. Each uses an independent **five-second deadline**, the same concurrency/endpoint
  policy, and no retry. This intentional safety overhead is included in reported HTTP/agent counts.
  It cannot launch actors or abort unknown IDs. Abort does not prove termination or refund charges.
- HTTP bodies are capped at 16 MiB. Only allowlisted HTTPS provider endpoints are contacted;
  credentials, custom ports, redirects, and alternate endpoint hosts are rejected. GET alone retries
  transport/429/5xx failures with bounded backoff; paid POSTs are not blindly replayed.
- Normalized datasets are bounded to **16 MiB of compact serialized JSON**, including repeated
  provenance; oversized records are excluded with explicit partial limitations, preserving accepted
  originals. Persistence/JSON export reject above **64 MiB before stringification or writes**.
  The renderer's 20,000-character preview is display-only; it never truncates stored originals.
- Optional Firecrawl/Tavily credit reservations are conservative, not invoice predictions. They
  reserve search/extract allowances and Firecrawl's maximum PDF pages before purchase, including
  failed attempts. Other providers' quotas and billing are separate. Apify's charge setting is
  **per actor run**, not the sum of discovery plus comment runs. Anthropic input/output tokens can
  bill separately, including failed/cancelled calls; the query-only contract does not export token
  usage or monetary totals. **No total physical-cost guarantee is provided.**

Accepted originals survive later provider/schema/page failures, cancellation, or exhaustion and
are saved cumulatively after each selected agent. Read `success`, `empty`, `partial`,
`missing_credentials`, `blocked`, `error`, and `cancelled` separately. `empty` means a valid empty
search, not missing credentials. A wholly unsuccessful empty collection fails the block **after**
preserving its result details; an absent dataset is an error, not fabricated empty data. A retained
partial dataset remains exportable. Source-domain filtering and unknown/coarse dates inside a
requested date window produce explicit limitations, not unqualified completeness.

See [HTTP](http.md), [runtime](runtime.md), and [Apify](apify.md) for accounting and remote-stop limits.

## Local documents and offline availability

Use **Local original document** to import `.txt`, `.xlsx`, `.pdf`, `.docx`, or `.pptx` through the
native dialog. Main copies the chosen file to the app's local store; source identity is
`reqflow-file:///<fileId>`, with original artifact IDs/locators, not a private filesystem URL.
The current Research import does not support `.xls`/`.csv` merely because the separate Raw spec
lists them. Local reads shared by both BMW agents are cached within a run, not across future runs.

- **TXT/XLSX require no Docling or cloud service.** TXT must be valid UTF-8. XLSX preserves sheets,
  header/row positions, scalars, nulls, cached formula results, source classifications, units/notes,
  and cell artifacts. Formulas/macros are not evaluated; links are not followed.
- Imports/readers cap files at 64 MiB. XLSX adds hard preflight caps: **16 MiB compressed**, **32 MiB
  expanded ZIP**, **2,048 entries**, **100,000 rows / 512 columns per sheet**, **1,000,000 aggregate
  `rowCount × columnCount` cells including sparse gaps**, and **16 MiB parsed cell metadata**.
  Each header is capped at **16,384 UTF-16 units** and combined worksheet headers at **128 KiB
  serialized UTF-8**, checked before feedback/provenance duplication.
  Invalid/encrypted/Zip64/oversized archives fail, not silently truncate.
- Desktop passes the bundled `research-xlsx-worker.js` entry, outside ASAR, to a real Node Worker.
  It has an empty environment, no inherited `execArgv`, V8 limits of 128 MiB old heap / 16 MiB young
  heap / 4 MiB stack, a 30-second deadline, and abort termination. These are **not total RSS limits**.
  A worker failure never falls back to main-thread parsing or cloud. The library's optional
  in-process compatibility path is not the production untrusted-import path.
- **PDF/DOCX/PPTX require a separately provisioned local Docling CLI and prefetched models.** Main
  currently discovers `docling` on its launch `PATH` and requires an absolute
  `DOCLING_ARTIFACTS_PATH`. There is no GUI executable setting or automatic Python/model installer.
  A local availability probe can report TXT/XLSX success while complex formats are unsupported;
  detecting CLI flags does not prove model completeness.
- The Docling subprocess uses `shell: false`, a restricted environment, offline model flags,
  disabled remote services/plugins and **disabled OCR**, bounded input/output, page limits where
  supported, and a 120-second process ceiling (the collection deadline can stop it earlier).
  Scanned PDFs need a separately approved local OCR integration. DOCX pagination, PDF layout,
  full document coverage, and transcripts are not guaranteed. No automatic cloud fallback exists.

No real Docling/model-backed conversion was verified on this documentation host, where no `docling`
command was found on PATH. Use the provisioning/packaging caveats in
[documents and statistics](documents-statistics.md); verify the chosen runtime offline before
opening sensitive originals. Native Windows/Linux execution remains untested here.

## Raw identity and export fidelity

JSON is the complete validated raw dataset: `schemaVersion`, `runId`, sources, records, collection
results, retrieval timestamp, and `synthetic`. Records retain normalized and original source/record
IDs, original URL/text, provider, collecting agents/run IDs, publication value and
`datePrecision` (`instant`, `day`, `month`, `year`, `unknown`), language, source-supplied attribution,
parent/thread/context, locators, tables, metadata, limitations, and content hashes.
Publication is never replaced by retrieval time. Missing author/user/language values are not
invented; provider-supplied unknown-language markers remain as supplied.

Normalized URL identity removes fragments/tracking parameters while retaining meaningful query
parameters. Firecrawl/Tavily copies at the same URL share a publication record; distinct social
comment IDs are not collapsed just because their text matches. A merge selects the latest
`retrievedAt` revision and unions attribution/limitations, explicitly flagging changed content.
Earlier run datasets retain earlier content. This is not an immutable archival guarantee for all
versions within one run.

### Feedback_Explorer is feedback only

Its first twelve template columns are **ID**, **Source**, **Brand**, **Sales Description**,
**Country**, **Derivate (e-code)**, **Engine Type**, **Feedback Type**, **Customer Feedback**,
**Vfc level2 3 Name**, **Vfc level2 Name**, and **Vfc level3 Name**.

Only `recordType: "feedback"` appears in this view/CSV. Studies, product descriptions, forecasts,
tables, passages, video descriptions, and transcripts do not become customer opinions. Local
Feedback_Explorer rows with the **same original ID and same text** produce one opinion and multiple
source-supplied VFC associations. Export expands those associated rows with the **same normalized
ID**, original feedback ID, sheet, and row. Classification is source-only, not a new AI label;
different texts under one original ID stay distinct with a conflict limitation.

The supplied Windows reference workbook was unavailable on this macOS host and was **not opened**.
The reported **4,076 association rows / 2,128 unique feedback IDs** are user-provided reference
figures, **not verified ingestion counts** or real-data acceptance evidence. The twelve-column
contract was exercised with synthetic workbooks; no private BMW path/data was inspected.

### Choose an export

- **JSON:** authoritative raw strings/structures. Formula protection and overflow do not alter it.
- **CSV:** feedback rows only, UTF-8 BOM, quoted/escaped fields, CRLF row separators, and retained
  embedded newlines. There is no CSV cell-length truncation; use JSON/XLSX for non-feedback records.
- **XLSX:** `Feedback_Explorer`, `Sources`, `Research Records`, `Metrics Tables`, `Research Runs`,
  plus `Cell Overflow` when needed. Tables preserve numeric zero, nulls, status flags, dimensions,
  units, and footnotes instead of interpreting them.

Every XLSX string cell, including serialized metadata and guards, stays within **32,767 UTF-16 code
units**. Oversized/XML-incompatible values use explicit pointers to bounded ordered overflow
segments, not unmarked truncation or summaries. Reconstruct by owning sheet/row/column, numeric
segment order, and parsed **Original Segment JSON**; concatenate, then parse again for structured
JSON values. Segments do not split surrogate pairs. Standalone CR and CRLF are preserved in the
written workbook rather than silently normalized by XML.

Spreadsheet strings beginning (after whitespace/control characters) with `=`, `+`, `-`, or `@`
receive an apostrophe formula guard. **This changes the spreadsheet view**, not raw JSON; cells
are text, not executable formulas. Do not blindly strip apostrophes to reconstruct originals.
See [exports](exports.md) for exact reconstruction and lineage rules.

## Developer boundaries and reference

Use the existing typed `api` bridge from renderer code. Do not add renderer `fetch`, filesystem
access, provider SDKs, or credential reads. The implemented research calls are:

| API                                                       | Arguments / result                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `research.agents()`                                       | Returns all `ResearchAgentDefinition[]`; no collection.                                                             |
| `research.providers()`                                    | Returns `ResearchProviderStatus[]` with configuration, credential booleans, and connection reports.                 |
| `research.configure(id, config)`                          | Validated `ResearchProviderId` and complete `ResearchProviderConfig`; persists access flags and returns one status. |
| `research.test(id)`                                       | Explicit bounded probe; returns one status, does not activate collection.                                           |
| `research.dataset(runId)`                                 | Returns saved `ResearchDataset`, including partial/unsuccessful results; absent data rejects.                       |
| `settings.setSecret(name, valueOrNull)`                   | Saves encrypted nonblank credential or deletes on `null`; returns `SecretStatus`, not a key.                        |
| `files.import()`                                          | Native picker, local copy, `StoredFileInfo` or `null` on cancellation.                                              |
| `workflows.save(input)` / `runs.start(workflowId)`        | Save validated graph/version, then start the generic engine.                                                        |
| `runs.blockOutput(runId, blockId)` / `runs.cancel(runId)` | Preserved per-port output / cancellation snapshot.                                                                  |
| `exports.research({ runId, format })`                     | `json`, `xlsx`, or `csv`; native save dialog, `{ path }` or `null`.                                                 |

Input validation uses shared Zod contracts. IPC errors include `invalid_input`, `invalid_graph`,
`not_found`, `run_busy`, `invalid_state`, `invalid_file`, `storage_error`,
`secure_storage_unavailable`, and `secret_storage_error`; arbitrary internal exceptions become a
fixed `internal` message. Provider/collection reports carry their own access and rate-limit states.

Implementation map:

- Contracts: `packages/core/src/research.ts`, `blocks.ts`, `services.ts`, `ipc.ts`.
- Native wiring, encrypted credentials, local JSON persistence: `apps/desktop/src/main/research/`.
- Agent definitions/planning, adapters, normalization, HTTP, exports:
  `packages/blocks/src/research/`.
- Shared executor: `packages/engine/src/executor.ts`; renderer controls:
  `apps/desktop/src/renderer/src/components/dataflow/RunControls.tsx`.

Further reading: [workflow](workflow.md), [runtime](runtime.md), [Mastra](mastra.md),
[web providers](web-providers.md), [social providers](social-providers.md), [Apify](apify.md),
[documents/statistics](documents-statistics.md), [HTTP](http.md), [Settings](settings.md),
[exports](exports.md), and [verification](verification.md). Official provider-documentation links
and their owners' 2026-10-10 public-document checks are recorded in those subdocs; they are **not live
API acceptance runs**. No research website fetch is needed to execute the synthetic test strategy.
