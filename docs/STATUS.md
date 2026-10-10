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
- **HIL block (finalized):** double-click opens the review report: a flow chart of how the data was
  collected (lineage across inner workplaces) and a table icon on every step to see the data there
  (a Raw step's own data, a HIL's connected Raw inputs, or the saved run; no demo data). Runtime logic (pause until reviewed, then pass on) is built and
  tested; it runs once the executor exists.
- **Raw block (built, WS5):** reads `.xlsx` (any sheet), CSV (`,` `;` tab, UTF-8 or Windows-1252, German
  number formats) and read-only SQLite queries into one source + one record per row, with
  deterministic usage findings from take rates and sales volumes. "Choose file…" opens the native
  dialog (`files.import`); "Preview data" in the inspector and the HIL report show the real parsed
  data (`blocks.preview`). Synthetic samples in `data/samples/`. Also reads BMW's real exports
  (feedback, customer studies, sales volumes; see the WS5 log for their shapes) when they're in
  `data/raw/`; the PDF option list is refused for now.
- **Car:** 3D car with every requirement from Add to Car placed on a part (WS3); **Reset** removes
  all requirements (audited, ids never reused). No demo data: the car is empty until a flow runs.
- **Settings:** App, Global parameters, AI & research, Collaboration, About. Changes are validated and
  apply live (theme, grid, minimap). **Not saved to disk yet** (`settings.save` is WS1).
- **Contract:** domain schemas, block specs (`core/src/blocks.ts`), graph rules (`core/src/graph.ts`),
  IPC API, scoring formula, synthetic F70 EU fixtures, block registry, default template.
  Built block implementations: Raw, HIL. **No executor or database exists yet**, so flows don't run.
  Built IPC methods: `app.info`, `templates.list`, `blocks.preview`, `files.import`; every other
  method answers `not_implemented`.
- Repo is public, and Entire is enabled (checkpoints are pushed with every `git push`).

## Open questions for the humans

- Demo scope: **1 Series (F70) · EU · 5 years** (decided 2026-10-10: BMW's data is for the F70).
  Today's F70 has combustion engines only. Should range and charging be in scope for the successor?
- BMW datasets: received 2026-10-10, local only in `data/raw/` (gitignored, also by file name).
  **Transcripts are public:** inspect them with scripts that print structure and counts, never values.

---

## WS0 — Lead / integrator

**Status:** in progress · **Owner:** OpenCode (continuing Claude integration) · **Branch:** `integrate/2026-10-11`

**Tasks**

- [ ] Review and merge PRs (merge commits, never squash); keep `main` green with `npm run check && npm run smoke`.
- [ ] Apply contract-change requests from the sections below (`packages/core`, block params and ports).
- [ ] Integration: run `BMW_DEFAULT_TEMPLATE` end to end with the `mock` LLM, then with Claude and the real data.
- [ ] Demo script and rehearsal (PRODUCT.md → Demo scenario); keep PRODUCT.md and this file current.

**Log**

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

**Status:** open · **Owner:** — · **Branch:** —
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

**Log**

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

**Status:** in progress (car model refinement complete; requirements review pending) · **Owner:** Codex (BMW styling and geometry fixes) · **Branch:** `codex/car-model-refinements`
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

**Log**

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

**Status:** review · **Owner:** Claude Code (lead session) · **Branch:** `main`
**Depends on:** nothing left; next real step needs BMW's files.

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
- [ ] F70 option list (PDF): needs a PDF table reader (e.g. pdfjs) in the Raw block, or BMW's
      list as Excel. Refused with a clear message until then.
- [ ] Customer study findings: per question, how the F70 scores against the other models in the
      same market (deterministic, like the take-rate findings), with the study rows as evidence.
- [ ] If BMW's headers can't be matched automatically: add an optional column-mapping param
      (contract change via WS0).
- [ ] Large exports (≈100k rows): measure preview time and IPC payload; page the preview if needed.
- [ ] PostgreSQL / SQL Server sources, if the demo needs them (credentials in the keychain, never in params).

**Log**

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

**Status:** in progress (Add to Car agents, Mastra raw splitter and transparent review done; AI Filter open) · **Owner:** Claude Code (Add to Car), OpenCode (AI Splitter) · **Branch:** `main` (both merged 2026-10-11)
**Depends on:** nothing for Add to Car and raw-data analysis; WS8 for the legacy requirement-factor scorer integration.

**Tasks**

- [x] Mastra raw-data analysis: customer-demand bands (2–10), car parts and custom instructions.
- [x] Research JSON import alongside existing Excel/SQLite; preserve original provenance.
- [x] Persist explainable score/routing reports and show review charts with evidence drill-down.
- [x] Verify the integrated slice and push `ws7-mastra-splitter` separately for team review.
- [x] `packages/llm`: `createLlmClient(settings.llm, { apiKey })` with an `anthropic` provider (use the
      `claude-api` skill) and a deterministic `mock`; `generateObject` validates with Zod; tests use the mock.
- [ ] AI Filter: keep items matching the criterion, extract findings with verbatim-excerpt
      verification, log every excluded item with a reason.
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

<!--
Template for your section (replace the "open" line, keep log entries newest-first):

**Status:** in progress · **Owner:** <agent tool + who started it> · **Branch:** ws<N>-<slug>

Log entry:
- YYYY-MM-DD HH:MM: what changed · how to verify (command) · what's next
- Blocked by / needs: …
- Contract change request for WS0: …
-->
