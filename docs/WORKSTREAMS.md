# Workstreams — how to split the work across agents

Each workstream (WS) owns a set of paths, so parallel agents never edit the same files. Everything
builds against the contract in `packages/core` (block specs in `blocks.ts`, graph rules in `graph.ts`)
and the block contract in `packages/engine/src/block.ts`. UI workstreams use `@reqflow/core/fixtures`
until the API is live. Block workstreams test with fixtures and the `mock` LLM.

## Starting an agent

Paste [AGENT_PROMPT.md](AGENT_PROMPT.md) into the agent, with the workstream filled in. Agents claim
work and hand it off in [STATUS.md](STATUS.md), each editing only its own section. **The concrete,
ordered task list for every workstream lives in STATUS.md**; this file defines scope, file ownership
and "done when".

## UI agents (WS2–WS4)

The renderer is sandboxed: no Node, no `fs`, no `fetch` to the internet. Reach data only through
`api` from `@/lib/api`. Until WS1 implements a method, it throws `ReqflowError` with code
`not_implemented`. Show that state, or render `@reqflow/core/fixtures` meanwhile. Reuse the shared
controls in `components/ui/` and the design tokens in `globals.css` (light and dark). Check your
screens with `npm run smoke` (screenshots land in `apps/desktop/out/smoke/`), and extend
`apps/desktop/src/main/smoke.ts` (ask WS1/WS0) when you add an interaction worth guarding.

## Git

Use one branch per workstream (`ws1-engine`, `ws2-editor`, …), ideally in its own `git worktree`. Make small
commits (`ws<N>: …`), push right away, and rebase on `main` at least hourly. Merge into `main` through a PR
with a merge commit, never a squash, so Entire's checkpoint trailers survive. To add a dependency, add it to **your own** package's
`package.json` only. If `package-lock.json` conflicts, run `npm install` again.

## Phases

0. **Done (lead):** repo skeleton, the contract (`core`: schemas, block specs, graph rules), the block
   contract and registry, the default template, fixtures, the app shell with its three tabs, the Data
   Flow editor (structure), the Settings page and the Car placeholder.
1. **Parallel:** WS1–WS8 below.
2. **Integration (lead):** wire services and the registry in `apps/desktop/src/main`, run the default template end
   to end with `mock`, then with Claude and the real BMW data, then polish the demo.

---

### WS0 — Lead / integrator (main session)

**Owns:** `packages/core/**`, `docs/**`, `AGENTS.md`, `PRODUCT.md`, root config files.
**Does:** merges branches, reviews and applies contract changes (including block params and ports), runs
integration (phase 2) and keeps docs current.

### WS1 — Engine, persistence & main process

**Owns:** `packages/engine/**`, `packages/db/**`, `apps/desktop/src/main/**`, `apps/desktop/src/preload/**`,
`packages/blocks/src/hil/**`, `packages/blocks/src/index.ts`, `packages/blocks/src/templates/**`.
**Builds:**

- **First,** the handlers the UIs need: `settings.get/save` (the Settings page already calls them),
  `workflows.*` (so the editor can save and load), `files.import` (Raw's file param), and read-only
  `requirements.*` / `audit.list` serving the core fixtures until the DB lands.
- The executor (see ARCHITECTURE.md → Engine semantics): `validateGraph`, topological run per workplace,
  inner workplaces via boundary blocks, merge per input port, per-port output storage, failure →
  skipped, pause/resume at HIL, cancel. Wire `BlockContext` (including `ctx.car.add` → DB).
- SQLite repositories, versioned requirements, append-only `AuditLogger`, `FileStore`, settings storage.
- Every method in `main/handlers.ts` (replace each `notBuilt`), with Zod validation of all arguments. Wire registry, LLM, web search, DB and keychain (`safeStorage`) in `main/`; push run updates via `IPC_EVENTS.runUpdate`.
- The HIL block (pause until reviewed, then pass on what the reviewer kept).

**Done when:** executor tests pass with fake blocks (success, failure, multi-port merge, splitter
fan-out, inner workplace, pause → resume, cancel). Every IPC method works against SQLite (none left
`not_implemented`). A run of fake blocks streams updates to `runs.onUpdate`.

### WS2 — Data Flow editor UI

**Owns:** `apps/desktop/src/renderer/src/pages/DataflowPage.tsx`, `apps/desktop/src/renderer/src/components/dataflow/**`.
**State today:** palette, workplace (React Flow), blocks with ports, connect with validation, inspector
with parameter forms, inner workplaces with breadcrumb, delete with confirmation, snap/minimap from
Settings. The flow lives in memory (`components/dataflow/store.ts`).
**Builds next:** save/load (`api.workflows.*`, autosave), "New from template" (`api.templates.list()`),
undo/redo, copy/paste, a Run button with live status, counts and logs on each block
(`api.runs.onUpdate()`), an output inspector (`api.runs.blockOutput()`), and a "waiting for review"
banner linking to the Car tab.
**Done when:** you can build the default template by hand, save it, reload it, and see run states on the
blocks (mocked until WS1 lands).

### WS3 — Car tab: requirements review & audit UI

**Owns:** `apps/desktop/src/renderer/src/pages/CarPage.tsx`, `apps/desktop/src/renderer/src/components/car/**`,
`apps/desktop/src/renderer/src/components/requirements/**`, `apps/desktop/src/renderer/src/components/audit/**`.
**Builds:** the Car tab as the output page: the car (keep the car visual) with its requirements as a
list or board, grouped by ranking, with filters and sorting. A detail view shows targets, a score
breakdown (factor × weight with notes), priority and rationale, an evidence level badge, assumptions,
uncertainties and conflicting evidence, and a drill-down from findings to verbatim excerpts to sources.
Add a decision bar (approve / reject / defer / challenge) where rationale is required, inline editing
with rationale, a History view, a global audit timeline with before → after diffs and filters, a
resume-run action, and export.
**Done when:** every field from the briefing's deliverable list is visible for the fixture requirements,
and the decision and edit flows call `api.requirements.*`.

### WS4 — Settings, app shell & packaging

**Owns:** `apps/desktop/src/renderer/src/pages/SettingsPage.tsx`, `apps/desktop/src/renderer/src/components/settings/**`,
`apps/desktop/src/renderer/src/components/shell/**`, `apps/desktop/src/renderer/src/components/ui/**` (shared controls),
`apps/desktop/src/renderer/src/lib/settings*.ts`, `apps/desktop/src/renderer/src/lib/theme.ts`, `apps/desktop/src/renderer/src/router.tsx`,
`apps/desktop/src/renderer/src/globals.css`, `apps/desktop/electron-builder.yml`, `apps/desktop/build/**` (app icons).
**State today:** bottom tab bar (⌘/Ctrl 1–3), Settings with App, Global parameters, AI & research,
Collaboration and About; theme switching (system/light/dark); every change validated with the
`Settings` schema. Not saved yet (waits for WS1's `settings.save`).
**Builds next:** API-key entry once `settings.setSecret` exists (never display a stored key), a
`settings.changed` audit entry once WS1 logs it, the app icon and installer config, demo polish.
**Done when:** settings load, validate, save and appear as a `settings.changed` audit event, the shell looks
demo-ready, and `npm run package` produces a working installer on your OS.

### WS5 — Raw block (BMW data ingestion)

**Owns:** `packages/blocks/src/raw/**`, `data/samples/**`.
**Builds:** the Raw block. Params (see `BLOCK_SPECS.raw`): Excel upload (`file` = `{ fileId, name }`
from `api.files.import()`, `sheet`) or database (`dbType`, `connection`, `query`; never store
passwords in params), plus `dataset`. It parses the provided formats (CSV, XLSX and whatever BMW
ships: check `data/raw/` once it arrives) into `Source` + `SourceRecord[]` with locators and language.
Structured datasets (equipment take rates, sales volumes) also emit deterministic `usage_pattern`
findings (for example a high take rate signals a basic expectation) with evidence. Also write
synthetic sample files in `data/samples/` that match the real formats. Param changes → request via WS0.
**Done when:** each sample dataset ingests in tests, errors name the bad row or column, and no data is dropped silently.

### WS6 — Research block

**Owns:** `packages/blocks/src/research/**`.
**Builds:** the Research block. It turns its params and the scope into queries (competitors in the
segment, owner and press reviews, market and technology trends for the horizon), runs them through
`ctx.web`, fetches pages and extracts clean text into `SourceRecord`s — the same stream format as Raw —
and sets the `Source` kind, publisher, date and **reliability** (with the rule documented). It respects
allowed and blocked domains and de-duplicates by URL. Also implement `WebSearch` providers
(`anthropic_web_search`, `tavily`) as factories that take keys as arguments (WS1 wires them).
**Done when:** a recorded or offline test run produces sources with working URLs and reliability, and failures are logged rather than swallowed.

### WS7 — AI blocks: AI Filter, AI Splitter, Add to Car

**Owns:** `packages/llm/**`, `packages/blocks/src/ai-filter/**`, `packages/blocks/src/ai-splitter/**`,
`packages/blocks/src/add-to-car/**`.
**Builds:** an `LlmClient` with a Claude provider and a deterministic `mock` provider (use the `claude-api`
skill for SDK details). **AI Filter**: keep items matching the criterion and extract evidence-linked
findings (verbatim-excerpt verification; out-of-scope items logged with a reason). **AI Splitter**:
route every item to exactly one branch (`out-<i>`); "Split by: Priority" uses WS8's scoring.
**Add to Car**: cluster and derive customer-facing, actionable requirements (IDs from
`formatRequirementId`, measurable targets, evidence level per the A–D rule, Kano class, assumptions,
uncertainties, conflicting findings), set the priority from the input port's ranking, and hand them
to `ctx.car.add`. Also export `answerChallenge(...)` for the API's challenge flow.
**Done when:** fixture records → filter → splitter → Add to Car runs fully offline with `mock`, all
outputs parse against the core schemas, and every finding's excerpt is verified.

### WS8 — Prioritization

**Owns:** `packages/blocks/src/prioritization/**`.
**Builds:** explainable scoring used by the AI Splitter's priority mode. Factors are computed
deterministically where possible: customer impact from mentions, sentiment and sales volume; evidence
strength from independent sources × reliability and evidence level; competitive gap from
`competitor_advantage` findings; trend momentum from `market_trend` findings. The LLM is used only
where a judgement is needed (brand fit, ease), always with a one-line note. It uses `weightedTotal`
and `priorityForScore` and writes a readable `priorityRationale` naming the top drivers. It also flags
"high score, weak evidence".
**Done when:** scores are reproducible for the fixtures, changing Settings weights changes the ranking as
expected (tested), and each factor has a note a PM can understand.
