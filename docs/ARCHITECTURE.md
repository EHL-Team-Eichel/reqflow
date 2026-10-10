# Architecture

ReqFlow is a **native desktop app for Windows, macOS and Linux** (Electron), not a web app.
Background and alternatives: [decisions/0002-electron-desktop-app.md](decisions/0002-electron-desktop-app.md).
Why the flow is built from blocks: [decisions/0003-building-blocks.md](decisions/0003-building-blocks.md).

## Stack

| Concern         | Choice                                                                                | Why                                                                 |
| --------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Language        | TypeScript everywhere (npm workspaces)                                                | One shared contract for UI, engine and blocks                       |
| App shell       | Electron 44 (pinned, Node 24 inside), electron-vite 5, electron-builder               | Same Chromium on every OS; Node in the main process runs the engine |
| UI              | React 19 + React Router (hash routing) + Tailwind 4 + zustand 5                       | Renders from `file://` in the installed app; small, testable stores |
| Workflow canvas | `@xyflow/react` (React Flow 12)                                                       | The standard n8n-style node editor                                  |
| Schemas         | Zod 4                                                                                 | Runtime validation and TS types from one source                     |
| LLM             | Claude API (`@anthropic-ai/sdk`) behind `LlmClient`, plus a `mock` provider           | Swappable; works offline and in tests                               |
| Persistence     | SQLite via built-in `node:sqlite`, in the OS app-data folder                          | Zero setup, no native module to rebuild per OS                      |
| Tests           | Vitest (colocated `*.test.ts`) + `npm run smoke` (clicks through the app in Electron) | Fast unit tests; a real-app check without clicking                  |

## Repo layout

```
.
├── AGENTS.md  PRODUCT.md  README.md   ← start here
├── context/                           ← original hackathon briefing + the app sketch (read-only)
├── docs/                              ← ARCHITECTURE, WORKSTREAMS, STATUS, decisions/ (ADRs)
├── data/
│   ├── raw/        (gitignored)       ← BMW-provided datasets
│   └── samples/                       ← small synthetic datasets for dev
├── packages/
│   ├── core/       ← CONTRACT: domain schemas, blocks.ts (block specs), graph.ts (graph rules), IPC API, fixtures
│   ├── engine/     ← block contract + registry (done); executor (WS1)
│   ├── blocks/     ← block implementations, one folder per block + default template
│   ├── llm/        ← LlmClient implementations: anthropic, mock (WS7)
│   └── db/         ← SQLite repositories, AuditLogger, FileStore (WS1)
└── apps/desktop/                      ← the Electron app
    ├── electron.vite.config.ts  electron-builder.yml  build/ (icons)
    └── src/
        ├── main/       ← Node: window, IPC handlers, wiring of engine/db/llm, smoke test
        ├── preload/    ← the bridge: allow-listed invoke + run-update events (keep tiny)
        └── renderer/src/
            ├── pages/        DataflowPage · CarPage · SettingsPage
            ├── components/   dataflow/ (editor + its store) · settings/ · shell/ (bottom tabs) · ui/ (shared controls)
            ├── lib/          api.ts (the only way to main) · settings.ts (settings store) · theme.ts
            └── router.tsx  globals.css (design tokens, light + dark)
```

Dependency direction (no cycles): `core ← engine ← blocks`, `core ← llm`, `core ← db`, and
`apps/desktop/src/main` → all of them. The renderer imports only `@reqflow/core` (types, block specs,
graph rules, fixtures). It never imports engine, db, llm or blocks.

## Processes and security

```
renderer (React, sandboxed)  ──api.x.y(…)──▶  preload (allow-list)  ──IPC──▶  main (Node)
   no Node, no fs, no network                                              engine · SQLite · LLM · files · keychain
           ◀──────────────── runs.onUpdate(run) push events ────────────────────────┘
```

- `contextIsolation`, `sandbox` and no `nodeIntegration`. Production builds get a strict CSP
  (`connect-src 'self'`): all network calls (Claude, web search) happen in main.
- The preload only forwards channels listed in `IPC_INVOKE_METHODS`. Main also checks that the sender is the app window.
- The window never navigates away. `http(s)` links open in the user's browser.
- API keys are entered in Settings, encrypted with Electron `safeStorage` (OS keychain) and never sent to
  the renderer. In dev, `apps/desktop/.env` is also read (see `.env.example`).

## The building blocks (`packages/core/src/blocks.ts`)

A workflow is a tree of **workplaces**. Each workplace holds blocks and edges. Seven kinds of block
are in the palette, defined once in `BLOCK_SPECS` (label, description, group, params, ports, whether
it has an inner workplace):

| Block       | Ports                                 | Inner workplace | Params (placeholders for now)                                                   |
| ----------- | ------------------------------------- | --------------- | ------------------------------------------------------------------------------- |
| Custom      | 1 in · 1 out                          | yes             | none                                                                            |
| Raw         | no input · 1 out (data stream)        | no              | Excel upload or database, dataset, file/query                                   |
| Research    | no input · 1 out (same format as Raw) | yes             | question, source types, market, age, results                                    |
| AI Filter   | 1 in · 1 out (kept)                   | yes             | criterion, model, min. confidence                                               |
| AI Splitter | 1 in · one out **per branch**         | no              | split by, branches (list → ports), model                                        |
| HIL         | 1 in · 1 out                          | no              | reviewer, instructions, approvals, edits                                        |
| Add to Car  | one in **per priority** + context ins | no              | priorities, contexts (Auto / Sales volumes), max. requirements, vehicle, market |

- **Ports** come from `blockPorts(block)`. They can depend on params (the splitter's `branches`, Add to
  Car's `priorities` → `in-0` "1. Priority" … and `contexts` → `ctx-0` "Context 1 · Auto" …), and port
  ids are positional (`out-0`, `in-2`, `ctx-0`). Older flows are migrated on load (`migrateGraph`). When params change, `setBlockParams`
  removes edges on ports that no longer exist and returns them, so the editor can tell the user.
- **Params** are declared as `ParamSpec`s (text, textarea, number, slider, select, multiselect, toggle,
  list — free text, or one of `itemOptions` per entry — and file). The editor renders a form from them, and `parseBlockParams` validates strictly (unknown
  keys and wrong types are errors). Select options with the value `"global"` mean "use Settings →
  Global parameters".
- **Inner workplaces** (Custom, Research, AI Filter) hold a sub-flow built from the same blocks,
  recursively. Each one has fixed **boundary blocks**: one `block_input` per input port of the parent
  and one `block_output` per output port. They are created with the block and can't be deleted.
- **Ids** are unique across the whole tree, so run status and outputs are keyed by block id alone.
- **Graph rules** live in `packages/core/src/graph.ts` and are shared by the editor and the engine:
  `checkConnection` (ports exist, no self-loop, no duplicates, no cycles), `connect`, `removeBlocks`,
  `setBlockParams`, `graphAt` / `updateGraphAt` (navigate the tree), `validateGraph` (everything,
  recursively). Several edges may enter one input (merged) or leave one output (fan-out).

## Add to Car agents

`packages/blocks/src/add-to-car/agents/`. Code does everything that must be exact; models read,
group, write and judge. One run of the block:

```
context reader ─┐ (sales volumes summarized by code; Auto: a data profile the reader explains)
analysts (map) ─┴→ synthesizer (themes) → code picks themes → architect ⇄ critic → judge → code
```

- **Analysts** read the priority inputs in batches (≤ 50 records, ≤ 14k chars, one input per batch)
  and return signals with record refs and quotes. Code checks every quote against the record
  (`findVerbatim`; a quote that isn't verbatim becomes the record's opening words) and turns signals
  into `Finding`s. Upstream findings are reused as they are.
- **Synthesizer** groups signals into themes (per category when there are many, then a merge pass).
  **Code** picks the themes: most important input first, then evidence weight (mentions ÷ rank);
  single comments and themes below `maxRequirements` are listed as held back, never dropped silently.
- **Architect** writes one requirement per theme from its strongest signals and the context briefs;
  the **critic** reviews it (accept / one rewrite / reject) and scores the six factors.
- **Judge** answers four typed questions (backed by evidence? customer-facing? still wanted at launch?
  testable?) through a `DecisionClient`: TypeSafe Jev (a "System 1" decision model with calibrated
  probabilities) or any LLM answering the same questions.
- **Code** assigns ids, priority from the input rank (first third of n inputs must, then should,
  then could), the critic's weighted score, evidence level A–D, and the confidence: a weighted
  geometric mean of the judge's answers, evidence breadth, the critic's verdict and conflicts.
- Everything is recorded in a `ReasoningTrace` (`packages/core/src/reasoning.ts`), stored by run and
  block (`reasoning_traces`) and shown in the thought-process view (block button, inspector, Car → Why?).
- Each role runs on an API setup (Settings → AI → Agents; `apps/desktop/src/main/agents.ts`). Providers
  live in `packages/llm`: Claude (adaptive thinking by effort, summarized thinking kept for the trace),
  OpenAI / Gemini / OpenAI-compatible Chat Completions, TypeSafe Jev, and the offline mock, which runs
  the same pipeline by rules and marks everything "[Offline]".
- `npm run eval:f70` runs the agents on BMW's F70 files with the user's setups and prints numbers only;
  the full output goes to `data/raw/eval/` (gitignored).

## Data flow: one envelope per port

Every port carries a `PipelineData` envelope (`sources, records, findings, themes, requirements`).
Raw and Research emit sources and records (the "unified data stream"). Later blocks enrich the same
envelope: AI Filter keeps matching items (and extracts evidence-linked findings), AI Splitter routes
items to one branch each, HIL passes on what the reviewer approved, and Add to Car's agents turn what
arrives on its priority inputs into requirements (the input it arrives on sets the ranking; context
inputs are background only, see "Add to Car agents"). Several edges into one input are combined
with `mergePipelineData` (concatenate, de-duplicate by `id`, later edge wins).

```ts
defineBlock({
  kind: "ai_filter",
  async run(inputs, params, ctx) {
    const input = inputs.in; // one envelope per input port id
    /* ctx.llm, ctx.audit, ctx.log … */
    return { status: "ok", outputs: { out: kept } }; // one envelope per output port id
  },
});
```

## Engine semantics (WS1 implements, everyone relies on)

1. **Validate before running** with `validateGraph`, and check that every block kind (except
   Custom) has an implementation (`BlockRegistry.missing()`). If anything fails, the run fails before it
   starts, with per-block errors.
2. **Execute each workplace in topological order.** A block's input per port is the merge of what its
   incoming edges carry. Store each block's output per port and push `BlockRun` status, counts, logs
   and progress via `runs.onUpdate`.
3. **Inner workplaces.** A block whose inner workplace contains blocks runs that sub-flow: each
   `block_input` emits what arrived on its parent port, and what reaches each `block_output` becomes
   the parent's output on that port. A Custom block always runs its sub-flow. Research and AI Filter run
   their built-in implementation while their inner workplace is empty.
4. **Failure.** A block that throws is marked `failed`, its downstream blocks `skipped`, and the run
   `failed`. Nothing is partially published.
5. **Pause / resume.** HIL returns `{ status: "paused" }` → the run is `waiting_for_review`.
   `runs.resume` reloads what the reviewer changed, re-invokes the block with `ctx.resumed = true`, and continues.
6. **Cancel.** The run's `AbortSignal` fires, and blocks must stop promptly.
7. **Audit.** The engine logs `run.*` events, blocks log what they create or change, and handlers log human actions.

## IPC API (`packages/core/src/ipc.ts`)

UI code calls `api.<namespace>.<method>(…)` from `@/lib/api`. Main implements `ReqflowHandlers`
(`apps/desktop/src/main/handlers.ts`). Failures arrive as `ReqflowError` with a `code`
(`invalid_input`, `not_found`, `not_implemented`, `internal`, …). Arguments must be plain data. Main
validates every argument with the Zod schemas, because the renderer counts as untrusted input.

| Method                                               | Purpose                                                                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `app.info()`                                         | Version, OS, data directory (**built**)                                                                                                   |
| `templates.list()`                                   | Workflow templates (`BMW_DEFAULT_TEMPLATE`) (**built**)                                                                                   |
| `workflows.list/get/save/remove`                     | Workflow CRUD. `save` assigns the id and bumps `version`                                                                                  |
| `blocks.preview(request)`                            | Runs a block without inputs (Raw) on its own and returns its output and log (**built**)                                                   |
| `files.import()`                                     | Native open dialog → copies the file into the data dir → `StoredFileInfo` (`null` if cancelled). Raw's `file` param stores it (**built**) |
| `runs.start/get/list/blockOutput/resume/cancel`      | Run lifecycle. `blockOutput` returns that block's output per port                                                                         |
| `runs.onUpdate(listener)`                            | Push events on every status, progress or log change (no polling)                                                                          |
| `requirements.list(filter)` · `requirements.get(id)` | Latest versions · `RequirementDetail` (findings, evidence, sources, versions)                                                             |
| `requirements.edit(id, RequirementEdit)`             | PM edit, rationale required → new version and audit                                                                                       |
| `requirements.decide(id, RequirementDecision)`       | Approve / reject / defer / challenge / reopen. A challenge makes the AI answer (`challenge_answered`) and returns it to `in_review`       |
| `requirements.reset()`                               | Removes every requirement (Car page → Reset). Writes one `requirement.deleted` audit event each; ids are never reused                     |
| `audit.list(filter)`                                 | Audit events, ascending by time                                                                                                           |
| `settings.get/save` · `settings.secrets/setSecret`   | `Settings` (save logs `settings.changed` with a diff) · API-key status / store a key in the keychain                                      |
| `exports.requirements({ runId, format })`            | Native save dialog → JSON / CSV / Markdown (logs `export.created`)                                                                        |

To add a method: add it to `ReqflowApi` **and** `IPC_INVOKE_METHODS` (the compiler enforces both),
then implement it in `handlers.ts`.

## HIL review report

Double-clicking a HIL block (or its report icon) opens `components/dataflow/report/HilReport.tsx`:

- **Flow chart** from `traceLineage(root, path, blockId)` (`packages/core/src/lineage.ts`): every step
  data passes through on its way into the block. It leaves inner workplaces through their
  `block_input` and traces through the sub-flow of upstream blocks that have blocks inside.
- **Data at a step** (table icon on every step; the HIL itself = "data at this point"). Steps without
  inputs (Raw) show their **real data** via `blocks.preview`, and so does a HIL fed directly by them.
  After a run it shows `api.runs.blockOutput()` of the step (for the HIL: the merge of what its
  incoming edges carried). Otherwise it says nothing has arrived yet; there is no demo data.
- At run time the HIL block (`packages/blocks/src/hil/hil.ts`) pauses the run until the review is done
  and then passes the data on unchanged; edits go through the requirement API (audited).

## Renderer state

- **`components/dataflow/store.ts`**: the editor store (zustand). It holds the workflow tree, the
  open workplace (`path`), the selection, React Flow sizes and a notice. Every edit goes through the
  core graph rules; errors become a visible notice, never a silent no-op. It lives for the whole app
  session, so switching tabs keeps the flow. It isn't saved to disk yet (`workflows.*` is WS1).
- **`lib/settings.ts`**: the settings store. It loads `settings.get()` at startup, validates every
  change with the `Settings` schema and saves in the background. While main has no settings storage
  (`not_implemented`), it keeps the defaults and the Settings page says so.
- **zustand 5 rule:** never return a new object or array from a selector (it re-renders forever).
  Select existing objects or primitives and derive the rest with `useMemo`.
- **Theme:** `lib/theme.ts` sets `<html data-theme>` from Settings (system, light or dark). The CSS
  tokens in `globals.css` follow it, so use token classes (`bg-panel`, `text-muted`, …), never hex colors.
- **Colorway: BMW M.** The M stripe colours (`m-light` #81C4FF, `m-dark` #16588E, `m-red` #E7222E) on
  carbon neutrals. Block groups take them: sources light blue, AI dark blue, HIL red (a person has to
  act), Add to Car neutral. `MStripe` (`components/ui/`) marks the active tab. Filled controls use
  `bg-brand-fill` so white text stays readable in both themes.

## AI usage rules

- Use `ctx.llm.generateObject` with a Zod schema for every AI step. Invalid output → throw.
- **Never trust model-cited evidence.** The model returns `recordId` and `excerpt`. Code checks that
  the excerpt is a verbatim substring of that record, and drops or flags the finding if it isn't.
- Batch the records. Use `tier: "fast"` for per-record extraction and `default` for clustering, derivation and challenges.
- AI actors in the audit trail record the exact model id returned by the client.
- The `mock` provider must return schema-valid, deterministic output so the whole pipeline runs offline.
- Prompts live next to the block that uses them (`blocks/src/<block>/<name>.prompt.ts`).

## Persistence notes (WS1)

- The database lives in the per-user app-data folder (`main/paths.ts`: macOS
  `~/Library/Application Support/ReqFlow/data`, Windows `%APPDATA%\ReqFlow\data`, Linux
  `~/.config/ReqFlow/data`). `REQFLOW_DATA_DIR` overrides it. Always build paths with `node:path`, never
  with string concatenation (Windows uses `\`).
- Only one app instance runs at a time (single-instance lock), so only one process writes SQLite.
- Workflows are stored whole (the block tree as JSON) and versioned on save.
- Requirements are versioned: one row per `(id, version)`. "Current" means the max version.
- `audit_events` is insert-only, with no update or delete code path.
- Block outputs are stored per `(runId, blockId, port)` as JSON. Imported files are copied into `uploads/`
  inside the data dir by the file store (`packages/db/src/files.ts`, built), metadata next to each file.

## Running, checking, packaging

| Command (repo root) | What it does                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`       | Opens the app with hot reload (renderer) and auto-restart (main)                                                                                                                                                                                                                                                                                                            |
| `npm run smoke`     | Builds, then drives the real app off screen: opens every screen, adds every block, opens an inner workplace, types into fields, connects ports by mouse drag (and checks a loop is refused), walks the settings, switches to dark mode, screenshots each step to `apps/desktop/out/smoke/`, checks the IPC bridge, and exits non-zero on any failed check or renderer error |
| `npm run check`     | Typecheck + unit tests + format check                                                                                                                                                                                                                                                                                                                                       |
| `npm run package`   | Installer for the **current** OS in `apps/desktop/release/`: `.exe` (NSIS), `.dmg` or `.AppImage`                                                                                                                                                                                                                                                                           |

Installers must be built on their own OS (or in a CI matrix later). Builds are unsigned, so macOS
Gatekeeper and Windows SmartScreen show a warning on first launch. Code signing is out of scope for the
hackathon. Linux CI needs a virtual display (`xvfb-run`) for `smoke`.
