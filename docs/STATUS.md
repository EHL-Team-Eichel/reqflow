# Project status — the handoff file

The next agent starts here. **Edit only your own workstream's section** (so parallel agents never
conflict), and update it whenever you start, finish a slice, get blocked or stop. Keep entries short.
Status values: `open` · `in progress` · `blocked` · `review` · `done`.

**Tasks:** every section has a checklist in priority order. Take the first unchecked task that isn't
blocked, tick it (`[x]`) once it's merged to `main` and verified, and add tasks you discover at the
bottom of your own list. Scope and file ownership: [WORKSTREAMS.md](WORKSTREAMS.md).

## Critical path to the demo

1. **WS1** settings + workflow storage and `files.import` → the app keeps its state across restarts.
2. **WS7** mock LLM + **WS5** Raw on sample files + **WS1** executor → a flow runs end to end offline.
3. **WS3** Car tab on fixtures → can start **now**, in parallel.
4. **WS8** scoring + **WS7** AI Splitter / Add to Car → real, ranked requirements on the Car tab.
5. **WS6** web research, **WS4** packaging and icon, **WS2** run view and polish.

## What works right now (maintained by WS0)

- **App shell:** Electron desktop app with three tabs at the bottom, **Data Flow · Car · Settings**
  (⌘/Ctrl + 1–3), light and dark theme in the BMW M colorway. `npm run dev` to try it,
  `npm run smoke` to check it (drives the real app, screenshots in `apps/desktop/out/smoke/`).
- **Data Flow (structure):** Building Blocks palette (Custom, Raw, Research, AI Filter, AI Splitter,
  HIL, Add to Car), drag or click onto the workplace, connect ports (invalid connections and loops are
  refused with a reason), inspector with placeholder parameters, splitter branches and Add to Car
  rankings become ports, Custom/Research/AI Filter open into inner workplaces (breadcrumb back),
  delete with confirmation. The flow lives in memory: **not saved yet** and **nothing runs yet**.
- **Car:** placeholder (car icon + global vehicle/market from Settings).
- **Settings:** App, Global parameters, AI & research, Collaboration, About. Changes are validated and
  apply live (theme, grid, minimap). **Not saved to disk yet** (`settings.save` is WS1).
- **Contract:** domain schemas, block specs (`core/src/blocks.ts`), graph rules (`core/src/graph.ts`),
  IPC API, scoring formula, synthetic 5 Series EU fixtures, block registry, default template.
  **No block implementation, executor or storage exists yet.** Built IPC methods: `app.info`,
  `templates.list`; every other method answers `not_implemented`.
- Repo is public, and Entire is enabled (checkpoints are pushed with every `git push`).

## Open questions for the humans

- Demo scope is 5 Series Sedan · EU. Confirm it once BMW's datasets arrive.
- BMW datasets: not received yet (they go into `data/raw/`, which is gitignored).

---

## WS0 — Lead / integrator

**Status:** in progress · **Owner:** Claude Code (setup session) · **Branch:** `main`

**Tasks**

- [ ] Review and merge PRs (merge commits, never squash); keep `main` green with `npm run check && npm run smoke`.
- [ ] Apply contract-change requests from the sections below (`packages/core`, block params and ports).
- [ ] Integration: run `BMW_DEFAULT_TEMPLATE` end to end with the `mock` LLM, then with Claude and the real data.
- [ ] Demo script and rehearsal (PRODUCT.md → Demo scenario); keep PRODUCT.md and this file current.

**Log**

- 2026-10-10 late: Switched the visual system to the BMW M colorway (see ARCHITECTURE.md → Renderer state).
  Wrote ordered task lists for every workstream in this file.
- 2026-10-10 evening: Built the app structure from the team's sketch: bottom tabs, Data Flow editor
  (blocks, ports, inner workplaces), Settings page, Car placeholder. Replaced the node model with
  building blocks (ADR 0003): `@reqflow/nodes` → `@reqflow/blocks`, `nodes.catalog` removed,
  `runs.nodeOutput` → `runs.blockOutput`. Verify: `npm run check && npm run smoke`.
- 2026-10-10: Repo scaffolded, switched from web to Electron desktop app, made the repo public, enabled Entire.

### Local Entire / OpenCode setup

- **Status:** done.
- **Branch:** `ws0-entire-opencode`.
- **Scope:** developer setup requested by the human; local commits only.
- **What works:** dependencies installed with Node 24.21.0 / npm 11.19.0;
  Entire 0.11.4 enabled for OpenCode 1.18.35, preserving the existing Claude Code
  hooks. A fresh synthetic OpenCode shell session was captured and its transcript
  exported locally. A plain Git setup commit generated checkpoint
  `01M4K9XV8X9GP2RCJZRQRC2Q62`, its `Entire-Checkpoint:` trailer, and a local
  checkpoint ref containing both raw and normalized synthetic transcripts.
  `npm run check` passes (all workspace typechecks, 46 tests across 11 files, and
  Prettier).
- **Integration:** rebased onto `origin/main` at `b1dae4f`; the team's status
  sections and both checkpoint trailers are preserved. `entire doctor` confirms
  healthy Git and agent hooks with no stuck sessions.
- **Configuration:** `.opencode/plugins/entire.ts` is generated by Entire and
  excluded from Prettier. Git hooks and `.entire/settings.local.json` are local;
  telemetry and automatic checkpoint pushing are disabled. The tracked
  `git-refs` checkpoint backend is preserved.
- **Verify:** run `entire status --detailed`, `entire agent list`, and
  `npm run check`. Restart OpenCode from the repository before working, with
  `entire` available on its inherited `PATH`. After a plain `git commit`, inspect
  `git log -1 --format=%B` for `Entire-Checkpoint:` and run
  `git for-each-ref refs/entire/checkpoints` to inspect local checkpoint refs.
- **Next:** restart OpenCode from the repository to use the installed plugin in
  new development sessions.
- **Open questions:** none.

## WS1 — Engine, persistence & main process

**Status:** open · **Owner:** — · **Branch:** —
**Unblocks:** everyone. Do tasks 1–4 first; they are small and make the UIs real.

**Tasks**

- [ ] `settings.get` / `settings.save` in `apps/desktop/src/main/`: one JSON file in the data dir, written
      atomically (temp file + rename), validated with `Settings`; on load, fill sections missing from older
      files with `DEFAULT_SETTINGS`. Done when the Settings page's "not saved" banner disappears and a
      change survives a restart (add a test for the load/merge/save logic).
- [ ] `workflows.list/get/save/remove`: store the block tree; `save` assigns a `wf_…` id, bumps
      `version`, sets timestamps and rejects graphs where `validateGraph` reports issues
      (`invalid_input` with the issues as details).
- [ ] `files.import()`: native open dialog (`.xlsx`, `.xls`, `.csv`), copy into `<dataDir>/uploads/`,
      return `StoredFileInfo`. The Raw block's "Choose file…" button already calls it.
- [ ] Read-only `requirements.list/get` and `audit.list` serving `@reqflow/core/fixtures`, so WS3
      works against real IPC before the database exists.
- [ ] Executor in `packages/engine` (ARCHITECTURE.md → Engine semantics) with tests on fake blocks:
      topological order per workplace, merge per input port, splitter fan-out, inner workplaces via
      boundary blocks, failure → downstream `skipped`, cancel via `AbortSignal`.
- [ ] HIL block (`packages/blocks/src/hil/`): pause → run `waiting_for_review`; `runs.resume` re-runs it with `ctx.resumed`.
- [ ] `runs.start/get/list/blockOutput/resume/cancel` handlers; push every change via `IPC_EVENTS.runUpdate`;
      wire `BlockContext` (llm, web, files, audit, `car.add`).
- [ ] SQLite in `packages/db` (`node:sqlite`): versioned requirements, append-only audit log,
      `requirements.edit/decide`, `exports.requirements` (JSON / CSV / Markdown via the save dialog).
- [ ] API keys: `settings.secrets` / `settings.setSecret` with Electron `safeStorage`.
- [ ] Extend `apps/desktop/src/main/smoke.ts` for each new capability (e.g. save a flow, restart, reload it).

**Log**

## WS2 — Data Flow editor UI

**Status:** open · **Owner:** — · **Branch:** —
**Depends on:** WS1 for save/load and runs. Tasks 1–3 can start now.

**Tasks**

- [ ] Undo / redo (⌘Z / ⇧⌘Z) in `components/dataflow/store.ts`: history of `root` snapshots, with tests.
- [ ] Copy / paste / duplicate blocks (⌘C / ⌘V / ⌘D): fresh ids for the block and everything in its
      inner workplace, edges between copied blocks kept; tests.
- [ ] "New from template": load `api.templates.list()` → `BMW_DEFAULT_TEMPLATE` onto the workplace
      (confirm before replacing a non-empty flow).
- [ ] Save, load and autosave with `api.workflows.*`; show unsaved changes; flow name in the header.
      Until WS1 lands, show the `not_implemented` state instead of failing silently.
- [ ] Problems view: run `validateGraph` plus "input not connected" / "Raw block has no file" checks and
      mark the affected blocks.
- [ ] Run button and live status on every block (`api.runs.start`, `api.runs.onUpdate`): status dot,
      counts, logs; a "waiting for review" banner linking to the Car tab. Mock with `fixtureRun` until WS1.
- [ ] Output inspector: click a finished block → `api.runs.blockOutput()` per port.
- [ ] Polish: "Tidy up" auto-layout, multi-select actions, minimap colours per block group.

**Log**

## WS3 — Car tab: requirements review & audit UI

**Status:** open · **Owner:** — · **Branch:** —
**Depends on:** nothing to start: build on `@reqflow/core/fixtures` (5 requirements, findings, sources,
audit events), then switch to `api.requirements.*` / `api.audit.list` as WS1 serves them.

**Tasks**

- [ ] Requirements on the Car tab, grouped by ranking (Must / Should / Could / Won't), with the car
      visual kept as the header; filters (category, status, evidence level) and sort by score.
- [ ] Requirement detail (drawer or route `/car/:id`): description, measurable targets, score breakdown
      (factor × weight with notes), priority and rationale, evidence level badge, assumptions,
      uncertainties, conflicting findings.
- [ ] Evidence drill-down: requirement → findings → verbatim excerpts → source (kind, reliability, link).
- [ ] Decision bar: approve / reject / defer / challenge, rationale required → `api.requirements.decide`.
- [ ] Inline edit with rationale → `api.requirements.edit`; version history per requirement.
- [ ] Audit timeline (global and per requirement) from `api.audit.list`, before → after diffs, filters.
- [ ] Export button → `api.exports.requirements` (JSON / CSV / Markdown).
- [ ] Add Car-tab steps to `npm run smoke` (propose the diff to WS1/WS0 in your log).

**Log**

## WS4 — Settings, app shell & packaging

**Status:** open · **Owner:** — · **Branch:** —
**Depends on:** WS1 for tasks 1–2.

**Tasks**

- [ ] Once WS1's `settings.save` lands: confirm settings survive a restart, remove dead "not saved" paths.
- [ ] API keys in Settings → AI & research: set, replace and remove via `api.settings.setSecret`; show
      only whether a key is configured, never the key.
- [ ] App icon in the M colorway (`apps/desktop/build/icon.icns`, `icon.ico`, `icon.png` 512 px).
- [ ] `npm run package` on macOS, Windows and Linux; fix what breaks; document install steps in README.
- [ ] Optional: GitHub Actions matrix (macOS, Windows, Ubuntu) running `npm run check` and
      `npm run smoke` (`xvfb-run` on Linux).
- [ ] Demo polish: keyboard-shortcut overview, consistent empty states, About screen with team names.

**Log**

## WS5 — Raw block (BMW data ingestion)

**Status:** open · **Owner:** — · **Branch:** —
**Depends on:** WS1 `files.import` for the UI path; parsing and tests can start now.

**Tasks**

- [ ] Synthetic sample files in `data/samples/` that mimic BMW's formats (customer feedback, equipment
      take rates, sales volumes, customer study). Synthetic only, never real data.
- [ ] Parser: `.xlsx` / `.csv` → `Source` + `SourceRecord[]` with row locators and language. Add the
      parsing library to `packages/blocks/package.json` only.
- [ ] `raw` implementation in `packages/blocks/src/raw/` honouring `source`, `dataset`, `file`, `sheet`;
      errors name the bad row or column; nothing is dropped silently.
- [ ] Deterministic `usage_pattern` findings from structured datasets (take rates, volumes), with evidence.
- [ ] Database source (params exist): read-only SQLite/Postgres if time allows; never store passwords in params.
- [ ] When BMW's data arrives in `data/raw/`: adapt the mappings and describe the formats in your log (no data in git).

**Log**

## WS6 — Research block

**Status:** done — raw Research slice; live access unverified · **Owner:** OpenCode (Jonas) · **Branch:** `ws6-research`
**Integration:** typed `ctx.research` collector, main-process provider/secret runtime, existing workflow executor and native GUI. Shared/main/UI changes authorized by the human for this slice.

**Tasks**

- [x] Thirteen raw-only agents with real Mastra query-planner instances and explicit paid-planning opt-in; configurable vehicle/generation/market/language/date scope.
- [x] Firecrawl originals and optional Tavily alternative; YouTube, Reddit OAuth, X recent/archive, fixed approved Apify actors, OpenAlex, Eurostat and local documents. No automatic paid fallback; legacy Claude web search reports unsupported.
- [x] Verbatim records, tables, explicit metadata, unknown attribution and linked provenance; no inferred reliability, classifications, requirements or human decisions.
- [x] Authoritative domain policies, unique-result/shared-request budgets, retry/cancel/partial preservation, deduplication and shared BMW document cache.
- [x] Research APIs & Zugänge Settings, main-only encrypted secrets, typed IPC, persistence/audit, workflow run controls and JSON/XLSX/CSV exports with formula/overflow/Unicode protection.
- [x] Offline synthetic tests, independent code/security review corrections, root checks, native and packaged macOS smoke, screenshot inspection and research documentation.

**Log**

- 2026-10-10: Pulled/rebased latest main (b1dae4f). Human expanded WS6 to the 13 raw-only research agents,
  Research API Settings, secure secrets, workflow integration and JSON/XLSX export, and authorized the
  necessary shared-contract/main/UI changes ("mach einfach"). Shared schemas and adapter contracts defined
  before parallel implementation. Existing untracked `* 2.*` files are user work and remain untouched.
  No live provider tests or confidential-data access authorized. Next: provider adapters and integration.
- 2026-10-10: Completed parallel provider/UI/executor/planner slices and parent integration. Fixed independent review findings, including concurrent state races, secret reload, Off/domain/budget enforcement, paid-actor cleanup and XLSX/JSON resource amplification. `npm run typecheck`, `npm test` (36 files / 991 tests), `npm run check`, `npm run smoke` pass. Native and unsigned packaged macOS arm64 smoke each pass 17 screenshots / 69 research checks, including real ASAR-unpacked Worker import and JSON/XLSX/CSV export with zero provider calls. `npm audit`: 12 moderate, zero high/critical; remaining advisory chains documented. No real keys/BMW data/Docling conversion or Windows/Linux native execution verified. No commits made; user duplicates and Entire hooks preserved. See [research README](research/README.md) and [verification](research/verification.md). Next: authorized live credentials/budgets/permissions, optional local Docling provisioning, other-platform verification and downstream workstreams.
- 2026-10-10: Human requested Git/Entire publication. Enabled automatic checkpoint pushing in project and local Entire settings; existing Git, Claude Code and OpenCode hooks pass `entire doctor`. Current Research session is attached to `ws6-research`. Pre-commit `npm run check` passes again (991 tests); publication uses plain Git and its automatic checkpoint trailer.
- 2026-10-10: Fixed the human-reported `npm run dev` load error: Vite had eagerly resolved `ws`'s optional native addons. Narrowly externalized `bufferutil` and `utf-8-validate` to retain their guarded JavaScript fallbacks. Actual dev UI/IPC pass; `npm run check` passes 37 files / 992 tests. Rebuilt native and packaged smoke both pass 17 screenshots / 69 checks; actual dev/production/ASAR WebSocket helpers pass 64/65-byte and UTF-8 fallback probes with addon opt-out flags unset. Restart an already-running dev process to load the corrected build configuration.

## WS7 — AI blocks: AI Filter, AI Splitter, Add to Car

**Status:** open · **Owner:** — · **Branch:** —
**Depends on:** nothing for tasks 1–2; WS8 for the splitter's priority mode.

**Tasks**

- [ ] `packages/llm`: `createLlmClient(settings.llm, { apiKey })` with an `anthropic` provider (use the
      `claude-api` skill) and a deterministic `mock`; `generateObject` validates with Zod; tests use the mock.
- [ ] AI Filter: keep items matching the criterion, extract findings with verbatim-excerpt
      verification, log every excluded item with a reason.
- [ ] AI Splitter: route each item to exactly one branch (`out-<i>`); "priority" uses WS8's scoring,
      "category" / "sentiment" / "custom" use the LLM.
- [ ] Add to Car: cluster and derive requirements (IDs via `formatRequirementId`, targets, evidence level
      A–D, Kano class, assumptions, uncertainties, conflicts), priority from the input port, hand them to `ctx.car.add`.
- [ ] `answerChallenge(...)` for the Car tab's challenge flow.
- [ ] End-to-end offline test: fixture records → AI Filter → AI Splitter → Add to Car with `mock`.

**Log**

## WS8 — Prioritization

**Status:** open · **Owner:** — · **Branch:** —
**Depends on:** nothing; agree the function signature with WS7 in your log.

**Tasks**

- [ ] Deterministic factors in `packages/blocks/src/prioritization/`: customer impact, evidence
      strength, competitive gap, trend momentum, each with a one-line note.
- [ ] LLM-judged factors (brand fit, ease) behind `LlmClient`, one-line note each; mock in tests.
- [ ] `priorityRationale` naming the top drivers; flag "high score, weak evidence".
- [ ] Tests: reproducible scores on the fixtures; changing Settings weights changes the ranking as expected.
- [ ] Export the function the AI Splitter's priority mode calls (`weightedTotal` + `priorityForScore`).

**Log**

<!--
Template for your section (replace the "open" line, keep log entries newest-first):

**Status:** in progress · **Owner:** <agent tool + who started it> · **Branch:** ws<N>-<slug>

Log entry:
- YYYY-MM-DD HH:MM: what changed · how to verify (command) · what's next
- Blocked by / needs: …
- Contract change request for WS0: …
-->
