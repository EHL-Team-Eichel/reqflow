# Workstreams — how to split the work across agents

Each workstream (WS) owns a set of paths, so parallel agents never edit the same files. Everything
builds against the contract in `packages/core` and the node contract in `packages/engine/src/node.ts`.
UI workstreams use `@reqflow/core/fixtures` until the API is live. Node workstreams test with
fixtures and the `mock` LLM.

## Kickoff prompt (paste into each agent, fill in the WS)

> You are agent **WS\<n\> (\<name\>)** on the ReqFlow repo. Read `AGENTS.md`, `PRODUCT.md`,
> `docs/ARCHITECTURE.md` and your section of `docs/WORKSTREAMS.md`. Build your workstream end to end,
> editing only your owned paths. Finish with: what you built, how you verified it (commands and
> results), any contract-change requests, and what is still open.

## UI agents (WS2–WS4)

The renderer is sandboxed: no Node, no `fs`, no `fetch` to the internet. Reach data only through
`api` from `@/lib/api`. Until WS1 implements a method, it throws `ReqflowError` with code
`not_implemented`. Show that state, or render `@reqflow/core/fixtures` meanwhile. Check your screens
with `npm run smoke` (screenshots land in `apps/desktop/out/smoke/`).

## Git

Use one branch per workstream (`ws1-engine`, `ws2-editor`, …), ideally in its own `git worktree`. Make small
commits and rebase on `main` often. To add a dependency, add it to **your own** package's
`package.json` only. If `package-lock.json` conflicts, run `npm install` again.

## Phases

0. **Done (lead):** repo skeleton, the contract (`core`), the node contract and registry, the default template, fixtures, and the app shell.
1. **Parallel:** WS1–WS8 below.
2. **Integration (lead):** wire services and the registry in `apps/desktop/src/main`, run the default template end
   to end with `mock`, then with Claude and the real BMW data, then polish the demo.

---

### WS0 — Lead / integrator (main session)

**Owns:** `packages/core/**`, `docs/**`, `AGENTS.md`, `PRODUCT.md`, root config files.
**Does:** merges branches, reviews and applies contract changes, runs integration (phase 2) and keeps docs current.

### WS1 — Engine, persistence & main process

**Owns:** `packages/engine/**`, `packages/db/**`, `apps/desktop/src/main/**`, `apps/desktop/src/preload/**`,
`packages/nodes/src/review/**`, `packages/nodes/src/output/**`.
**Builds:**

- **First,** the read-only handlers the UIs need (`requirements.*`, `audit.list`, `settings.get`) — serving the core fixtures is fine until the DB lands, so UI agents can work against real IPC early.
- Graph validation and the executor (topological run, merge, per-node output storage, failure → skipped, pause/resume, cancel).
- SQLite repositories, versioned requirements, append-only `AuditLogger`, `FileStore`, settings storage.
- Every method in `main/handlers.ts` (replace each `notBuilt`), with Zod validation of all arguments. Wire registry, LLM, web search, DB and keychain (`safeStorage`) in `main/`; push run updates via `IPC_EVENTS.runUpdate`.
- Nodes: `review.pm_gate`, `output.publish`, `output.export` (JSON / CSV / Markdown).

**Done when:** executor tests pass with fake nodes (success, failure, multi-input merge, pause → resume,
cancel). Every IPC method works against SQLite (none left `not_implemented`). A run of fake nodes streams updates to `runs.onUpdate`.

### WS2 — Workflow editor UI

**Owns:** `apps/desktop/src/renderer/src/pages/WorkflowPage.tsx`, `apps/desktop/src/renderer/src/components/workflow/**`.
**Builds:** a React Flow canvas. The node palette comes from `api.nodes.catalog()`, grouped by category with
consumes/produces hints. A config side panel is rendered from `configJsonSchema`, including file import
(`api.files.import()`, native dialog) for `source.bmw_dataset`. Save and load workflows, and start a new one from a template. Add a run button with
live status, counts and logs on each node. Clicking a node opens an output inspector. A "waiting for PM
review" banner links to `/requirements`. Warn when a node consumes a key that nothing upstream produces.
**Done when:** you can build the default template by hand, save it, reload it, and see run states on the canvas (mocked until WS1 lands).

### WS3 — Requirements review & audit UI

**Owns:** `apps/desktop/src/renderer/src/pages/Requirement*.tsx`, `apps/desktop/src/renderer/src/pages/AuditPage.tsx`,
`apps/desktop/src/renderer/src/components/requirements/**`, `apps/desktop/src/renderer/src/components/audit/**`.
**Builds:** a requirements list or board with filters and sorting. A detail page shows targets, a score
breakdown (factor × weight with notes), priority and rationale, an evidence level badge, assumptions,
uncertainties and conflicting evidence, and a drill-down from findings to verbatim excerpts to sources.
Add a decision bar (approve / reject / defer / challenge) where rationale is required, inline editing with
rationale, a History tab, a global audit timeline with before → after diffs and filters, a resume-run
action, and export.
**Done when:** every field from the briefing's deliverable list is visible for the fixture requirements,
and the decision and edit flows call `api.requirements.*`.

### WS4 — Settings, app shell & packaging

**Owns:** `apps/desktop/src/renderer/src/pages/SettingsPage.tsx`, `apps/desktop/src/renderer/src/components/settings/**`,
`apps/desktop/src/renderer/src/components/shell/**`, `apps/desktop/src/renderer/src/components/ui/**` (shared primitives), `apps/desktop/src/renderer/src/router.tsx`,
`apps/desktop/src/renderer/src/globals.css`, `apps/desktop/electron-builder.yml`, `apps/desktop/build/**` (app icons).
**Builds:** a Settings form for every `Settings` field: LLM provider and models, API-key status (never the
key itself), research provider and domains, weight sliders with a live example score built on
`weightedTotal`, thresholds, default scope, and reviewer. It validates with the `Settings` schema. Also own the
visual system (tokens and shared UI primitives others reuse), the app shell, the app icon and installer
config (`electron-builder.yml`).
**Done when:** settings load, validate, save and appear as a `settings.changed` audit event, the shell looks
demo-ready, and `npm run package` produces a working installer on your OS.

### WS5 — BMW data ingestion

**Owns:** `packages/nodes/src/ingest/**`, `data/samples/**`.
**Builds:** the `source.bmw_dataset` node. Config: `fileId`, `datasetKind`, optional column mapping. It parses
the provided formats (CSV, XLSX and whatever BMW ships: check `data/raw/` once it arrives) into `Source` +
`SourceRecord[]` with locators and language. Structured datasets (equipment take rates, sales volumes)
also emit deterministic `usage_pattern` findings (for example a high take rate signals a basic expectation)
with evidence. Also write synthetic sample files in `data/samples/` that match the real formats.
**Done when:** each sample dataset ingests in tests, errors name the bad row or column, and no data is dropped silently.

### WS6 — Web research

**Owns:** `packages/nodes/src/research/**`.
**Builds:** the `source.web_research` node. It turns the scope into queries (competitors in the segment,
owner and press reviews, market and technology trends for the horizon), runs them through `ctx.web`, fetches
pages and extracts clean text into `SourceRecord`s, and sets the `Source` kind, publisher, date and
**reliability** (with the rule documented). It respects allowed and blocked domains and de-duplicates by URL.
Also implement `WebSearch` providers (`anthropic_web_search`, `tavily`) as factories that take keys as
arguments (WS1 wires them).
**Done when:** a recorded or offline test run produces sources with working URLs and reliability, and failures are logged rather than swallowed.

### WS7 — AI analysis & requirement derivation

**Owns:** `packages/llm/**`, `packages/nodes/src/analysis/**`, `packages/nodes/src/requirements/**`.
**Builds:** an `LlmClient` with a Claude provider and a deterministic `mock` provider (use the `claude-api`
skill for SDK details). The nodes are `analysis.extract_signals` (with verbatim-excerpt verification),
`analysis.scope_filter` (out-of-scope items logged with a reason), `analysis.cluster_themes`,
`requirements.derive` (customer-facing, actionable, IDs from `formatRequirementId`) and
`requirements.specify_targets` (measurable targets, evidence level per the A–D rule, Kano class,
assumptions, uncertainties, conflicting findings). Also export `answerChallenge(...)` for the API's
challenge flow.
**Done when:** fixture records → findings → themes → requirements runs fully offline with `mock`, all
outputs parse against the core schemas, and every finding's excerpt is verified.

### WS8 — Prioritization

**Owns:** `packages/nodes/src/prioritization/**`.
**Builds:** the `prioritization.score` node. Factors are computed deterministically where possible: customer
impact from mentions, sentiment and sales volume; evidence strength from independent sources × reliability
and evidence level; competitive gap from `competitor_advantage` findings; trend momentum from `market_trend`
findings. The LLM is used only where a judgement is needed (brand fit, ease), always with a one-line note.
It uses `weightedTotal` and `priorityForScore` and writes a readable `priorityRationale` naming the top drivers.
It also flags "high score, weak evidence".
**Done when:** scores are reproducible for the fixtures, changing Settings weights changes the ranking as
expected (tested), and each factor has a note a PM can understand.
