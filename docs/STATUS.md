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
  delete with confirmation. Templates load full workflows; Start saves the graph and runs it with
  live status/logs, cancellation and explicit human-review pauses. Editor autosave/load UI remains open.
- **HIL block (finalized):** double-click opens the review report: a flow chart of how the data was
  collected (lineage across inner workplaces) and a table icon on every step to see the data there
  (a Raw step's own data, a HIL's connected Raw inputs, or the saved run; no demo data). Single-reviewer
  gates pause execution until explicit review/continue. Selected-point PDF export is a format check,
  not an approval; upstream splitter reports expose evidence and audited human routing corrections.
- **Raw block (built, WS5):** reads `.xlsx` (any sheet), CSV (`,` `;` tab, UTF-8 or Windows-1252, German
  number formats) and read-only SQLite queries into one source + one record per row, with
  deterministic usage findings from take rates and sales volumes. "Choose file…" opens the native
  dialog (`files.import`); "Preview data" in the inspector and the HIL report show the real parsed
  data (`blocks.preview`). Synthetic samples in `data/samples/`. Also reads BMW's real exports
  (feedback, customer studies, sales volumes; see the WS5 log for their shapes) when they're in
  `data/raw/`; the PDF option list is refused for now.
- **Car:** 3D car with every requirement from Add to Car placed on a part (WS3); **Reset** removes
  all requirements (audited, ids never reused). Agent-generated requirements expose confidence and
  the recorded thought process. Exterior/interior transitions are reversible. No demo data: the car
  is empty until a flow runs. Compact cards open full evidence/requirement details; the 105-entry
  schematic catalog and four powertrain choices are integrated. Catalog visualization choices do
  not change requirement scope or decisions; powertrain selection persists through Settings.
- **Settings:** App, Global parameters, AI & research, Collaboration, About. Changes are validated and
  apply live (theme, grid, minimap) and persist. Default AI supports Anthropic/OpenAI/Google/mock;
  agent roles can use separate API setups. Research APIs expose configuration, approval and tests.
  Credentials stay in the main process and require OS-backed encryption, never plaintext fallback.
- **Contract:** domain schemas, block specs (`core/src/blocks.ts`), graph rules (`core/src/graph.ts`),
  IPC API, scoring formula, synthetic F70 EU fixtures, block registry, default template.
  Built blocks: Raw, Research, HIL, AI Splitter and Add to Car agents. Shared execution kernel and
  SQLite persist runs, outputs, requirements, reasoning, research provenance and audits. Research
  imports original local documents and has configured network adapters; native smoke runs offline.
  AI Filter and remaining demo/review UI tasks are still open; live-provider verification is separate.
- Repo is public, and Entire is enabled (checkpoints are pushed with every `git push`).

## Open questions for the humans

- Demo scope: **1 Series (F70) · EU · 5 years** (decided 2026-10-10: BMW's data is for the F70).
  Today's F70 has combustion engines only. Should range and charging be in scope for the successor?
- BMW datasets: received 2026-10-10, local only in `data/raw/` (gitignored, also by file name).
  **Transcripts are public:** inspect them with scripts that print structure and counts, never values.

---

## WS0 — Lead / integrator

**Status:** review (Analytics integration tests verified; latest native smoke incomplete) · **Owner:** OpenCode (Analytics integration) · **Branch:** `analytics-and-timeline`

**Tasks**

- [ ] Review and merge PRs (merge commits, never squash); keep `main` green with `npm run check && npm run smoke`.
- [ ] Apply contract-change requests from the sections below (`packages/core`, block params and ports).
- [ ] Integration: run `BMW_DEFAULT_TEMPLATE` end to end with the `mock` LLM, then with Claude and the real data.
- [ ] Demo script and rehearsal (PRODUCT.md → Demo scenario); keep PRODUCT.md and this file current.
- [x] Complete the interrupted 2026-10-11 branch integration, preserving merge history and the human-authorized Car cutoff; verify with synthetic tests and native smoke.
- [x] Apply corrected exclusions and integrate every remaining newer remote branch, keeping only `integrate-mastra-judge`, `quick-ai-results`, `ws1-blocks` and `ws1-engine` unmerged.

**Log**

- 2026-10-11: Human requested merging completed Analytics into main through PR #19 and launching locally. Integrated main through `85d3d36`, preserving PDF ingestion, splitter car-part depth, AI Filter decisions, provenance reports and the grey-line Car transition. Resolved product-table conflicts by keeping all block descriptions; kept main's equivalent Reset-ready wait in smoke and both Analytics-open and AI Filter-report buttons on block nodes. Latest combined code passes `npm run typecheck`, `npm run format:check` and `npm test -- --maxWorkers=2 --testTimeout=30000` (2,698 passed, 6 skipped). Native macOS smoke passed before the final main refreshes (82 screenshots); refreshed-code smoke remains incomplete: one run hung in later Settings checks and a fresh isolated run exited before writing its final report (78 screenshots), so neither is claimed as passing. Inspected Analytics overview, timeline, topics, source comparison, flow, quality and preserved grey-line Car interior. Synthetic-only checks; no BMW values, live providers or credentials used. The separate `reqflow/` checkout's uncommitted Car work is untouched. Launch uses merged main in this clean checkout; human authorized replacing the existing app instance. Windows/Linux remain unverified.
- 2026-10-11: Synthetic 100-row F70 feedback fixture delivered as XLSX/CSV in `data/samples/f70-feedback-test.*`, with reproducible generator and `docs/f70-feedback-test.md`. Exact original sheet/header structure only; no BMW cell values used. Ten synthetic regression cases verify 97 ingested records, all six splitter modes, HIL pause/resume, seven proposed offline categories and actual classifier placements. `npm run typecheck` passes; synthetic-only suite passes (2,329 tests, 21 skipped) with two workers/15s timeout after parallel contention timed out two unrelated tests. Real BMW tests excluded; no live AI calls or UI changes. Concurrent PDF-ingestion work preserved. Guide distinguishes actual mock limitations from ten desired live-AI needs.
- 2026-10-11: Publishable snapshot including the latest Car class/feature adaptation passes `npm run check` (2,307 tests, 5 skipped) and native macOS smoke (70 screenshots). Inspected final M5 baseline, catalog selection/restoration, compact details and light/dark views. All ready remote branches are included; only the four old experiment branches and human-excluded Analytics WIP stay out. No live providers, credentials or BMW files used in verification; Windows/Linux remain unverified.
- 2026-10-11: Final remote refresh found Car follow-up `db64757` (class-aware features and M5 baseline) and newly published `analytics-and-timeline`. Car follow-up is included. Analytics is not buildable: five engine modules are missing and its chart tabs are placeholders. Human explicitly chose to publish ready branches and leave Analytics to its author. Ready integration is isolated at `integrate/ready-2026-10-11`; the attempted Analytics merge remains on `integrate/2026-10-11`, not on main. Final exclusions are the four old engine/judging experiments plus Analytics WIP.
- 2026-10-11: Final corrected integration verification: `npm run check` passed (2,298 tests, 5 skipped); `npm run smoke` passed on macOS with 70 screenshots. Inspected catalog selection/restoration, four powertrain views, compact details and light/dark screenshots. Ready to promote to main; no excluded experiment history included.
- 2026-10-11: Corrected integration includes `ws3-compact-requirements`, `ws4-car-models`, `codex/car-model-refinements`, `ws3-compact-requirements-entire` and `ws3-exterior-session-log`, with their full merge histories. Only the four old engine/judging experiment branches listed in the task remain unmerged. Retained audited Reset, agent confidence/Why, Research and HIL PDFs, reversible flight, collapsed menu-driven markers and 105-model catalog. Settings `hydrogen`/`fuel` values map to catalog `h2`/`gasoline`, sharing one persisted choice across both Settings screens and Car. Tests and native smoke cover reload, four powertrains, scope/decision preservation, compact evidence details and catalog switching. Synthetic-only checks; no real data/credentials/provider calls. Windows/Linux remain unverified.
- 2026-10-11: Human clarified exclusions: only `integrate-mastra-judge` and older Alexander experiments stay out. The earlier Car-animation cutoff was a misunderstanding and is superseded. Integrating all remaining newer branches: compact requirements/105-model catalog, Car refinements, saved car-model settings and their handoff branches. Preserve current agents, Research, HIL exports and human-only decisions; verify offline in the isolated worktree.
- 2026-10-11: Integrated Add to Car agents, Mastra splitter, Research/AI providers (including its Research ancestor), sampled HIL PDF, and `ws3-car-view-animation`. Existing WS1/WS2/older splitter branch tips are already ancestors. Excluded later Alex branches: `codex/car-model-refinements`, `ws3-compact-requirements`, `ws3-compact-requirements-entire`, `ws3-exterior-session-log`, `ws4-car-models`. Superseded parallel engine/judging experiments remain excluded: `ws1-blocks`, `ws1-engine`, `quick-ai-results`, `integrate-mastra-judge`. Resolved shared executor, secrets, provider, report and IPC conflicts without dropping human routing correction or agent setups. Native smoke now clears the actual preceding scenario canvas and queues its synthetic document. `npm run check` and `npm run smoke` passed; 51 screenshots and sample PDFs inspected. No live provider calls, real credentials or BMW files used. Local merge history only; not pushed. Windows/Linux and real-provider evaluation remain unverified.
- 2026-10-11: Continuing the unfinished integration worktree. Preserve merged Add to Car agents and Mastra splitter, finish Research/AI providers, then merge HIL PDF and Car changes through `ws3-car-view-animation` only. Later Alex Car branches are explicitly excluded; obsolete engine/judging experiments are not reintroduced over their replacements. Synthetic-only verification, no credentials or BMW data inspected.
- 2026-10-10 night: **Removed all demo data from the app** and added **Reset** on the Car page
  (branch `ws0-remove-demo-data`). The database is no longer seeded; on start, `removeDemoData`
  (`packages/db/src/demo-data.ts`) deletes rows earlier builds seeded (exact fixture ids and the demo
  run id only). Gone: the Car page's "Synthetic sample" source, the HIL report's sample button
  (`report/sample.ts`) and the unused `fixture-service.ts`. Fixtures stay for tests (`seedFixtures`,
  tests only). New `requirements.reset()`: removes every requirement, writes one
  `requirement.deleted` audit event each, and ids are never reused (`nextSeq` also counts ids in the
  audit trail). Tests and smoke make real requirements with Raw → Add to Car on a tiny synthetic CSV.
  Verify: `npm run check && npm run smoke` (screens `car-reset-confirm`, `car-after-reset`).
- 2026-10-10 night: Demo scope switched to the 1 Series F70 · EU (default settings, fixtures renamed to
  `sample-f70-eu.ts` with `REQ-F70-EU-…` ids, docs). `data/samples/` stays 5 Series on purpose: it
  tests the parser, and a second series shows the Raw block isn't tied to one car.
- 2026-10-10 night: Did WS5 (Raw block) in this session, see the WS5 section. Also built two WS1 pieces
  it needed: `files.import` with a file store (`packages/db/src/files.ts`) and `blocks.preview`.
- 2026-10-10 night: Finalized the HIL block (t/f/1/1): `core/src/lineage.ts` (`traceLineage`), review
  report UI (`components/dataflow/report/`), runtime in `packages/blocks/src/hil/hil.ts`. PRODUCT.md
  now lists every block's spec and state. Verify: `npm run check && npm run smoke`.
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

**Status:** done · **Owner:** OpenCode (Gemini 3.8 Flash) · **Branch:** ws1-main
**Unblocks:** everyone. Do tasks 1–4 first; they are small and make the UIs real.

**Tasks**

- [x] `settings.get` / `settings.save` in `apps/desktop/src/main/`: one JSON file in the data dir, written
      atomically (temp file + rename), validated with `Settings`; on load, fill sections missing from older
      files with `DEFAULT_SETTINGS`. Done when the Settings page's "not saved" banner disappears and a
      change survives a restart (add a test for the load/merge/save logic).
- [x] `workflows.list/get/save/remove`: store the block tree; `save` assigns a `wf_…` id, bumps
      `version`, sets timestamps and rejects graphs where `validateGraph` reports issues
      (`invalid_input` with the issues as details).
- [x] `files.import()` + file store (`packages/db/src/files.ts`), done in the WS5 session: native
      dialog (`.xlsx`, `.csv`), copy into `<dataDir>/uploads/`, ids validated against path tricks.
- [x] `blocks.preview` (`apps/desktop/src/main/preview.ts`): runs a block without inputs on its own.
- [x] Read-only `requirements.list/get` and `audit.list` serving `@reqflow/core/fixtures`, so WS3
      works against real IPC before the database exists.
- [x] Executor in `packages/engine` (ARCHITECTURE.md → Engine semantics) with tests on fake blocks:
      topological order per workplace, merge per input port, splitter fan-out, inner workplaces via
      boundary blocks, failure → downstream `skipped`, cancel via `AbortSignal`.
- [x] HIL block implementation (`packages/blocks/src/hil/hil.ts`, done by WS0): pauses with a message, passes data on when `ctx.resumed`.
- [x] Executor support for HIL: `{ status: "paused" }` → run `waiting_for_review`; `runs.resume` checks the
      required approvals and re-runs the block with `ctx.resumed = true`.
- [x] `runs.start/get/list/blockOutput/resume/cancel` handlers; push every change via `IPC_EVENTS.runUpdate`;
      wire `BlockContext` (llm, web, files, audit, `car.add`).
- [x] SQLite in `packages/db` (`node:sqlite`): versioned requirements, append-only audit log,
      `requirements.edit/decide`, `exports.requirements` (JSON / CSV / Markdown via the save dialog).
- [x] API keys: `settings.secrets` / `settings.setSecret` with Electron `safeStorage`.
- [x] Extend `apps/desktop/src/main/smoke.ts` for each new capability (e.g. save a flow, restart, reload it).

**Log**

- 2026-10-10: Completed all WS1 tasks: atomic settings persistence with default fallback; workflow block tree storage with `validateGraph` validation; workplace executor in `@reqflow/engine` (topological execution, multi-port merge, splitter fan-out, inner workplaces via boundary blocks, downstream failure skipping, HIL pause/resume, cancel); SQLite persistence in `@reqflow/db` (`node:sqlite`) with versioned requirements, append-only audit log, and block outputs; full IPC handlers in `main/handlers.ts` (`runs.*`, `requirements.*`, `settings.secrets`, `exports.requirements`); push updates via `IPC_EVENTS.runUpdate`; 108 unit tests pass across all packages; smoke tests passing with 19 screenshots.

## WS2 — Data Flow editor UI

**Status:** review · **Owner:** OpenCode (HIL sampled PDF report) · **Branch:** `feature/hil-sample-pdf-report`
**Depends on:** WS1 for save/load and runs. Tasks 1–3 can start now.

**Tasks**

- [ ] Undo / redo (⌘Z / ⇧⌘Z) in `components/dataflow/store.ts`: history of `root` snapshots, with tests.
- [ ] Copy / paste / duplicate blocks (⌘C / ⌘V / ⌘D): fresh ids for the block and everything in its
      inner workplace, edges between copied blocks kept; tests.
- [x] "New from template": load `api.templates.list()` → `BMW_DEFAULT_TEMPLATE` onto the workplace
      (confirm before replacing a non-empty flow).
- [ ] Save, load and autosave with `api.workflows.*`; show unsaved changes; flow name in the header.
      Until WS1 lands, show the `not_implemented` state instead of failing silently.
- [ ] Problems view: run `validateGraph` plus "input not connected" / "Raw block has no file" checks and
      mark the affected blocks.
- [ ] Run button and live status on every block (`api.runs.start`, `api.runs.onUpdate`): status dot,
      counts, logs; a "waiting for review" banner linking to the Car tab. Mock with `fixtureRun` until WS1.
- [ ] Output inspector: click a finished block → `api.runs.blockOutput()` per port.
- [x] HIL report with real data for steps that need a run: Raw steps already show their real data
      (`blocks.preview`); for the others, replace the "no run yet" state in
      `components/dataflow/report/DataPanel.tsx` with the step's data from the latest run (`api.runs.blockOutput`; for the HIL itself merge what
      its incoming edges carried with `mergePipelineData`). The synthetic sample was removed on 2026-10-10.
- [ ] Polish: "Tidy up" auto-layout, multi-select actions, minimap colours per block group.
- [x] Fix direct Raw → HIL report input preview (merged in PR #4 and verified).
- [x] Save and execute the current flow so Add to Car publishes proposed requirements; expose status, block logs and cancellation (PR #8).
- [x] Explicit Start button for the full workflow, including inner workplaces; prevent duplicate runs
      and preserve HIL pauses (PR #10, verified on merged main).
- [x] Continue single-reviewer HIL gates after explicit review of saved run inputs; reset confirmation per run/gate and preserve Start controls (PR #12).
- [ ] Merge sampled HIL PDF export and decision-brief report (implemented and verified on `feature/hil-sample-pdf-report`; not yet merged).

**Log**

- 2026-10-11: Sampled PDF export implemented in isolated `EHL-hil-report` worktree. HIL → choose step → Format-check PDF: defaults first 3 per dataset, editable checkboxes, maximum 15 total, first 50 candidates shown; native PDF save via validated `exports.hilReport`. Preserves original selected record text/fields and finding excerpts; includes scope/provenance, counts/omissions, routed/nested lineage, priority/score/targets, evidence gaps/conflicts and optional report-only PM action notes. No requirement decisions, resume or reviewer signatures added. Human authorized core IPC/main/shared-icon integration. Research mapping and future persisted-review proposals: `docs/hil-report-design.md`. Verified `npm run typecheck && npm test` (280 passed, 25 skipped), desktop smoke (native sample + rich management PDFs, 35 screenshots), changed-file Prettier and `git diff --check`; inspected PDFs and light/dark/minimum viewport screenshots. No dependencies or real BMW data used. Changes remain uncommitted/unpushed for review; other WS2 tasks remain open.
- 2026-10-11: Claimed the HIL sampled-PDF report slice in an isolated worktree from main. Human authorized the narrow core IPC/main-process changes needed for native PDF export. Preserve existing review/resume semantics, export only explicitly selected data points, and distinguish format validation from complete evidence review. Use synthetic data only for verification; leave concurrent Add-to-Car work untouched.
- 2026-10-10: Blocks/Templates switch and full-workflow setups merged in PR #15. Integrated current Car refinements unchanged and reverified: `npm run check` (277 passed, 10 skipped), `npm run smoke` (29 screenshots), and native synthetic template loading/replacement plus both connected workflows, explicit PM review, Car publication, and light/dark/minimum-window screenshots. Requested slice complete; WS2 released. Use Templates → Use template, configure inputs, then Start; BMW's full setup remains an explicitly labelled blueprint until its Research/AI Filter prerequisites land.
- 2026-10-10: Blocks/Templates sidebar implemented. Two connected setups (Feedback to requirements: Raw → HIL → Car/Should; Prioritized feedback: Raw → priority Splitter → three PM gates → Car rankings) plus `templates.list()`'s BMW successor blueprint, labelled as requiring Research/AI Filter support. Loading validates/clones the full graph with fresh canonical boundary/edge ids, resets inner navigation/selection/report/measurements and old run/workflow identity, preserves the template name on save, confirms replacement, and blocks active/paused runs. Added 15 regressions. `npm run check`: 273 passed, 10 skipped; `npm run smoke`: 29 screenshots. Native synthetic probe verified view switching, replacement accept/cancel, nested-to-root loading, shared BMW graph, no auto-run, blocked replacement at HIL, named workflow saves, proposed-only Car publication, and prioritized execution with the offline mock. Light/dark and 1024×640 screenshots inspected: `workflow-template*` in `apps/desktop/out/smoke/`.
- Request for WS1/WS0: add sidebar switching, template confirmation and configured template execution to the shared smoke runner. Next: save/load/autosave and undo/redo remain separate tasks. No core, main, engine, block or dependency changes.
- 2026-10-10: Adding a Blocks/Templates switch to the Data Flow sidebar, two connected feedback/review/prioritization setups, and the existing BMW successor blueprint from `templates.list`. Templates replace the entire canvas only after confirmation, with fresh ids and no automatic execution/approval. Scope: WS2 renderer and synthetic regressions; no backend, core or block changes.
- 2026-10-10: HIL fix merged in PR #12 with the Start-button integration preserved. Verified integrated code: `npm run check` (258 passed, 10 skipped), `npm run smoke` (29 screenshots), and native Raw → HIL → HIL → Add to Car with two explicit confirmations, saved data unaffected by source mutation, and proposed-only publication on the Car. Requested slice complete; WS2 released. Multi-reviewer/reviewer-record and restart-recovery limits below remain WS1/WS0 follow-ups.
- 2026-10-10: Human authorized integration with the concurrent Start-button slice. Preserved Start/play icon, its full-workflow and safety-state labels, all existing tests/logs, and stale-active-update protection; extended that protection to resume events/replies with another regression. Backend Add to Car evidence storage and non-reused ids were also integrated unchanged from main. Reverified: `npm run check` passed (258 passed, 10 skipped), `npm run smoke` passed (29 screenshots), and native sequential-HIL review passed again with a proposed requirement visible on the Car.
- 2026-10-10: HIL review/resume implemented and verified. Waiting runs expose Review paused step; reports use the frozen run graph and persisted per-port outputs, including merged HIL inputs. Continue flow needs loaded target data plus an explicit checkbox and calls existing `runs.resume` for that exact run/gate only. Confirmation resets per run/gate; errors remain visible; resumed work can be cancelled. Added 13 regressions: `npm run check` passed (240 passed, 10 skipped); `npm run smoke` passed (29 screenshots). Native synthetic Raw → HIL → HIL → Add to Car probe confirmed each gate separately, kept original review data after source mutation, checked two pause/resume audit events and proposed-only publication, and found the requirement on a Car card. Screenshots inspected: `hil-review-gate-{1,2}.png`, `hil-resumed-car.png` under `apps/desktop/out/smoke/`.
- Remaining HIL limits for WS1/WS0: multiple required reviewers are explicitly blocked in this UI (no fake extra approvals); reviewer identity/role enforcement and per-review rationale require backend review records. The existing engine logs pause/resume events, but this UI does not claim those are separate reviewer-signature records. Resuming after app restart still depends on WS1's in-memory paused-state recovery. Request shared smoke coverage for the human checkbox → resume → Car path. No core, main, engine or block files changed.
- 2026-10-10: Fixing HIL getting stuck: expose the paused gate's run-snapshot report, load persisted input data (not re-read files or samples), and require explicit human review before existing `runs.resume`. Single-reviewer gates supported; do not bypass multi-reviewer gates or set requirement decision statuses. Scope: WS2 renderer/report and synthetic tests only.
- 2026-10-10: Start-button slice merged in PR #10 (`5663120`) and reverified on integrated main:
  `npm run check` (228 passed, 24 skipped), `npm run smoke` (29 screenshots). WS2 released for
  its remaining checklist (per-node status/counts, save/load/autosave, run outputs and human review/resume).
  Explicit **Start** button replaces Save & run, with a play icon, full-root/inner-flow
  explanation, disabled empty/starting/running/HIL states and visible progress labels. Kept existing
  IPC execution, cancellation and human-review pause. Stale active fetches/events no longer regress
  terminal run status; recovered live updates clear catch-up errors. Added 15 regression cases.
  Verify: `npm run check` (228 passed, 24 real-data tests skipped) and `npm run smoke` (29 screenshots;
  light/dark Start inspected). A synthetic-only isolated native button probe passed Raw → Custom
  (boundary passthrough) → Add to Car while inside Custom: one run after a double click, the complete
  root snapshot, all blocks succeeded, one proposed requirement. Raw → HIL → Add to Car paused without
  publishing, blocked restart, then cancelled. Tab catch-up also passed. Inspected
  `apps/desktop/out/smoke/start-{inner-completed,hil-paused,cancelled}.png`.
  WS1/WS0 request: promote these actual Start-button scenarios into the shared `main/smoke.ts` runner;
  its current run checks bypass the renderer button. No main/core/product changes required.
  Setup note for WS0: generated `.opencode/plugins/entire.ts` was formatted to pass the repo gate;
  Entire's hash check now warns hooks are out of date, though the hook logic is unchanged. Add this
  managed file to the root formatting ignore list before regenerating it with `entire enable --force`.
- 2026-10-10: Human activated a focused Start-button slice. Latest main already has Save & run;
  make full-workflow execution explicit with a Start button and verify its safety states and native
  execution. Working in an isolated worktree; the original checkout's documentation edits are untouched.
  Scope: WS2 renderer paths and this section only, plus the required generated Entire hook.
- 2026-10-10: OpenCode's execution/publication fix merged in PR #8. Reverified integrated main after the concurrent AI Splitter/LLM updates: `npm run check` passed (227 passed, 10 skipped), `npm run smoke` passed (29 screenshots), and the isolated native Raw → Add to Car → Car-card probe passed again. Requested slice complete; WS2 released for remaining tasks (per-node status/counts, save/load/autosave, report run outputs, review/resume).
- 2026-10-10: Add to Car publication fixed and verified. Data Flow now has Save & run, snapshots the full graph/scope, starts via IPC, displays live run status and block logs, cancels explicitly, and catches up after switching tabs. Added 8 run-state tests and a schema-valid creation-audit regression. `npm run check`: 158 passed, 10 skipped; `npm run smoke`: 26 screenshots. Native synthetic Raw SQLite → Add to Car probe stored one proposed requirement and verified its actual id/title on a Car card; screenshots inspected in `apps/desktop/out/smoke/add-to-car-{run,overview}.png`.
- Remaining WS1/WS7 risks: the existing requirement-id reuse/upsert issue can overwrite earlier requirements on another run (see WS7's existing request). HIL resume still needs human-review enforcement and UI wiring; this slice deliberately does not auto-resume or approve anything. Request WS1/WS0 add a synthetic Raw → Add to Car run/Car-card assertion to the shared smoke runner. No WS3 or core files changed.
- 2026-10-10: Native Raw → Add to Car execution exposed a second blocker: creation audit events had an empty `changes.path`, rejected by `AuditEvent`. Human explicitly authorized the narrow WS7 fix (three paths changed to the root marker `$`) and a colocated synthetic regression; no other WS7 code or core contracts changed.
- 2026-10-10: Investigating Add to Car not populating the overview. The renderer has no run action: connections only edit the graph. Adding a save-and-run action, live run status and block diagnostics through existing IPC; staying within WS2, leaving WS3/WS7 changes untouched.
- 2026-10-10: OpenCode's direct-input report fix merged in PR #4. Rechecked integrated `main` after concurrent WS1/WS7 changes: `npm run check` passed (135 tests passed, 10 skipped), `npm run smoke` passed (19 screenshots). Narrow requested slice complete; releasing WS2 for its remaining tasks.
- 2026-10-10: Fixed the default HIL data view for directly connected source blocks. Exact output ports are merged in edge order, duplicate ids are de-duplicated, failures are visible, and stale responses are ignored. Processing blocks still require a run; real previews never fall back to samples. Verify: `npm run check` (99 tests, including 9 new report regressions) and `npm run smoke` (19 screenshots). Also drove Raw SQLite → HIL in an isolated native Electron instance: 3 real records shown on opening the report, screenshot inspected at `apps/desktop/out/smoke/hil-report-direct-raw.png` (synthetic data only).
- Request for WS1/WS0: extend `main/smoke.ts` with a direct Raw → HIL connection and assert real rows on the default HIL step, not only when selecting the upstream Raw step. Wait for ready data before capturing its screenshot. Existing smoke does not cover this direct-input regression.
- Next: remaining WS2 tasks, including wiring the report to stored run outputs now that WS1's executor has landed. No core changes needed for this direct-source preview fix.
- 2026-10-10: Investigating Raw → HIL report showing no data: the target HIL panel does not preview its connected inputs. Scope: report UI and synthetic regression tests; no executor or core contract changes.

## WS3 — Car tab: requirements review & audit UI

**Status:** in progress (four-choice model switcher) · **Owner:** Codex (model switcher subtask) · **Branch:** `ws3-compact-requirements`
**Animation slice:** review (implemented and verified) · **Owner:** OpenCode · **Branch:** `ws3-car-view-animation` (isolated worktree)
**Grey-line transition slice:** done (implemented and verified) · **Owner:** OpenCode · **Branch:** `ws3-grey-line-transition` (isolated from latest main)
**Windscreen slice:** review (implemented and verified) · **Owner:** OpenCode · **Branch:** `ws3-car-view-animation`
**Option provenance slice:** done (main integration verified; PR #23) · **Owner:** OpenCode · **Branch:** `integrate/car-option-provenance`
**Default-preview slice:** review (orbit optimization verified; full-smoke failures below) · **Owner:** OpenCode · **Branch:** `ws3-m4-default-preview` (isolated from latest main)
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
- [x] 3D car (5 Series G60 proportions, pure line sketch: no paint, no shading): orbit / zoom,
      camera presets, exterior / interior view, 34 clickable parts, badges with counts, the part's
      requirements in a side panel.
- [x] Auto classifier: assign every requirement to a car part (explainable: matched terms, confidence).
- [ ] Requirement detail / drill-down from a card on the car (the list tasks above).
- [ ] PM override of the auto-classified part (needs a contract field + audit event, WS0).
- [ ] Subtle blue fill on the clicked car part, with light/dark selection regressions.
- [x] Merge Car option provenance report: exact originating run/block, HIL-style lineage and saved step data, read-only build-workflow/inner-workplace visualizer (verified against current main; PR #23).

**Log**

- 2026-10-11: Optimized imported-model orbiting with an exact, indirect triangle spatial index for hover/badge raycasts. Source vertices, indices, normals, rendered geometry/materials and the assembled grey-line transition are unchanged; no LOD, decimation, pixel-ratio reduction or new dependency. Small/procedural/grouped meshes retain standard picking. Spatial leaves share source attributes, restore original triangle IDs/UVs/normals and honor live transforms, sides and near/far; dispose listeners and viewer teardown release the index. Seven regressions verify equivalence, reduced triangle scanning and cleanup. Root typecheck and all 2,790 tests pass (6 skipped); production build, formatting and 66 focused picking/fade/sketch tests pass. Native camera-motion benchmark with exterior markers: baseline median 50 ms/p95 416.7 ms, optimized median 16.7 ms/p95 17.6–33.3 ms (~20→60 FPS median on this machine, not a cross-device guarantee). Native probe passes 22 checks including real pointer orbit, all exterior review areas, light/dark, minimum size, grey-line interior/return and four powertrain reloads; exterior/interior screenshots reviewed. Initial full smoke was disrupted by a concurrent rebuild removing its renderer file. Clean final smoke completed 90 screenshots but failed fuel-canvas, catalog-switch and dark-marker assertions (also logged native GPU mailbox errors); not a smoke PASS. WS1/WS0 follow-up: investigate these full-run assertions and replace fixed reload/catalog delays with canvas/model readiness checks; isolated M4 readiness-based checks pass. Only CarViewer.tsx, model/acceleratedPicking.ts, its tests and this WS3 handoff changed; unrelated Entire edits excluded. Human requested push to main.

- 2026-10-11: Fixed existing installs restoring the former M5 default instead of the M4: migrate unversioned saved M5 selections once, persist the migration version, retain other saved models and preserve explicit later M5 choices. Powertrain and requirement scope are unchanged. Root typecheck and all 2,783 tests pass (6 skipped); production build and 70 focused store/fade/sketch tests pass. Native Electron probe seeds the legacy sedan before reload and verifies M4 startup/persistence, eleven exterior areas, light/dark, minimum size, assembled grey-line transition and all four powertrain reloads (21 checks). Exterior/interior screenshots reviewed. Full smoke completed 90 screenshots but failed four canvas checks immediately after reload: its fixed 900 ms delay precedes source-model readiness; later selection screenshots render correctly and readiness-based native checks pass. Not a full smoke PASS. WS1/WS0 follow-up: wait for car-canvas readiness at smoke.ts:1855–1862 instead of a fixed delay. Only vehicleStore.ts, its tests and this WS3 handoff changed; unrelated Entire edits excluded. Human requested rapid publication to main.

- 2026-10-11: M4 default and exterior review points complete: added ten sedan-style exterior areas (lights, bumpers, windscreen/rear glass, roof, mirrors, handles and boot), plus corrected the existing grille anchor. Paired points project onto exact source surfaces, respect camera occlusion and open the existing requirement review. Retained all source triangles, source-assembly picking, cabin, grey-line fade, saved choices and scope; no invented coupe rear doors. Root typecheck and all 2,768 tests pass (6 skipped); formatting/diff checks and production build pass. Native probe passes 17 checks including all eleven area anchors, light/dark, 1024×640 and interior/return; six screenshots reviewed. Full smoke attempts were incomplete: standard run exited after 81 screenshots; a clean-output run timed out at 120 seconds after 89 screenshots without its final report. Neither is a smoke PASS. No core/main/IPC, dependencies, packed profiles, credentials, private data or unrelated shared edits included. Ready for the human-requested direct push to main.

- 2026-10-11: Human expanded the default-preview slice to include sedan-style exterior subareas/points on this M4 before publication. Add surface-projected, paired review markers for lights, bumpers, glazing, roof, mirrors, handles and boot; retain exact imported geometry and existing source-assembly picking. No fictitious coupe rear doors, scope/decision changes or transition changes.

- 2026-10-11: Default preview now selects the existing imported 2025 BMW M4 Competition (`bmw_m4_competition_2025`) and places it first in the catalog. Saved selections, requirement scope, basic-M5 conversion protection and grey-line transition are unchanged. Initial default-only root typecheck and 2,762 tests passed (6 skipped); isolated native preview probe passes fresh source-model startup, interior/exterior return and unchanged scope without renderer errors. Reviewed both `out/smoke/m4-default-preview/` screenshots. Production build passes. Initial full native smoke aborts during earlier workflow/filter scenarios after 35 screenshots without completing its report; not a smoke PASS. No core/main/IPC, geometry, dependency, private-data or credential changes; generated Entire-plugin edits excluded. Human requested direct push to main.

- 2026-10-11: Claimed the human-requested 2025 BMW M4 Competition default preview and direct publication to main. Use the existing imported G82 geometry; preserve saved model choices, requirement scope, the basic M5 and grey-line interior transition. Isolated from unrelated shared-checkout changes.

- 2026-10-11: Human requested standard-model interior visuals for imported cars and authorized Luna/max subagents and publication to main. All 75 imported cars now combine their unchanged exact-source exterior with the existing dimension-scaled standard cabin/chassis and selected exploratory powertrain. Removed source cabin occluders and duplicate G60 exterior lines; retained assembled source shell lines, grey-line fade, credits and the basic M5. Menus match rendered parts and separate exterior/interior badge anchors preserve selection. Roadsters and single-seat race cars also omit the cushions, headrests and belts associated with excluded seats. Verified root typecheck, 2,760 tests passed (6 skipped), formatting/diff checks, and a focused native probe (44 checks, 9 screenshots reviewed: standard/imported interiors, selection, light/dark, H2, rapid reversal, Z4/GT3 seating and basic-model restoration). Packed source geometry files are unchanged. The final isolated full native smoke passed all 91 screenshots with no reported errors, including native persistence/research checks; earlier attempts hit a ResizeObserver notification or exited before their report completed. No core/main/IPC changes, credentials, raw archives, private BMW data or unrelated shared-checkout changes included.

- 2026-10-11: Human authorized publishing the isolated source-car converter to main. Integrated 75 exact-source BMW meshes, lazy metadata/geometry loading, supported-part menus, credits and offline glTF/GLB/OBJ/STL + atomic catalog conversion tools. Preserved the basic M5 and main's approved grey-line exterior fade; excluded unrelated local body/startup changes. Another 29 source downloads remain blocked by Sketchfab's daily quota. Verified on current main: root typecheck, 2,751 tests passed (6 skipped), root format check, production build, and a focused native source-car probe (22 checks; exterior/interior, rapid fade reversal, light/dark, 105 entries and basic-M5 restoration), with screenshots reviewed. All 75 profile files match the independently verified local assets (30,098,862 drawn triangle vertices, maximum error 0.135 micrometres). Standard native smoke was attempted twice but exited during unrelated Settings scenarios without completing its report (71/61 screenshots); full-app smoke is not claimed as passing. No credentials, raw archives, private BMW data or unrelated local work included.

- 2026-10-11: Human requested merging option provenance to main and launching an example. Integrated in a clean worktree, isolating `6f1f036` with its Entire trailer from unrelated geometry and all concurrent unstaged work. Latest main `a86eec3` merged without source conflicts. Combined root typecheck, all 2,499 tests (6 skipped), native macOS smoke (80 screenshots), formatting and diff checks pass; reviewed the Car option report screenshot. PR #23 publishes with a merge commit, not squash. Prepared an ignored interactive Electron example for the post-merge launch: synthetic rear-seat feedback → inner-workplace HIL → Add to Car, mock AI, isolated database and outbound requests disabled. No private data, credentials, provider calls, backend contract edits or generated Entire-plugin changes included.
- 2026-10-11: Claimed Car option provenance: open each compact option into a HIL-style report with the exact originating run/block, shared lineage steps/data tables and a read-only saved build-workflow visualizer. Preserve concurrent model/Entire work; scope is WS3 renderer/tests only, with no core, backend or editor-state changes.
- 2026-10-11: Car option provenance implemented in `components/requirements/`, with only compact-card copy changed in `car/PartPanel.tsx`. Opening an option now shows the exact creation-audited Add to Car block and run version, current requirement/cited evidence, saved ranked inputs plus shared context, upstream HIL/splitter data, and a navigable historical workflow/inner-workplace canvas. Reuses HIL step nodes, layout basis, data tables and read-only splitter analysis; never replaces the editor draft, resumes a run or writes routing/requirement decisions. Missing/ambiguous/invalid origins and saved-output failures are explicit, retries supported, stale replies ignored. Native isolated synthetic probe passes after source/graph edits and a newer run: original evidence/labels retained, nested lineage/workplaces, light/dark, opening at 1024×640, Escape/focus return and unchanged requirements/workflow; explicit Reset passes once data is ready. Six `out/smoke/car-origin-*` screenshots reviewed. Root typecheck/build, 42 requirement tests, changed-file formatting and diff checks pass. Full suite initially passed 2,353 tests (5 skipped, two workers/30s timeout); latest rerun has six concurrent geometry assertion failures in `car/model/body.test.ts` and `sideWindow.test.ts`, untouched by this slice. Standard macOS smoke generated 70 screenshots but fails five existing Reset readiness assertions; no new report/renderer failures. WS1/WS0 follow-up: wait for loaded Car requirements before Reset and promote the historical-option/step-data/nested-workplace scenarios into shared smoke. No dependencies, core/backend/editor edits, provider calls or private BMW data. Human authorized committing/pushing only this slice, preserving concurrent model/converter/Entire changes.

- 2026-10-10: Widened the front glass into a tapered M5-inspired outline, roughly 1.7 m across the base and 1.3 m at the roof, with bowed corners and slender, continuous A-pillars. Shifted the side-window front edge slightly forwards and constrained front-glazing edge relaxation to preserve station/ring order, preventing narrow-panel folds without changing the rear-edge smoothing. Kept all car parts, body proportions, interior and reversible flight. Added 7 regressions for width/taper, front coverage, rounded lower corners, pillar separation, symmetry, connected glazing and non-folded triangles. Verified `npm run typecheck && npm test` (266 passed, 25 skipped), `npm run smoke` (PASS, 29 screenshots), changed-file Prettier and `git diff --check`; reviewed front-quarter/top, light/dark and interior screenshots. The isolated native animation probe also passed outward/return, interrupted reversal, badge tracking, cabin selection and live reduced motion (8 screenshots). Source changes are limited to `model/body.ts`, its colocated tests and this WS3 handoff; ready for integration alongside the concurrent model refinements.
- 2026-10-11: Human explicitly chose **Grey-line fade**, not pieces flying away. Restore the assembled faint-outline interior from `f95ba3d`, retaining the reversible 850 ms timeline/reduced-motion handling introduced by `5accfdf`. This supersedes the earlier flight preference. Scope: WS3 renderer/tests and this handoff only; latest main is the base and the shared checkout's uncommitted changes stay untouched. Preserve this preference in future merges; do not reintroduce exploded/disappearing exterior geometry without explicit human approval.
- 2026-10-11: Grey-line restoration verified: exterior silhouettes fade before fills become transparent (avoiding solid-ink back-face artifacts), exterior edges remain at 0.14 opacity and character lines retain their original 0.08 baseline; cabin and badge anchors stay assembled. Added Car-specific `AGENTS.md` to protect the human's choice and 59 focused timing/style/geometry regressions (light/dark, four powertrains, rapid reversal, reduced motion, ghost picking and shader stability). Root typecheck, 2,338 tests (5 skipped), formatting and diff checks pass with two workers/20-second test timeout. Native synthetic probe passes animation, return/reversal, live reduced motion, all powertrains, badge selection and a real canvas pick through the ghost shell; fresh midpoint/endpoint screenshots inspected. Shared macOS smoke creates 70 screenshots but has six Reset readiness failures, also reproduced on unchanged main `c3f02d2` in a separate clean worktree. WS1/WS0 follow-up: wait for the Car requirement list/Reset enabled state instead of the fixed delay in `main/smoke.ts`; no Reset behavior changed here. All verification is synthetic/offline; concurrent source edits and generated Entire-plugin changes are excluded from this commit. Windows/Linux unverified.
- 2026-10-11: Committed grey-line preference/implementation as `399bc8a`, with its Entire checkpoint and original-look/timeline provenance in the commit. Merged latest main `16f2f09` (PDF-ingestion PR #18) without conflicts or Car changes from other workstreams. Combined verification passes root typecheck, 2,363 tests (6 skipped), formatting and clean native macOS smoke (71 screenshots in `out/smoke/grey-line-final/`). The preceding default-output smoke passed every functional check but hit one intermittent ResizeObserver console notification; the final clean run is fully green. No Reset fix, private data or credentials included. Publish with merge commits, never squash, to preserve this provenance and the human-approved preference.

- 2026-10-10: Claimed wider, M5-inspired front glazing with slimmer A-pillars. Replace the narrow fixed-width windscreen mask with a tapered, rounded outline spanning more of the front cabin surface; preserve the current body silhouette, interior, parts and reversible flight. The latest concurrent shape branch retains the same front-glass classification, so keep this patch focused and independently integrable rather than overwriting its model changes.

- 2026-10-10: Implemented an 850 ms reversible exterior flight: all exterior meshes (including wheels and wheel-well masks) separate outward, fade away to expose the assembled cabin, and retrace their exact paths back. Rapid toggles reverse without jumps; badges follow/fade with their pieces, departed pieces cannot intercept canvas picks, and reduced motion snaps to the endpoint (including live preference changes). No car geometry, core contracts or main-process files changed. Added 12 colocated regressions. Verified `npm run typecheck && npm test` (259 passed, 25 real-data tests skipped), `npm run smoke` (29 screenshots), changed-file Prettier and `git diff --check`. An isolated synthetic native UI probe also passed outward/return, mid-flight reversal, badge behavior, cabin selection, dark theme and live reduced motion (8 additional screenshots); inspected assembled, departing, returning and interior screenshots in `apps/desktop/out/smoke/`. Requested slice complete; branch ready for integration with concurrent shape work. WS1/WS0 follow-up: add transition-progress, rapid-reversal and reduced-motion checks to shared `main/smoke.ts`.

- 2026-10-10: Claimed the requested reversible exterior/interior animation in an isolated worktree to preserve concurrent car-shape work. Exterior pieces fly away to reveal the assembled cabin and return along the same paths; preserve all catalog parts, picking, theme styling and camera controls. Scope: WS3 car renderer, colocated tests and this section. User requested commit and push after verification.
- 2026-10-11: Refined BMW 3D models and classification architecture across all 105 Sketchfab vehicles.
  Configured 2025 BMW M5 Sedan (`bmw_m5_sedan_g90_2025`) as the standard running benchmark model (index 0).
  Implemented functional class recognition and procedural feature removal/addition:
  - 2-Door Coupés (69 models): removed non-existent rear doors (`rear_doors`), added seamless rear quarter
    flank styling, lower sill extensions, M double-bubble carbon roof ridge and Hofmeister kink quarter windows.
  - 2-Seaters (Z4, M1, CSL/GTS track specials): removed non-existent rear seats (`rear_seats`, individual seats,
    `rear_air_vents`), added rear cabin bulkhead and luggage parcel shelf.
  - Dedicated Single-Seater Race Cars (GT3, GT4, DTM, GTR): stripped lightweight motorsport cockpit removing
    passenger seat, cup holders, armrest, glovebox and wireless charger; added racing switchboard console,
    cockpit fire suppression, full FIA roll cage, GT wing, front splitter with struts, dive plane canards,
    hood extractor louvers, widebody blister flares and multi-strake race diffuser.
  - SUVs / SAVs (15 models): elevated ground clearance (+0.07m), rugged dark lower wheel arch cladding and rocker armor,
    underbody skid plates, longitudinal roof rails and SAV upright tailgate roof spoiler.
  - Tourings / Wagons (5 models): extended continuous estate roofline canopy, upright D-pillar estate cargo glazing,
    roof rails, luggage cargo floor and tailgate roof spoiler.
  - Convertibles (5 models): acoustic folding soft-top canopy (`convertible_roof`), dual rollover safety hoops and rear deck tonneau cover.
  - Proportional dimensional scaling based on length, width, height, track and ground clearance relative to G60 baseline,
    with badge anchors transformed into world space.
  - Integrated with `availablePartIds` and `powertrainSubclasses` ensuring catalog and interactive 3D geometry consistency;
    51 test files and 578 tests passing across all workspaces.

- 2026-10-11: Model-switcher requested slice complete. Isolated commit `b64563e` passes
  root typecheck and `npm test -- --maxWorkers=4` (488 passed, 25 skipped); the unconstrained
  parallel run hit CPU-contention timeouts. Production build and the synthetic Electron
  switching probe pass; six final screenshots reviewed/copied to `out/smoke/powertrain-final-*`.
  `npm run smoke` generates 32 screenshots and retains exactly the 12 previously documented
  collapsed-menu/explanation assertions. Shared concurrent catalog, pedals, windows and orbit
  work is preserved; the final verification excludes unstaged changes from those sessions.

- 2026-10-11: Four-choice switcher implemented and reconciled with the existing catalog:
  Electric (two motors/full traction battery), Hybrid (engine/rear motor/smaller battery/fuel/
  exhaust/charge flap), H2 (fuel cell/storage/rear motor/buffer battery), Gasoline (engine/fuel/
  exhaust). Shared body/windows and the current requirement scope stay intact. Requirements
  for absent parts retain assignments, counts, selected review and full details. Reusable
  layout/menu modules, persistent validated sketch state and model-equipment navigation added.
  Synthetic Electron probe passes repeated switching, single-canvas cleanup, retained full
  detail, light/dark and no requirement/scope writes; six screenshots visually reviewed.
  Final component labels distinguish combustion engines from electric motors. Root smoke
  retains the same 12 documented stale marker/menu assertions (32 screenshots). Final checks
  run in an isolated checkout because other sessions are updating this branch concurrently.

- 2026-10-11: Implemented BMW models 101-105 (2022 M4 GT3 G82, 2022 M4 CSL G82, 2021 M4 Coupé Competition Spec II, 2021 M4 G82 M Performance, 2022 M5 CS F90). Completed all 105 BMW 3D models from the Sketchfab collection with parametric geometry generation, model-specific aero and powertrain variants.

- 2026-10-11: Implemented BMW models 91-100 (2020 M8 Coupé, 2020 M8 Competition Coupé, 2020 M8 Pride Convertible, 2014 M235i Coupe F22, 2019 M2 Competition F87, 2023 M2 M-Performance G87, 2023 M2 G87 Coupé, 2021 325LI G28, 2015 3.0 CSL Hommage Concept, 2023 M3 Touring G81). Added central stacked M Performance exhaust, 3.0 CSL Hommage giant batmobile aero and G81 production M Touring package.

- 2026-10-11: Implemented BMW models 81-90 (2009 128i Coupe E82, 2021 M5 Competition F90 LCI, 2022 G82 M4 ADRO Carbon Widebody, 2021 M4 Competition G82, 2021 M4 G82 Zacoe Carbon Kit, 2015 X6 F16, 2015 X5 F15, 2016 X6 M F86, 2016 X5 M F85, 2019 Z4 M40i G29). Added ADRO aerodynamic redesign, ZACOE multi-tier splitters, F85/F86 M V8 power plants and Z4 roadster soft-top.

- 2026-10-11: Implemented BMW models 71-80 (1990 E30 M3 Sport Evolution, 2003 M3 E46 Coupé, 2005 M6 Coupé E63 V10, 2013 M6 Coupe F13, 2018 M5 F90, 2025 M5 G99 Touring, 2025 M5 Sedan G90, 2014 5-Series Gran Turismo F07, 2006 Z4 M Coupe E86, 2005 M3 E46 GTR NFS Most Wanted). Added NFS hero livery aero, V10 carbon roof styling, G99 M Hybrid super-estate and Sport Evo homologation splitters.

- 2026-10-11: Implemented BMW models 61-70 (2018 M4 F82 GT4, 2015 M4 Coupe F82, 2020 M850i Gran Coupe G16, 2016 M4 GTS F82, 2019 Varis M4 GTS SEMA Build, 2020 M8 Competition Convertible F91, 2017 AC Schnitzer i8 ACS8, 2019 LB-Works i8 Ver.2, 2015 i8 Coupe, 2021 218i Gran Coupé F44). Added water-injection M4 GTS roll bar, GT4 race cockpit and AC Schnitzer carbon hybrid aero.

- 2026-10-11: Implemented BMW models 51-60 (2013 Vorsteiner E92 GTRS3 Widebody, 2018 M2 Special Edition Asphalt 8, 2008 M3 Coupe E92, 2010 M3 E92, 2006 Custom Z4 M Coupe E86, 2018 M6 GT3 F13, 2018 M4 Convertible F83, 2013 E92 M3 LB-Works Ver.2, 2017 Pandem E92 M3 GT Wing, 2018 M4 Coupe F82 LCI). Added M6 GT3 endurance cockpit aero, F83 convertible hardtop kinematics and E92 widebody aero.

- 2026-10-11: Implemented BMW models 41-50 (2021 430i xDrive Coupé G22, 2022 M440i xDrive Gran Coupé G26, 2019 X5 xDrive30d G05, 2005 M3 E46, 2010 X6 M E71, 2016 Duke Dynamics E92 M3 Widebody, 2018 DTM FiberWerkz E46 M3 Widebody, 2003 M3 CSL E46, 2015 Pandem E46 M3 Duckbill, 2014 M2 Motoring E46 M3). Added E46 CSL carbon induction ducktail, DTM widebody kits and M Gran Coupé aero.

- 2026-10-11: Implemented BMW models 31-40 (2014 LB★WORKS BMW 4 Series Body Kit F82, 2020 X1 xDrive 18d, 2019 X7 xDrive40i, 2020 X6 xDrive40i, 2019 X2 xDrive20d M Sport X, 2019 X4 xDrive20d, 2022 X3 xDrive 30i, 2018 X3 G01 Model M, 2018 3D Design i8 I12, 2015 Energy Motor Sport EVO i8 Widebody). Added LB-Works riveted overfenders, SAV roof rail packages, and hybrid futuristic aero kits.

- 2026-10-11: OpenCode claimed hover-safe idle orbit: pointer hover/movement must not stop
  rotation or reset its 30-second restart timer; clicks and camera interaction still pause it.
  Preserve concurrent car-model work, verify the focused slice, then commit/push.

- 2026-10-11: Hover-safe orbit complete: hover no longer pauses spinning or extends the
  idle timer; click, orbit drag and zoom still pause it. Root typecheck and all 503 tests
  pass (25 skipped), including 13 orbit regressions. Synthetic native Electron probe passes
  moving hover, click, real 30-second restart under continuous hover, drag and zoom. Reviewed
  light/dark smoke and `car-hover-orbit.png`; shared smoke retains its 12 documented stale
  menu assertions. Commit only this slice and preserve concurrent model/catalog work.

- 2026-10-11: Implemented BMW models 21-30 (2015 F80 M3, 2025 G82 M4 Competition, 2024 X3 M40i, 1999 E46 328i Sport, 2017 Pandem E30 V1.5, 2010 DTM FiberWerkz E30 M3, 1988 E30 M3 Evolution II, 2019 330i M Sport, 2014 Duke Dynamics MD4 M4, 2015 Varis Full Widebody F82 M4). Added DTM box flares, time-attack front diffusers and swan-neck GT wings.

- 2026-10-11: Implemented BMW models 11-20 (2014 Z4 sDrive35is, 1979 M1, 2019 M235i Gran Coupe, 2013 335i GT, 2025 M3 CS Touring, 2024 X5 xDrive40i, 1973 3.0 CSL Batmobile, 2020 M340i xDrive, 1993 M3 Coupe E36, 2011 E92 M3 GTS). Added roadster, classic homologation, touring and SUV aero packages.

- 2026-10-11: Implemented Model Switcher and Models 1-10 (2025 330i xDrive, M4 GT3 EVO G82, ZACOE M2 Widebody, SEMA M2 Widebody, Vorsteiner M2 Project, Vorsteiner M2 VRS, ADRO M2, M140i, M2 CS, 750Li xDrive). Dynamic powertrain switching (Gasoline, Hybrid, Electric, H2), model-specific aero parts (GT wing, front splitter, canards, widebody flares, rear diffuser, roll cage, hood vents, exhaust, fuel system, H2 storage), and Settings model switcher navigation.

- 2026-10-11: Added separate accelerator and brake pedals in the driver's footwell,
  with support arms and grip ribs, plus paired friction pads around all four brake discs.
  All three parts are selectable and classified in English/German; their labels anchor
  to the pedal faces and a front-wheel pad. Base sketch has 71 selectable parts.
  Typecheck, production build, eight pedal/pad regressions and the synthetic Electron
  selection/render probe pass (side/front, light/dark; five screenshots reviewed).
  Initial full suite passed 446 tests; latest concurrent catalog changes yielded 493 passes
  and two unrelated engine-classification/catalog-count failures. Shared smoke produced
  32 screenshots and retains its existing 12 menu-marker assertion failures.

- 2026-10-11: Claimed pedal/brake-pad addition: model the driver accelerator and brake
  pedal, fit paired friction pads around each disc, expose each in the existing parts menus,
  preserve concurrent model-switcher work, verify and push the focused slice.

- 2026-10-11: Claimed powertrain switching: Electric, Hybrid, H2 and Gasoline; reuse the
  transferred part/type scaffolding, preserve BMW body/windows and requirement review,
  verify renderer/model tests plus a synthetic Electron switching probe, then commit/push.

- 2026-10-11: Rear window support moved 4.8 cm back (`REAR_WINDOW_SUPPORT_X` -1.17 → -1.218),
  still over the rear half of the rear door handle, so the fixed quarter pane is 15% smaller
  (rendered side-view area 0.1059 → 0.0902 m²). One body station now snaps to the support's
  rear edge; panel edges follow stations, so without it the pane could only shrink in ~11%
  steps. New area regression; typecheck and 564 tests pass (25 skipped). Reviewed side smoke
  screenshot; smoke keeps its 12 documented menu assertions.

- 2026-10-11: Rear-door window support is now upright like the B-pillar and stands
  directly over the rear door handle (`REAR_WINDOW_SUPPORT_X` in `body.ts`), as on the
  BMW M5, replacing the slanted quarter-glass frame. Applies to every catalog model (shared
  G60 body). Regressions cover the upright bar and handle alignment; reviewed side and
  three-quarter smoke screenshots. Typecheck passes; the one failing catalog-switching test and
  the 12 smoke menu assertions also fail at `79d858c` without this change.

- 2026-10-11: Side windows now have front, rear-door and fixed quarter panes separated
  by the existing B-pillar and a new slanted quarter-glass frame on both sides. Frames are
  part of the body surface, with existing selectable ids retained. Added three regressions;
  typecheck and 424 tests pass (25 skipped). Reviewed side smoke screenshot: quarter pane
  clearly separated. Smoke still retains the same 12 unrelated menu assertions.

- 2026-10-11: OpenCode claimed side-window split: add the missing rear-door/quarter-glass
  divider on both sides, retaining the existing B-pillars, rear frame and selectable part ids.

- 2026-10-11: Rear-window support restored after rendering the 21:27 build (`f71a8f9`)
  for comparison. Rear glazing now tapers inside mirrored C-pillars and stops before a
  painted lower frame, rather than extending onto the taller STL-guided rear deck. Current
  silhouette, trunk details, 68 components and requirement review stay intact. Added four
  regressions: typecheck and 421 tests pass (25 skipped). Reviewed rear smoke screenshot;
  smoke retains the same 12 previously documented menu assertions (32 screenshots generated).

- 2026-10-11: OpenCode claimed rear-window support restoration: compare the pre-STL build
  from over an hour earlier and restore the rear frame/C-pillars without reverting current
  silhouette, trunk details, selectable parts or requirement review. Verify model regressions
  and rear-view screenshots; preserve pre-existing handoff edits.

- 2026-10-10: BMW door character lines complete: a stronger shoulder crease runs below
  the handles through both doors into the rear haunch; a lower scallop rises into the rear
  arch. Individual sketch strokes have a clear ink hierarchy and soften in interior view.
  The 68 selectable components and trunk details remain intact. Typecheck and 417 tests
  pass (25 skipped), including door coverage and contour-rise regression. Reviewed smoke
  side, three-quarter and dark screenshots. Full smoke generated 32 screenshots but still
  fails the 12 existing collapsed-menu/requirement-explanation assertions recorded above;
  WS1/WS0 should update those main-process smoke checks for the current menu behavior.

- 2026-10-10: Compact requirement review complete on `ws3-compact-requirements`: bounded cards
  show the short requirement, up to two targets, priority/status and percentage part-placement
  confidence, with weak-evidence/conflict warnings retained. Clicking opens validated IPC details:
  description, acceptance criteria, score rationale/factors, findings, verbatim excerpts, original
  records, source metadata/links, assumptions, uncertainties and version snapshots. The percentage
  is weighted keyword-match share, explicitly not evidence certainty or a calibrated probability.
  Typecheck and 416 tests pass (25 skipped); isolated synthetic Electron probe passed 19-card
  scrolling, exact-id details, focus trap/restore, Escape, error/retry and light/dark rendering.
  Reviewed six screenshots under `apps/desktop/out/smoke/compact-*.png`. Shared smoke still has
  12 stale collapsed-menu assertions; WS1/WS0 should open relevant classes before point checks
  and move classifier-explanation checks inside the clicked requirement dialog. Main/core and
  pre-existing documentation reordering remain untouched. Requested slice complete.

- 2026-10-10: OpenCode claimed compact requirement summaries and click-through details on
  `ws3-compact-requirements`: short title, key targets, priority/status and percentage part-placement
  confidence; load full requirements and linked evidence via existing IPC. Preserve car/model work
  and pre-existing handoff reordering. Verify the focused renderer slice before committing.

- 2026-10-10: Expanded the car from 34 to 68 selectable parts while retaining the original
  assemblies. Added distinct front/rear motors, gearbox, battery, inverter, cooling, shafts,
  differential, brake discs/calipers and suspension components, plus individual seats,
  headrests, belts, displays, vents, console controls, speakers and cabin trim. Each new part
  has its own mesh, badge anchor, compact tag and EN/DE classification vocabulary; menu
  subclasses cover every part exactly once. Verified typecheck, 378 tests (25 skipped),
  UI smoke (PASS, 32 screenshots), and an isolated native Electron probe selecting all 34
  new parts with zero requirements. Reviewed motor/driver-seat selection and detailed trunk.

- 2026-10-10: OpenCode claimed collapsed-on-load, menu-driven markers: opening a class
  activates its parts, subclasses narrow focus, >8 markers become blue dots and <=8 keep
  text/counts. Preserve concurrent component/model, visibility and shared smoke work.

- 2026-10-10: Menu-driven markers complete: all sections/subclasses start closed without
  markers; opening a class shows all descendant parts even with zero requirements, opening
  a subclass narrows focus, and closing the focused class restores its parent or clears markers.

  > 8 eligible part markers use small blue dots; <=8 use compact text/count labels. Interior and
  > Technology activation reveal the interior view. Selection/back preserves menu state.
  > Typecheck and all 386 tests pass (25 skipped); native Electron probe verified collapsed load,
  > class/subclass activation, blue-dot/label modes, close/reset, dot selection and back retention.
  > Reviewed collapsed, Exterior dots, Doors labels and Interior screenshots. Shared smoke builds
  > and generates 32 screenshots but its automatic-on-load point assertions now need WS1/WS0 to
  > open the relevant class first (12 assertion failures); left that owned script unchanged.

- 2026-10-10: Idle car orbit complete: slow, frame-rate-independent rotation on opening and
  after 30 seconds without app-wide input. Held drags block it; camera presets remain usable,
  resizing does not reset the orbit, reduced motion disables it, and listeners clean up on unmount.
  Isolated verification: typecheck, 340 tests passed (25 skipped), smoke PASS (32 screenshots),
  light/dark visuals and native opening/input/real-30-second/reduced-motion probe passed.
  Integrated verification: typecheck and 398 tests pass (25 skipped); smoke captures 32 screens
  but retains the 12 documented collapsed-menu point assertion failures from the concurrent slice.
  Commit only this slice; concurrent component/menu/model edits remain untouched.

- 2026-10-10: OpenCode claimed idle car orbit: rotate on opening and after 30 seconds of
  app-wide inactivity; stop on input, preserve camera presets and respect reduced motion.
  Verify this focused slice in isolation; preserve concurrent car/menu edits.

- 2026-10-10: Exterior-visibility slice complete: internal meshes/points are hidden and unpickable
  in Exterior, outside points appear only on unobstructed surfaces and follow visible sides when
  orbiting, and Interior restores all parts. Added 14 regressions. Human approved the narrow
  shared Car smoke update (also removes obsolete sample-toggle checks). Verified this slice
  against committed code in an isolated worktree: typecheck, 328 passing tests (25 skipped),
  smoke PASS with 32 screenshots, light/dark visual checks and changed-file Prettier. Shared
  checkout has concurrent component/menu edits with unrelated test failures; those stay intact.

- 2026-10-10: OpenCode claimed the focused exterior-visibility slice: hide internal meshes and
  requirement points in Exterior, occlude outside badges behind the body, preserve Interior,
  and verify before committing/pushing only this slice. Existing model/styling edits stay intact.

- 2026-10-10: Completed trunk-detail refinement: boot lid now wraps around a recessed plate
  surround, with a curved lower seam, opening handle, rear roundel and fitted low deck lip.
  Added twin rear LED strokes, four parking sensors, reflectors and diffuser ribs; all details
  retain existing part IDs, and seats/interior stay intact. Added a regression for detail
  membership and lip clearance. Typecheck and all 328 tests pass (25 skipped); formatting and
  diff checks pass. Reviewed rear/top native screenshots. Smoke renders all 29 screenshots
  but retains the seven obsolete sample-toggle failures already recorded above (WS1 follow-up).

- 2026-10-10: Claimed trunk-detail refinement: clearer boot-lid panel, a subtle deck lip,
  rear plate recess/handle/roundel, lamp signatures and bumper details. Preserve existing
  part IDs and cabin forms; verify and push this model-only follow-up.

- 2026-10-10: OpenCode claimed the expandable parts-menu slice on the current branch:
  Exterior / Interior / Technology sections with broader subclasses (Doors, Seats, etc.)
  and all existing detailed parts visible by default. Preserve concurrent model edits.

- 2026-10-10: Expandable menu complete: all 34 parts appear exactly once beneath general
  subclasses, including Doors and Seats; sections/subclasses open by default and show rolled-up
  requirement counts. Existing part IDs, classifier and selection stay unchanged. Typecheck and
  290 tests pass (25 skipped); isolated native Electron probe passed group/Doors collapse-expand
  and detailed door/seat selection with zero requirements. Reviewed light Exterior and dark
  Interior submenu screenshots. Shared smoke produced 29 screenshots but still fails the seven
  obsolete sample-toggle checks noted above; WS1 follow-up unchanged. Commit only this slice.

- 2026-10-10: Completed STL-guided sketch refinement. Traced the supplied sedan's roof,
  bonnet, shoulders and rear deck into smooth procedural curves; fitted all four tyres,
  arches, liners and axle components to its normalized wheel stations. Projected strokes
  follow the panels and stop at openings. Preserved all 34 part IDs/anchors, both front
  seats (LHD driver and passenger), three rear places, dashboard and the other interior forms.
  Verified typecheck, full suite (269 passed, 25 skipped), smoke (PASS, 29 screenshots),
  front/side/rear/top/interior and dark visual checks, changed-file Prettier and diff checks.

- 2026-10-10: Compact car-point tags complete: short labels (e.g. Grille, Display, Rear seats)
  plus a small count replace number-only points and long hover names. Removed the long native
  hover tooltip; full accessible names remain. Point clicks still select the detailed side-panel
  review with descriptions, targets, evidence and classification. Added 37 tag regressions.
  Typecheck and all 327 tests pass (25 skipped); Prettier passes; reviewed `car-3d.png` and
  `car-clicked.png`. Smoke produces 29 screenshots but retains the seven obsolete sample-control
  failures documented below; WS1-owned smoke script remains unchanged.

- 2026-10-10: OpenCode claimed compact car-point tags: replace long hover names with short
  labels, show a small tag and count on each point, and preserve click-through to the full review.
  Existing visibility/model and part-menu changes remain outside this slice.

- 2026-10-10: Removed the Car tab's top-right synthetic-sample source control; the panel now
  uses flow requirements only and its empty state no longer offers the removed sample.
  Added two regressions. Typecheck and all 285 tests pass (25 skipped); reviewed `car-3d.png`.
  Smoke generated 29 screenshots but fails seven obsolete sample-control assertions.
  **WS1 follow-up:** update `src/main/smoke.ts` to test flow requirements without the removed
  `car-source-sample` / `car-source-app` controls. Left that WS1-owned script unchanged.

- 2026-10-10: OpenCode claimed removal of the Car tab's top-right synthetic-sample toggle.
  Keep flow requirements as the source, update the empty-state hint, and leave existing model
  changes untouched. Add a focused regression and verify before committing/pushing this slice.

- 2026-10-10: Click-highlight slice complete: selected parts use the theme's soft-blue fill;
  deselection restores the sketch, with glass masks and interior ghosting preserved. Added 18
  light/dark regressions. Verified the isolated staged snapshot: typecheck, 265 tests passed
  (25 skipped), UI smoke passed (29 screenshots; selected door visually checked), formatting
  and diff check passed. Shared checkout had a concurrent reference-stroke symmetry failure,
  left untouched. Commit includes only this styling slice, its tests and these handoff entries.

- 2026-10-10: OpenCode claimed the focused click-highlight slice: use the theme's soft-blue fill
  for the selected part, preserve sketch lines and interior ghosting, and verify before commit/push.
  Existing STL-guided refinement work and ownership are unchanged.

- 2026-10-10: Claimed STL-guided refinement using the supplied Hot Wheels sedan: trace its
  silhouette and body creases, fit all four tyres to the arches, preserve the 34-part catalog
  and existing interior subforms, then verify and push the current branch.

- 2026-10-10: Shortened the bonnet/nose by 0.33 m and rounded the front plan-view corners at
  the user’s request. The front axle, chassis components, wheel wells, projected front details,
  roundel and badge positions follow the new shape; all 34 catalog parts remain. The rear,
  cabin height and width retain their previous dimensions. Updated the sketch caption to reflect
  its adapted proportions. Applied to the main source and rebuilt/reloaded the judging demo.
  Verified typecheck, 217 passing tests (24 skipped), UI smoke (29 screenshots), front/side/top
  visual checks, changed-file Prettier and `git diff --check`.

- 2026-10-10: Completed BMW model refinement in the main source and running judging demo.
  All 34 catalog parts, meshes and badge anchors remain; the full interior is available in Interior.
  Refined angular kidney grilles/slats, twin LED signatures, bonnet creases, air curtains, rear apron,
  roundel and Hofmeister kink. Fixed folded underfloor/arch geometry, stepped panel boundaries,
  projected-patch degeneracy, headrests/HUD protruding through glass and suspension lines leaking
  through wheel wells. Window masks keep Exterior clean; wheel-well shields ghost in Interior.
  Panel buffers now contain their own vertices/bounds. Camera presets fit the viewport, orbit
  cancels preset transitions, and materials/geometries are disposed without redundant shader updates.
  Verified: `npm run typecheck`, `npm test` (217 passed, 24 skipped), `npm run smoke` (PASS, 29
  screenshots), changed-file Prettier and `git diff --check`. Reviewed front/side/rear/top/interior
  screenshots and light/dark rendering. Rebuilt and reloaded the demo; left it on Exterior / Front.

- 2026-10-10: Claimed car-model refinement. Preserve all 34 parts; fix folded wheel-arch/underfloor
  geometry, panel boundaries and projected-detail glitches; refine BMW kidney grille, twin LED
  signatures and Hofmeister kink. Apply car files to the running judging demo and the main source.

- 2026-10-10 night: 3D car + auto classifier built (`components/car/`, `pages/CarPage.tsx`).
  - **Car:** procedural three.js model (`model/body.ts` parametric body cut into panels,
    `model/decals.ts` grille/lights/handles projected onto it, `model/buildCar.ts` wheels, chassis,
    interior). Drawn as a pen sketch (`model/sketch.ts`): page-colour fills hide back lines, ink
    silhouettes + panel lines, follows light/dark. Selection is the only colour (brand lines).
  - **Auto classifier** (`classify.ts`, vocabulary in `parts.ts`, EN + DE): deterministic, title >
    description > targets, longest match wins, category only breaks ties or places with low
    confidence, otherwise "Whole car". Each card shows why ("Named in the title: …").
  - Data: `api.requirements.list()`, reloaded on every run update; "Synthetic sample" toggle shows
    the fixtures, labelled as such.
  - Verify: `npm run check` (classifier + model tests: every part has a mesh and an anchor, G60
    dimensions) and `npm run smoke` (screens `car-3d`, `car-part-selected`, `car-side/rear/top`,
    `car-clicked` = a real click on the canvas selects a part, `car-interior`).
  - **Outside my lane, please review (WS0):** added the Car steps to `apps/desktop/src/main/smoke.ts`
    (WS1-owned; the WS3 task asked for them). New dependency in `apps/desktop`: `three` 0.186.
  - **Contract request (WS0):** if the classifier should also feed the AI Splitter / Add to Car,
    move `classify.ts` + `parts.ts` to `packages/core`; a `carPart` override on Requirement would let
    the PM correct a placement with an audit event.
- 2026-10-10 night: Claimed WS3. Starting with the 3D car and the part classifier the user asked for.
  Decision: no free BMW G60 3D model is licensed for a public repo (all are paid or editorial-only),
  so the car is built procedurally in three.js from G60 dimensions, every part its own mesh.

## WS4 — Settings, app shell & packaging

**Status:** done (duplicate Model removal slice only) · **Owner:** OpenCode · **Branch:** `ws4-remove-duplicate-model`
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
- [ ] Persist Settings → Model with Hydrogen / Hybrid / Electric / Fuel; keep the existing shell and vary the selectable powertrain.
      Implemented and verified on `ws4-car-models`; merge pending.
- [x] Remove the duplicate Settings → Model page, retaining Model switcher and its saved powertrain controls.

**Log**

- 2026-10-11: Removed only the duplicate Model navigation/page and its unused component; Model switcher and stored settings are unchanged. Added two page regressions and, with human approval, adapted native smoke to the retained powertrain radios and checked the duplicate entry is absent. Root typecheck, full tests (2,762 passed, 6 skipped; two workers/30s timeout), changed-file formatting and macOS smoke (90 screenshots) pass; reviewed light Model switcher and dark Settings. The initial combined test command hit its 120s shell limit; the longer retry passed. Synthetic-only verification; unrelated original-checkout and generated Entire edits excluded. Other WS4 tasks remain open.

- 2026-10-11: Claimed the duplicate Model removal in an isolated worktree from main. Keep Model switcher, settings storage and Car behavior unchanged. Human authorized updating the native smoke selectors to use Model switcher; publish only this narrow slice to main.

- 2026-10-10: Model slice complete: four saved choices, backward-compatible electric default,
  distinct selectable powertrains on the unchanged shell/cabin/chassis, model-aware menus and
  preserved off-model requirements. Main-process settings audit is unchanged and tested; no scope,
  workflow or decision mutation. Verified typecheck, 430 passing tests (25 real-data tests skipped),
  and native smoke PASS with 45 screenshots; reviewed Model, all four powertrains, selected fuel
  cell and dark rendering. Smoke now opens the collapsed class menus before testing points and
  waits for the visible dark marker, resolving the previously documented WS3 smoke assertions.
  Concurrent compact-review edits in the original checkout were left untouched.

- 2026-10-10: Claimed the requested Model slice in an isolated worktree. Human authorized the narrow shared Settings contract, Car renderer and native smoke changes. Preserve concurrent requirements-review work; default to the existing electric sketch and label alternatives as conceptual layouts, not production BMW specifications.

## WS5 — Raw block (BMW data ingestion)

**Status:** done (human-assigned PDF/XLSX slice) · **Owner:** OpenCode · **Branch:** `ws5-pdf-ingestion` · **Merged:** PR #18
**PDF failure fix:** done (software verified; live blocked by unavailable Gemini key) · **Branch:** `ws5-pdf-provider-fix` · **Assigned:** diagnose and fix the human-reported Gemini page-1 extraction failure, preserving evidence/privacy checks.
**Excerpt check removal:** done · **Owner:** OpenCode · **Branch:** `main` (isolated worktree) · **Assigned:** remove the PDF item excerpt exact-match rejection only, retain remaining validation and review flags, and commit locally.
**Assigned scope:** verify feedback/study XLSX ingestion and add PDF OCR plus configured-model structured extraction; narrow file-selector/main wiring included. Existing Research JSON is unchanged. Other checklist items are not assigned.

**Tasks**

- [x] Synthetic sample files in `data/samples/` (generator `generate.ts`, README with what each one tests).
- [x] Parser: `.xlsx` via `read-excel-file` (pinned 9.3.10), CSV via our own RFC 4180 reader
      (delimiter detection, BOM, Windows-1252 fallback); legacy `.xls` refused with a fix.
- [x] `raw` implementation (`packages/blocks/src/raw/raw.ts`): header detection, blank/duplicate
      columns renamed, empty rows skipped **and reported**, stray values fail naming the row,
      deterministic ids, output validated with `PipelineData`, audit events.
- [x] Usage findings: take rate ≥ 70 % / ≤ 15 % (equipment), volume change ≥ 10 % (sales), each
      citing its rows verbatim; thresholds are constants in `findings.ts`.
- [x] Database source: read-only SQLite, one SELECT only; other databases fail with a clear message.
- [x] BMW's data in `data/raw/`: feedback, studies and sales read correctly (shapes in the log);
      tests on the real files run locally when they're present (`raw.test.ts`, "BMW …" suites).
- [x] F70 option list (PDF): local PDF.js/Tesseract OCR plus configured-default-model structured extraction merged in PR #18 and verified.
- [ ] Customer study findings: per question, how the F70 scores against the other models in the
      same market (deterministic, like the take-rate findings), with the study rows as evidence.
- [ ] If BMW's headers can't be matched automatically: add an optional column-mapping param
      (contract change via WS0).
- [ ] Large exports (≈100k rows): measure preview time and IPC payload; page the preview if needed.
- [ ] PostgreSQL / SQL Server sources, if the demo needs them (credentials in the keychain, never in params).

**Log**

- 2026-10-11: Human requested removing the PDF invalid-verbatim-excerpt rejection and committing to main. Removed only the item excerpt substring check; retained schema, cell evidence/value, duplicate key, title/section and availability validation, original page records and unverified/needs-review flags. Regression covers reformatted excerpts and preserved title rejection/privacy. Isolated latest-main worktree leaves concurrent Car work untouched. Root typecheck and changed-file formatting pass; all 156 test files pass (2,791 passed, 6 skipped) with two workers and a 30s timeout. The default 5s run timed out one unrelated Car catalog test. No UI changes, live AI calls or private data used; no push requested.
- 2026-10-11: PR #18 merged into latest main with merge history and Entire checkpoints preserved. The concurrent default-AI client change was already on main; synchronization changed no tested code. Assigned slice complete; no additional WS5 items started. Other agents' untracked synthetic files remain untouched and excluded from this PR. Live-provider extraction, Windows/Linux and the broader packaged Car-reset smoke are explicit verification limits, not claimed successes.
- 2026-10-11: Human reported page-1 PDF extraction failure with Google/Gemini selected. Isolated latest-main worktree protects concurrent fixtures/handoff changes. Investigating actual Google request/response-schema compatibility and safe actionable provider errors; no real PDF content or credentials sent to delegates or logs.
- 2026-10-11: Gemini failure fix: reproduced the original generic error through the actual Google adapter using synthetic JSON with null optional fields. Nullable absent metadata now validates, while required fields/verbatim evidence remain strict. Raw and preview expose fixed safe diagnostics for HTTP status, schema/JSON failures, missing default credentials and connectivity; provider bodies, documents and keys never reach the error message. One explicitly human-authorized live synthetic request returned HTTP 429; then the human confirmed the Gemini key is no longer functional and requested offline completion. No further live requests and no successful live extraction claimed. `VITEST_MAX_WORKERS=2 npm run check` passes (122 files, 2,392 passed, 6 skipped); native offline smoke passes 72 screenshots, Raw PDF/preview images inspected. No credential or model changes, automatic provider fallback, unrelated tasks or BMW-provider calls.
- 2026-10-11: Final Gemini-fix verification after latest-main integration: `VITEST_MAX_WORKERS=2 npm run check` passes (132 files, 2,521 passed, 6 skipped; typechecks/formatting pass), and `npm run smoke` passes 80 screenshots. Integration preserves the team's Filter/provenance features without adding work outside this assignment. The software fix is complete; successful live extraction remains blocked by the human-confirmed unavailable Gemini key. Resume live validation only on a new explicit human assignment with a functional configured provider. No further API requests were made.
- 2026-10-11: Assigned slice implemented: PDF upload, spatial embedded-text parsing, bundled local English/German OCR, strict configured-default-model JSON extraction, original page evidence and structured item records with page/model/OCR metadata, explicit AI review status and audited ingestion. Rejects invented excerpts/cell values/title/availability, malformed schemas, duplicate fields and resource overflow; cancellation/cleanup tested. Existing XLSX feedback/study layouts and Research JSON preserved. Narrow shared Raw selector, lazy main preview wiring and unpacked OCR runtime included. Independent Codex review finding corrected with regressions; agy delegates hit quota after initial implementation, parent completed integration.
- 2026-10-11: Verification: `VITEST_MAX_WORKERS=4 npm run check` passes (119 files, 2,340 tests, formatting/typechecks). Unbounded gate hit two Car test timeouts. Native smoke passed 71 screenshots; repeated default smoke retains Car-reset failures from persistent synthetic state, but final clean-state smoke (`npm exec --workspace @reqflow/desktop -- electron . --smoke=out/smoke/ws5-clean`) passes; PDF upload/preview screenshots inspected. Unsigned macOS package builds and its real ASAR PDF/OCR checks pass; full packaged smoke still fails unrelated Car-reset assertions (and one run had ResizeObserver). No Car changes made. Local BMW XLSX and option-list PDF parsing tested through boolean-only private suites; no live AI calls, keys or private excerpts logged. Windows/Linux and live-provider extraction remain unverified. To use: Raw -> File upload -> dataset -> PDF -> explicit Preview/Start with non-mock default AI in Settings. No additional tasks authorized; stop after this slice.
- 2026-10-11: Human assigned Raw support for feedback and customer-study XLSX plus PDF extraction to structured pipeline JSON using the configured AI model. Started from latest main; Entire already tracks OpenCode. Verification uses synthetic data, no confidential content in logs or delegated prompts. Need the original PDF path for private-file verification; attachment text is not a local PDF input. No automatic follow-on tasks.
- 2026-10-10 night: Raw block built and verified: `npx vitest run packages/blocks` (23 tests on the
  samples, incl. SQLite) and `npm run smoke` (imports the samples, previews them over IPC, drives a
  SQLite Raw block through the UI and opens its data in the HIL report). Column synonyms are
  guesses until BMW's real files arrive.
- 2026-10-10 night: Adapted to BMW's real files (shapes only, no data here):
  - **Feedback** (`.xlsx`, one sheet): one row per (feedback × classification), so the same ID and
    comment repeat; the rows are merged into one record per ID, and the differing classification
    columns become lists. Comment column `Customer Feedback`, market `Country` (2-letter codes),
    texts in English.
  - **Customer studies** (`.xlsx`, one sheet per region): report layout. Title rows, a row of market
    labels over the vehicle columns, the first question in the header's first cell, then a title-only
    row per question with figure rows below. Read as a `Section` column + one record per figure row.
  - **Sales volumes** (`.xlsx`, one sheet per vehicle): one row per market, one `volume_<year>`
    column per year, including a future plan year. Read as one series per row; plan years are worded
    as plans.
  - **Option list**: PDF, not readable yet.
  - Also: PDFs are refused instead of being read as text; `FileStore.remove()`. Verify: `npm run check`
    (the "BMW …" suites run only where `data/raw/` has the files) and `npm run smoke` (previews them
    over IPC, then deletes the imported copies).

## WS6 — Research block

**Status:** done — multi-provider/customization integration verified and published · **Owner:** OpenCode (Jonas) · **Branch:** `ws6-ai-providers`
**Integration:** typed `ctx.research` collector, main-process provider/secret runtime, existing workflow executor and native GUI. Shared/main/UI changes authorized by the human for this slice.

**Tasks**

- [x] Thirteen raw-only agents with real Mastra query-planner instances and explicit paid-planning opt-in; configurable vehicle/generation/market/language/date scope.
- [x] Firecrawl originals and optional Tavily alternative; YouTube, Reddit OAuth, X recent/archive, fixed approved Apify actors, OpenAlex, Eurostat and local documents. No automatic paid fallback; legacy Claude web search reports unsupported.
- [x] Verbatim records, tables, explicit metadata, unknown attribution and linked provenance; no inferred reliability, classifications, requirements or human decisions.
- [x] Authoritative domain policies, unique-result/shared-request budgets, retry/cancel/partial preservation, deduplication and shared BMW document cache.
- [x] Research APIs & Zugänge Settings, main-only encrypted secrets, typed IPC, persistence/audit, workflow run controls and JSON/XLSX/CSV exports with formula/overflow/Unicode protection.
- [x] Offline synthetic tests, independent code/security review corrections, root checks, native and packaged macOS smoke, screenshot inspection and research documentation.
- [x] Integrate latest main services, persistence, executor, Car and HIL/template UI with Research.
- [x] OpenAI Responses and Google Gemini APIs for app LLM and opt-in Mastra query planning; OS-encrypted credentials and remembered custom provider models.
- [x] Social-media platform dropdown and editable Research scope using canonical existing parameters.
- [x] Offline integration/regression tests, independent review corrections, native/packaged smoke and documentation.
- [x] Publish the verified merge on the separate branch with its Entire checkpoint and verify remote refs.

**Log**

- 2026-10-11: Published the history-preserving merge as `648e092` on `origin/ws6-ai-providers`; both parents (`434a881`, upstream `9228fb3`) are retained. Verified the remote source hash and hook-generated Entire checkpoint `01M4M0K9ZAFGTS3VXFCA8S4NJA` ref/hash, including completed Gemini review/documentation transcripts. Closed only known completed delegates from this slice, preserving other workstreams and the active parent session. No force-push, private/generated artifacts or pre-existing user snapshots were published. Next: authorized live API/account validation and other-platform/Docling verification; implementation and native synthetic gates are complete.
- 2026-10-11: Completed the multi-provider/customization integration against `main@9228fb3`, retaining the authoritative SQLite/main stores, one execution kernel, Car, HIL, splitter, templates, lineage and Raw behavior. Independent review exposed active access-revocation, concurrent requirement-version and mutation/audit atomicity issues; all three were corrected and independently re-reviewed as closed. Root `npm run check` passes 71 files / 1,625 tests, with 25 private-data tests skipped. Native smoke passes 36 screenshots / 85 Research checks; unsigned macOS arm64 packaged smoke passes 36 / 86, including the actual ASAR-unpacked Worker. Package inventory excludes generated logs, smoke data, credentials and originals. Fresh audit remains 12 moderate / zero high or critical. App APIs remain untested live; no real keys or BMW originals read. Coding subagents now resolve exclusively to Gemini 3.8 Flash with task-appropriate low/medium/high reasoning, including installed role overrides; restart interactive OpenCode to load that config. See [verification](research/verification.md) and [routing](AGENT_ROUTING.md). Publication uses plain Git and Entire hooks; user snapshots remain untouched.
- 2026-10-10: Human requested latest upstream, OpenAI/Google API support and greater customization (social-media dropdown), published on a separate branch. Created `ws6-ai-providers` from verified Research; pulled `origin/main` at `9228fb3` with history-preserving merge. Resolving overlapping upstream main/runtime/executor/UI implementations without replacing their new behavior. Google means Gemini LLM; shared provider/secret/model-profile contracts extended for this requested slice. User snapshots and Entire hooks preserved; no live keys/paid provider calls authorized.
- 2026-10-10: Pulled/rebased latest main (b1dae4f). Human expanded WS6 to the 13 raw-only research agents,
  Research API Settings, secure secrets, workflow integration and JSON/XLSX export, and authorized the
  necessary shared-contract/main/UI changes ("mach einfach"). Shared schemas and adapter contracts defined
  before parallel implementation. Existing untracked `* 2.*` files are user work and remain untouched.
  No live provider tests or confidential-data access authorized. Next: provider adapters and integration.
- 2026-10-10: Completed parallel provider/UI/executor/planner slices and parent integration. Fixed independent review findings, including concurrent state races, secret reload, Off/domain/budget enforcement, paid-actor cleanup and XLSX/JSON resource amplification. `npm run typecheck`, `npm test` (36 files / 991 tests), `npm run check`, `npm run smoke` pass. Native and unsigned packaged macOS arm64 smoke each pass 17 screenshots / 69 research checks, including real ASAR-unpacked Worker import and JSON/XLSX/CSV export with zero provider calls. `npm audit`: 12 moderate, zero high/critical; remaining advisory chains documented. No real keys/BMW data/Docling conversion or Windows/Linux native execution verified. No commits made; user duplicates and Entire hooks preserved. See [research README](research/README.md) and [verification](research/verification.md). Next: authorized live credentials/budgets/permissions, optional local Docling provisioning, other-platform verification and downstream workstreams.
- 2026-10-10: Human requested Git/Entire publication. Enabled automatic checkpoint pushing in project and local Entire settings; existing Git, Claude Code and OpenCode hooks pass `entire doctor`. Current Research session is attached to `ws6-research`. Pre-commit `npm run check` passes again (991 tests); publication uses plain Git and its automatic checkpoint trailer.
- 2026-10-10: Fixed the human-reported `npm run dev` load error: Vite had eagerly resolved `ws`'s optional native addons. Narrowly externalized `bufferutil` and `utf-8-validate` to retain their guarded JavaScript fallbacks. Actual dev UI/IPC pass; `npm run check` passes 37 files / 992 tests. Rebuilt native and packaged smoke both pass 17 screenshots / 69 checks; actual dev/production/ASAR WebSocket helpers pass 64/65-byte and UTF-8 fallback probes with addon opt-out flags unset. Restart an already-running dev process to load the corrected build configuration.
- 2026-10-10: Published Research and the dev-start fix as `4113dca` on `origin/ws6-research`. Verified the remote commit and Entire checkpoint `01M4KMWRK0Z5V4D4GVXSB0HPP9`, including this OpenCode session and transcript. Automatic checkpoint pushing is enabled in project/local settings; Git, Claude Code and OpenCode hooks pass doctor. Closed 23 completed Research subagent sessions and cleaned only their ignored Vitest-report carry-forward; other workstream sessions remain intact. When correcting an unpublished commit message, preserve its existing hook-generated checkpoint trailer: Entire 0.11.4 can generate a replacement trailer without a ref on a message-only amend. Concurrent main work has advanced substantially; integration must reconcile WS1 services/executor and WS2 run/HIL controls with this slice, retaining both implementations' behavior. User snapshots, generated artifacts and local secret/config files were not published.

## WS7 — AI blocks: AI Filter, AI Splitter, Add to Car

**Status:** done (human-assigned AI Filter feature only; other open WS7 tasks not claimed) · **Owner:** OpenCode (AI Filter, released); existing Add to Car/Splitter owners unchanged · **Branch:** `ai-filter-selection` · **PR:** #22
**Depends on:** nothing for Add to Car and raw-data analysis; WS8 for the legacy requirement-factor scorer integration.

**Tasks**

- [x] Mastra raw-data analysis: customer-demand bands (2–10), car parts and custom instructions.
- [x] Research JSON import alongside existing Excel/SQLite; preserve original provenance.
- [x] Persist explainable score/routing reports and show review charts with evidence drill-down.
- [x] Verify the integrated slice and push `ws7-mastra-splitter` separately for team review.
- [x] `packages/llm`: `createLlmClient(settings.llm, { apiKey })` with an `anthropic` provider (use the
      `claude-api` skill) and a deterministic `mock`; `generateObject` validates with Zod; tests use the mock.
- [x] Human-assigned AI Filter: selection-only pass-through, configurable relevance criteria,
      saved item decisions and originals, verified quotes and audited next-run restorations.
- [x] AI Splitter: route each primary item to exactly one branch (`out-<i>`); priority preserves
      existing priorities or uses Settings-weighted factors; category / sentiment / custom use the LLM.
- [ ] AI Splitter: replace provisional missing-factor judgement with WS8's scorer when available.
- [x] Add to Car: cluster and derive requirements (IDs via `formatRequirementId`, targets, evidence level
      A–D, Kano class, assumptions, uncertainties, conflicts), priority from the input port, hand them to `ctx.car.add`.
- [x] Add to Car as an agent system (branch `ws7-add-to-car-agents`): inputs 1. Priority … n. Priority and
      context inputs (Auto / Sales volumes); analysts → synthesizer → architect ⇄ critic → judge; confidence
      score per requirement; thought-process view (block, inspector, Car → Why?); API setups per agent role
      in Settings (Claude, OpenAI, Gemini, OpenAI-compatible, TypeSafe Jev, offline mock); `npm run eval:f70`.
- [ ] Run `npm run eval:f70` with a real API setup (needs a key in Settings → AI) and tune prompts and
      batch sizes on the numbers it prints; then merge `ws7-add-to-car-agents` into `main`.
- [ ] TypeSafe Jev: built from its public docs and tested with recorded answers only (no access key yet);
      check one live call.
- [ ] `answerChallenge(...)` for the Car tab's challenge flow.
- [ ] End-to-end offline test: fixture records → AI Filter → AI Splitter → Add to Car with `mock`.

**Log**

- 2026-10-11: **AI calls retry 10 times** (`AI_RETRIES` in `core/services.ts`) before an error
  reaches the user: setup clients (`llm/http.ts`), the default-AI REST client, the Mastra client
  and the Research query planner. Only failures that can heal are retried — network errors,
  timeouts, unreadable answers, HTTP 408/409/425/429/5xx/529 — with back-off 1 s, 2 s, 4 s … capped
  at 30 s (or the provider's Retry-After, up to 60 s); a wrong key (401/403), bad request (400) or
  unknown model (404) still fails at once. Worst case about 3 minutes before an error.
- 2026-10-11: **End-to-end test with a real Gemini key** (`gemini-3.8-flash` / `gemini-3.5-flash-lite`)
  on `data/samples` through the running app (IPC + editor UI over the DevTools port; only the
  native open/save dialogs were answered with sample paths). Everything except Research passed:
  Raw (7 sample files, SQLite, text + scanned PDF), AI Filter (4/4 price/dealer rows excluded,
  90/90 in scope kept, restore → next run), every Splitter mode (car parts by area 89/94 and by part
  group 89/94 right against the sample's topic manifest), inner-workplace override, HIL routing
  correction, Add to Car (8 requirements, confidence 52–93 %, 83/83 verbatim quotes, Why?),
  decisions/challenge/edit/audit/exports, Analytics, Custom, templates, cancel, settings, editor
  template run with HIL PDF export. Bugs found and fixed on `fix/gemini-max-items`:
  - Gemini rejected every schema with `maxItems` (HTTP 400): PDF import and all Splitter modes
    failed. `maxItems` is now a local constraint for Gemini.
  - Gemini's thinking counts against `maxOutputTokens`: a plan call thought 7,864 of 8,192 tokens
    and was cut off. Gemini/OpenAI caps are now answer + 16,384 thinking headroom (≤ 65,536), and a
    cut-off answer says so.
  - One invalid model answer (unknown ID, quote from the wrong record) failed a whole Splitter run;
    each Splitter call now asks once more, a second invalid answer still fails. Saved 3 of the
    test runs.
  - Priority scoring ("Prioritized feedback" template) failed every run: the note check only
    searched record text, but the model quotes field values ("dealer survey"). Field values and
    source metadata now count; a note that still can't be verified counts as an assumption
    (logged) instead of failing the run. 0 of 582 notes downgraded after the fix. **For WS7
    (Jonas):** this relaxes the earlier hard failure on unverifiable notes — please review.
- 2026-10-11: Human assigned only the selection-only AI Filter feature and authorized necessary
  coordinated core/engine/DB/main/UI integration. Work isolated on `ai-filter-selection` in
  `EHL-ai-filter`; existing `ws5-pdf-ingestion` checkout and concurrent changes untouched. Built
  strict ID classification, unchanged originals/evidence closure, editable presets/criteria/fields,
  saved kept/excluded/review report, verified quotes, and version-checked human restorations that
  apply on an explicit later run only. Confidence is not calibrated; offline mock is labelled and
  conservative. Reverified after integrating latest main (PDF ingestion, shared default AI,
  approved grey-line fade and Splitter car-part depth): `VITEST_MAX_WORKERS=4 npm run check`
  (2,474 passed, 6 skipped) and `npm run smoke` (PASS, 80 native screenshots); reviewed Filter
  light/dark/minimum-window views. PR #22 is the completed feature handoff.
  Synthetic Raw -> Filter -> HIL verifies all dispositions, unchanged objects, human audit,
  unchanged historical outputs and override application only after explicit rerun. Initial default
  test concurrency caused resource-contention timeouts; bounded workers passed the full suite.
  No live API or confidential-data evaluation, vectors or Jev filtering claimed. No other open tasks
  authorized. Classification audit records attempts; succeeded saved report/output proves publication.
  Try: configure Raw -> AI Filter -> HIL, apply the Customer-facing preset, Start, then open the
  Filter report. Restore an excluded item with a rationale; finish/cancel the current run and
  explicitly Start a new run to apply it. Suggested live-model relevance evaluation is informational
  only and needs a new human assignment; no follow-on tasks will be started automatically.

- 2026-10-11: AI Splitter car-part depth (`ws7-splitter-depth`). Split by car parts now offers a
  depth: areas (Exterior, Interior, Technology & chassis) or the 13 part groups of the Car tab (Seats,
  Cockpit & controls, …), each plus Other; the outputs follow the depth automatically instead of the
  branch list (which used to name them "Part group 1…" while the AI invented different groups).
  Groups live in `core/car-parts.ts`, shared with the Car tab's part menu; older flows migrate to
  areas. Smoke: the Car reset step now waits for the requirements to load instead of 600 ms (it
  raced). Verified: `npm run check` (2,316 tests), `npm run smoke` (71 screenshots, incl.
  `splitter-car-part-groups`).
- 2026-10-11: Add to Car verified on merged main (`8cb210d`): `npm run check` (2,314 tests), smoke
  (70 screenshots; editor run → HIL → thought process, Car → Why?), offline `eval:f70` on BMW's F70
  files (2,128 findings, 100 % verbatim excerpts, 10 requirements). Fix: the agents' default AI is
  built by one helper (`directDefaultLlm`) for the app and the eval, so a Gemini or OpenAI default
  AI works in `eval:f70` too. A real-model run still needs a valid key in Settings → AI.
- 2026-10-11: **Add to Car rebuilt as an agent system** on `ws7-add-to-car-agents` (the rule-based
  derive/splitter/taxonomy are gone). Contracts: `Requirement.confidence` + `inputRank`,
  `ReasoningTrace` (`core/reasoning.ts`), `Settings.agents` (API setups + role assignment),
  `DecisionClient`/`AgentServices` on the block context, IPC `reasoning.*` and `settings.testSetup`.
  Add to Car params are now `priorities`, `contexts`, `maxRequirements`, `vehicle`, `market`; older
  flows migrate on load. Providers in `packages/llm` (Claude with adaptive thinking — the 5.x models
  reject `temperature` while thinking, so the old client's `temperature: 0.2` would have failed —,
  Chat Completions, Jev, LLM judge; retries, limiter, provider errors never echoed). Traces stored in
  `reasoning_traces`. Verified: `npm run check` (338 tests) and `npm run smoke` (37 screenshots,
  incl. a run started from the editor through a HIL review into the block's thought process).
  `npm run eval:f70` ran offline on BMW's F70 files (2,128 comments in 58 batches, 100 % verbatim
  excerpts; numbers only, details in `data/raw/eval/`). **Not yet done:** a run with a real model
  (no API key on this machine) and a live Jev call.
- 2026-10-11: Mastra raw splitter and transparent review completed on `ws7-mastra-splitter`, based on
  `origin/main` `9228fb3` (fetched again before handoff; unchanged). Several Raw/Research outputs merge
  into its single input. JSON, SQLite and synthetic Excel integration tests cover all three raw modes.
  Implementation commits through `9e7ad81` are pushed to `origin/ws7-mastra-splitter` for team review.
  Analysis uses the injected `LlmClient`; the default main-process Anthropic adapter uses a standalone
  Mastra Agent, existing model settings and secret-store key. Offline mock is clearly labelled.
  - Discovery batches → global need consolidation → fixed grouping → evidence-linked assignments.
    Original records route exactly once; secondary needs, context and provenance remain inspectable.
    Customer demand uses code-calculated 70% relative frequency + 30% expressed impact, with 2–10
    fixed-width bands. Missing impact gives a NULL score; context is not a vote. Reimports add no vote
    or impact weight, while independent identical comments remain independent. Customer count is unknown.
  - Versioned reports persist with the historical BlockRun. Splitter/HIL show decomposed ranking bars,
    support/opposition/unclear balance, a source-by-need matrix and exact evidence/locator drill-down.
    A human can correct item output routes at a directly connected editable paused HIL, before any
    downstream consumer runs. Required rationale, optimistic version and audit are saved atomically
    with the output snapshot; resume consumes corrected outputs. Original AI explanations, calculated
    scores and requirement decisions stay intact. A forced final audit-insert failure proves rollback
    of report/output writes, unchanged in-memory state and safe retry.
  - Verification: `npm run check` passed (all workspace typechecks, 482 tests passed, 25 unavailable
    real-data tests skipped, Prettier); `npm run smoke` passed on macOS with 36 screenshots. Inspected
    `splitter-demand-ranking`, `splitter-source-heatmap`, `splitter-human-routing-correction`,
    `splitter-original-evidence`, `hil-splitter-review`. Actual editor → SQLite Raw → splitter → HIL
    smoke verifies persisted human correction, audit and resumed data. Recorded fake HTTP exercises
    the real Mastra Agent transport; no live provider or confidential-data calls were made.
  - Next: team reviews this separate branch, integrates its focused core/engine/main/UI additions,
    and verifies a configured live LLM. WS8 requirement scoring and AI Filter remain the existing open
    work. Oversized records/catalogs fail explicitly; this slice does not silently truncate them.
    The original checkout and its active team merge were preserved.
- 2026-10-11: Human requested implementation of the planned Mastra raw splitter, multi-dataset input,
  configurable priority-band granularity, JSON/SQL/Excel compatibility and transparent HIL graphics.
  Pulled latest main into the isolated worktree and started `ws7-mastra-splitter`; parallel work will
  reuse the existing injected LlmClient/settings/key entry. Original checkout has an active team
  merge and is left to its owner. Core/engine/UI additions are the focused integration authorized
  by the human. This branch will be pushed separately, not merged automatically.
- 2026-10-11: Closed the two Add to Car gaps in the shared architecture: `CarService` in
  `packages/engine/src/block.ts` now takes `add(requirements, evidence)` and an optional
  `nextSeq(scope)`; the desktop handlers store sources, cited records, findings and themes with the
  requirements and continue numbering after the highest existing id (seeded demo ids are kept).
  Verified in the app's own handlers on BMW's real F70 export (`handlers.test.ts`, runs only with
  `data/raw/`): Raw → Add to Car run completes, 101 requirements, the detail view has findings,
  verbatim records and sources, a second run adds new ids and changes nothing old.
  `npm run check` and `npm run smoke` pass.
- 2026-10-10: **AI Splitter built** at the existing `ai_splitter` entry point (human requested replacing
  the previous splitter). One input, 2–10 named outputs, priority/category/sentiment/custom modes,
  exact-once primary routing and linked evidence/conflicts retained. No human decisions or requirements
  are changed. Missing priority factors are explicitly provisional; WS8 scoring remains open.
  - Built-in routing runs for an untouched boundary-only inner workplace. Adding blocks/connections
    overrides it with an authored sub-flow. Branch changes synchronize boundaries and report removed
    connections. Legacy saved splitters gain boundaries in memory, without rewriting their files.
  - Main-process LLM uses the run Settings snapshot and SecretsStore. Offline deterministic mock is
    clearly labelled; Anthropic structured-output schema adaptation and validation use fake HTTP tests.
    No live-provider call was made. Abort rejections keep a run cancelled instead of marking it failed.
  - Verification after rebasing onto latest main (`3f8b235`): `npm run check` passed (typecheck,
    204 tests passed, 24 unrelated real-data tests skipped, format check);
    `npm run smoke` passed with 29 screenshots. Inspected `splitter-ten-outputs.png`,
    `splitter-inner-ten.png`, `splitter-inner-two.png`; packaged IPC Raw SQLite → Splitter routes
    three synthetic records exactly once. Use `npm run check` and `npm run smoke` for the handoff gate.
  - Next: WS8 scorer integration and the existing AI Filter/end-to-end checklist. The original WS6
    checkout and its active user/research changes were preserved in place.
- 2026-10-10: OpenCode claimed the AI Splitter slice on `ws7-ai-splitter`, in an isolated worktree
  based on latest `origin/main` (`cea8a29`). Human authorized the focused shared-contract/UI/engine
  changes required for 1 input, 2–10 outputs and an inner workplace. Implement routing and offline
  verification without changing the existing Add to Car implementation. WS8 scoring is still open.
- 2026-10-10 night: **Add to Car built** (`packages/blocks/src/add-to-car/`), deterministic, no LLM:
  - `taxonomy.ts`: 30 components (Seats, Displays/iDrive, Range & charging, …) × 13 aspects + "Overall" (Noise,
    Reliability, Ease of use, Comfort, …), each mapped to a core `RequirementCategory`; pricing and
    dealer topics are out of scope. BMW's VFC level 2/3 names map by rule (all names in the F70/G60/G70
    exports are covered); English and some German keywords for untagged text.
  - `splitter.ts`: clauses are exact substrings of the comment (verbatim excerpts); BMW's tags first
    (the combined "level2 : level3" column survives the Raw block's row merge), keyword rules per clause
    otherwise, an aspect-only clause inherits the previous clause's component.
  - `derive.ts`: findings per theme × polarity (complaint / unmet need / praise, max 20 excerpts, all
    comments counted), one requirement per theme with ≥ 2 complaints/requests; praise on the same theme
    = `conflictingFindingIds`; evidence level, Kano, assumptions and uncertainties by documented rules;
    priority from the input's ranking name (Must/Should/Could/Won't, else position); `mergeDuplicates`
    keeps the best ranking. Tables of figures (studies, sales) are skipped and reported.
  - Real data (local `data/raw/`): F70 2,128 comments → 86 % placed by BMW's classification, 5 % by
    rules, 9 % unplaced; G60/G70 4,000 each, similar. ~100 ms per export.
  - Verify: `npm run check` (the "BMW … → Add to Car" suites run when `data/raw/` has the exports),
    `npm run smoke`. Tests use the real exports, not invented data.
- Contract requests for WS0/WS1: **resolved** (see the log entry above them).
- 2026-10-10 night: Claimed WS7, starting with Add to Car: a deterministic theme splitter
  (component › aspect × polarity, BMW VFC tags first, keyword rules on clauses for untagged text)
  that turns feedback into findings, themes and requirements without an LLM.

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

## WS9 — Analytics & timeline

**Status:** review · **Owner:** Claude Code (Alexander) · **Branch:** `analytics-and-timeline`
**Paths:** `apps/desktop/src/renderer/src/components/analytics/`, `packages/blocks/src/analytics/`;
contract: the `analytics` kind, `analyticsInputs`, `TimeGranularity` and group `insight` in
`packages/core/src/blocks.ts` (requested by the human).

**Tasks**

- [x] Analytics block: 1–8 named inputs (default one, "Add input" on the block), pass-through
      output, params for country/time column overrides, timeline buckets, tracked phrases.
- [x] Full-screen view with eight tabs; rules only, no AI; BMW M chart palette (CVD-validated).
- [x] Compare data sources (inputs, source files, countries, classification columns) with
      two-proportion z-tests; Sankey flow charts; timeline that fills in once data has dates.
- [x] Template "Compare feedback sources"; native smoke scenario with synthetic data only.
- [ ] Persist the computed analytics with the run (today they're recomputed from saved outputs).
- [ ] Try on BMW's real exports locally (structure only in transcripts) and tune the topic lexicon.

**Log**

- 2026-10-11: Built on `analytics-and-timeline` (Haiku subagents wrote the country/time, text and
  sentiment modules and the chart components; lead integrated, wrote dataset/counting/view/tabs).
  Column roles are detected per source file, so sources that name their country column
  differently both count. Verify: `npm run check` (2,500+ tests) and `npm run smoke` (screens
  `analytics-*`, light and dark). Synthetic data only; no BMW values in tests, logs or transcripts.

<!--
Template for your section (replace the "open" line, keep log entries newest-first):

**Status:** in progress · **Owner:** <agent tool + who started it> · **Branch:** ws<N>-<slug>

Log entry:
- YYYY-MM-DD HH:MM: what changed · how to verify (command) · what's next
- Blocked by / needs: …
- Contract change request for WS0: …
-->
