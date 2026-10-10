# Architecture

ReqFlow is a **native desktop app for Windows, macOS and Linux** (Electron), not a web app.
Background and alternatives: [decisions/0002-electron-desktop-app.md](decisions/0002-electron-desktop-app.md).

## Stack

| Concern         | Choice                                                                                  | Why                                                                                   |
| --------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Language        | TypeScript everywhere (npm workspaces)                                                  | One shared contract for UI, engine and nodes                                          |
| App shell       | Electron 44 (pinned, Node 24 inside), electron-vite 5, electron-builder                 | Same Chromium on every OS; Node in the main process runs the engine                   |
| UI              | React 19 + React Router (hash routing) + Tailwind 4                                     | Renders from `file://` in the installed app                                           |
| Workflow canvas | `@xyflow/react` (React Flow)                                                            | The standard n8n-style node editor                                                    |
| Schemas         | Zod 4                                                                                   | Runtime validation and TS types from one source; `z.toJSONSchema` drives config forms |
| LLM             | Claude API (`@anthropic-ai/sdk`) behind `LlmClient`, plus a `mock` provider             | Swappable; works offline and in tests                                                 |
| Persistence     | SQLite via built-in `node:sqlite`, in the OS app-data folder                            | Zero setup, no native module to rebuild per OS                                        |
| Tests           | Vitest (colocated `*.test.ts`) + `npm run smoke` (screenshots every screen in Electron) | Fast unit tests; a real-app check without clicking                                    |

## Repo layout

```
.
├── AGENTS.md  PRODUCT.md  README.md   ← start here
├── context/                           ← original hackathon briefing (read-only)
├── docs/                              ← ARCHITECTURE, WORKSTREAMS, decisions/ (ADRs)
├── data/
│   ├── raw/        (gitignored)       ← BMW-provided datasets
│   └── samples/                       ← small synthetic datasets for dev
├── packages/
│   ├── core/       ← CONTRACT: domain schemas, service interfaces, IPC API (ipc.ts), fixtures
│   ├── engine/     ← node contract + registry (done); graph validation + executor (WS1)
│   ├── nodes/      ← node implementations, one folder per workstream + default template
│   ├── llm/        ← LlmClient implementations: anthropic, mock (WS7)
│   └── db/         ← SQLite repositories, AuditLogger, FileStore (WS1)
└── apps/desktop/                      ← the Electron app
    ├── electron.vite.config.ts  electron-builder.yml  build/ (icons)
    └── src/
        ├── main/       ← Node: window, IPC handlers, wiring of engine/db/llm, smoke test
        ├── preload/    ← the bridge: allow-listed invoke + run-update events (keep tiny)
        └── renderer/src/
            ├── pages/  components/<area>/  router.tsx
            └── lib/api.ts             ← the only way UI code reaches the main process
```

Dependency direction (no cycles): `core ← engine ← nodes`, `core ← llm`, `core ← db`, and
`apps/desktop/src/main` → all of them. The renderer imports only `@reqflow/core` (types, constants,
fixtures). It never imports engine, db, llm or nodes.

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

## IPC API (`packages/core/src/ipc.ts`)

UI code calls `api.<namespace>.<method>(…)` from `@/lib/api`. Main implements `ReqflowHandlers`
(`apps/desktop/src/main/handlers.ts`). Failures arrive as `ReqflowError` with a `code`
(`invalid_input`, `not_found`, `not_implemented`, `internal`, …). Arguments must be plain data. Main
validates every argument with the Zod schemas, because the renderer counts as untrusted input.

| Method                                               | Purpose                                                                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `app.info()`                                         | Version, OS, data directory                                                                                                         |
| `nodes.catalog()`                                    | `NodeCatalogEntry[]`: palette and config JSON Schema                                                                                |
| `templates.list()`                                   | Workflow templates (`BMW_DEFAULT_TEMPLATE`)                                                                                         |
| `workflows.list/get/save/remove`                     | Workflow CRUD. `save` assigns the id and bumps `version`                                                                            |
| `files.import()`                                     | Native open dialog → copies the file into the data dir → `StoredFileInfo` (`null` if cancelled)                                     |
| `runs.start/get/list/nodeOutput/resume/cancel`       | Run lifecycle. `nodeOutput` returns that node's `PipelineData`                                                                      |
| `runs.onUpdate(listener)`                            | Push events on every status, progress or log change (no polling)                                                                    |
| `requirements.list(filter)` · `requirements.get(id)` | Latest versions · `RequirementDetail` (findings, evidence, sources, versions)                                                       |
| `requirements.edit(id, RequirementEdit)`             | PM edit, rationale required → new version and audit                                                                                 |
| `requirements.decide(id, RequirementDecision)`       | Approve / reject / defer / challenge / reopen. A challenge makes the AI answer (`challenge_answered`) and returns it to `in_review` |
| `audit.list(filter)`                                 | Audit events, ascending by time                                                                                                     |
| `settings.get/save` · `settings.secrets/setSecret`   | `Settings` (save logs `settings.changed` with a diff) · API-key status / store a key in the keychain                                |
| `exports.requirements({ runId, format })`            | Native save dialog → JSON / CSV / Markdown (logs `export.created`)                                                                  |

To add a method: add it to `ReqflowApi` **and** `IPC_INVOKE_METHODS` (the compiler enforces both),
then implement it in `handlers.ts`.

## Data flow: one envelope on every edge

Each node has **one input and one output**. Both are a `PipelineData`
(`sources, records, findings, themes, requirements`). A node reads the keys it `consumes` and returns
the envelope with the keys it `produces` updated. When a node has several incoming edges, the engine
combines them with `mergePipelineData` (concatenate, de-duplicate by `id`, later edge wins).

```ts
defineNode({
  type: "analysis.extract_signals",
  category: "analysis",
  consumes: ["records"],
  produces: ["findings"],
  configSchema: z.object({ batchSize: z.number().int().default(25) }),
  async run(input, config, ctx) {
    /* ctx.llm, ctx.audit, ctx.log … */ return { status: "ok", data: { ...input, findings } };
  },
});
```

## Engine semantics (WS1 implements, everyone relies on)

1. **Validate before running.** Every node type must be registered, the graph must be acyclic, edges
   must point at existing nodes, and each node's `config` must parse with its `configSchema`. If
   anything fails, the run fails before it starts, with per-node errors.
2. **Execute in topological order.** A node's input is the merge of its parents' outputs (a source
   node gets an empty envelope). Store each node's output and push `NodeRun` status, counts, logs and
   progress via `runs.onUpdate`.
3. **Failure.** A node that throws is marked `failed`, its downstream nodes `skipped`, and the run
   `failed`. Nothing is partially published.
4. **Pause / resume.** A `review.*` node returns `{status:"paused"}` → the run is
   `waiting_for_review`. `runs.resume` reloads the latest requirement versions from the DB (the PM may
   have edited them), re-invokes the gate with `ctx.resumed = true`, and continues.
5. **Cancel.** The run's `AbortSignal` fires, and nodes must stop promptly.
6. **Audit.** The engine logs `run.*` events, nodes log what they create or change, and handlers log human actions.

## AI usage rules

- Use `ctx.llm.generateObject` with a Zod schema for every AI step. Invalid output → throw.
- **Never trust model-cited evidence.** The model returns `recordId` and `excerpt`. Code checks that
  the excerpt is a verbatim substring of that record, and drops or flags the finding if it isn't.
- Batch the records. Use `tier: "fast"` for per-record extraction and `default` for clustering, derivation and challenges.
- AI actors in the audit trail record the exact model id returned by the client.
- The `mock` provider must return schema-valid, deterministic output so the whole pipeline runs offline.
- Prompts live next to the node that uses them (`nodes/src/<area>/<node>.prompt.ts`).

## Persistence notes (WS1)

- The database lives in the per-user app-data folder (`main/paths.ts`: macOS
  `~/Library/Application Support/ReqFlow/data`, Windows `%APPDATA%\ReqFlow\data`, Linux
  `~/.config/ReqFlow/data`). `REQFLOW_DATA_DIR` overrides it. Always build paths with `node:path`, never
  with string concatenation (Windows uses `\`).
- Only one app instance runs at a time (single-instance lock), so only one process writes SQLite.
- Requirements are versioned: one row per `(id, version)`. "Current" means the max version.
- `audit_events` is insert-only, with no update or delete code path.
- Node outputs are stored per `(runId, nodeId)` as JSON. Imported files are copied into `data/uploads/` inside the data dir.

## Running, checking, packaging

| Command (repo root) | What it does                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`       | Opens the app with hot reload (renderer) and auto-restart (main)                                                                         |
| `npm run smoke`     | Builds, opens every screen, screenshots it to `apps/desktop/out/smoke/`, checks the IPC bridge, and exits non-zero on any renderer error |
| `npm run check`     | Typecheck + unit tests + format check                                                                                                    |
| `npm run package`   | Installer for the **current** OS in `apps/desktop/release/`: `.exe` (NSIS), `.dmg` or `.AppImage`                                        |

Installers must be built on their own OS (or in a CI matrix later). Builds are unsigned, so macOS
Gatekeeper and Windows SmartScreen show a warning on first launch. Code signing is out of scope for the
hackathon. Linux CI needs a virtual display (`xvfb-run`) for `smoke`.
