# Architecture

## Stack

| Concern         | Choice                                                                      | Why                                                                                            |
| --------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Language        | TypeScript everywhere (npm workspaces)                                      | One shared contract for UI, engine and nodes                                                   |
| Web app         | Next.js 16 (App Router) + React 19 + Tailwind 4                             | Pages and API route handlers in one app                                                        |
| Workflow canvas | `@xyflow/react` (React Flow)                                                | The standard n8n-style node editor                                                             |
| Schemas         | Zod 4                                                                       | Runtime validation and TS types from a single source; `z.toJSONSchema` drives the config forms |
| LLM             | Claude API (`@anthropic-ai/sdk`) behind `LlmClient`, plus a `mock` provider | Swappable; works offline and in tests                                                          |
| Persistence     | SQLite via built-in `node:sqlite` (`data/app.db`)                           | Zero setup, no native build                                                                    |
| Tests           | Vitest (root config, colocated `*.test.ts`)                                 | Fast, TS-native                                                                                |

## Repo layout

```
.
├── AGENTS.md  PRODUCT.md  README.md   ← start here
├── context/                           ← original hackathon briefing (read-only)
├── docs/                              ← ARCHITECTURE, WORKSTREAMS, decisions/ (ADRs)
├── data/
│   ├── raw/        (gitignored)       ← BMW-provided datasets
│   ├── uploads/    (gitignored)       ← files uploaded through the UI
│   └── samples/                       ← small synthetic datasets for dev
├── packages/
│   ├── core/       ← CONTRACT: domain schemas, service interfaces, API shapes, fixtures
│   ├── engine/     ← node contract + registry (done); graph validation + executor (WS1)
│   ├── nodes/      ← node implementations, one folder per workstream + default template
│   ├── llm/        ← LlmClient implementations: anthropic, mock (WS7)
│   └── db/         ← SQLite repositories, AuditLogger, FileStore (WS1)
└── apps/web/       ← Next.js: pages, components/<area>/, app/api/ route handlers, server/ wiring
```

Dependency direction (no cycles): `core ← engine ← nodes`, `core ← llm`, `core ← db`, and
`apps/web` → all of them. Only `apps/web/src/server` (server-only) wires concrete services together.

## Data flow: one envelope on every edge

Each node has **one input and one output**. The input and output are a `PipelineData`
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

1. **Validate before running.** Every node type is registered, the graph is acyclic, edges point at existing
   nodes, and each node's `config` parses with its `configSchema`. If anything fails, the run fails before it starts,
   with per-node errors.
2. **Execute in topological order.** The input to a node is the merge of its parents' outputs (a source node gets
   an empty envelope). Store each node's output (for "click node → inspect data") and update
   `NodeRun` status, counts, logs and progress.
3. **Failure.** A node that throws is marked `failed` with the error message. Its downstream nodes are marked `skipped`
   and the run is marked `failed`. No partial publish happens.
4. **Pause / resume.** A `review.*` node returns `{status:"paused"}`. The run becomes `waiting_for_review`.
   `POST /api/runs/:id/resume` reloads the latest requirement versions from the DB (the PM may have
   edited them), re-invokes the gate with `ctx.resumed = true`, and continues.
5. **Cancel.** The run's `AbortSignal` fires. Nodes must stop promptly.
6. **Audit.** The engine logs `run.*` events. Nodes log what they create or change. The API logs human actions.

## HTTP API (`apps/web/src/app/api`, JSON, errors use the `ApiError` shape)

| Method & path                                                   | Purpose                                                                                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/nodes`                                                | Node catalog: `NodeCatalogEntry[]` (palette and config JSON Schema)                                                                    |
| `GET/POST /api/workflows` · `GET/PUT/DELETE /api/workflows/:id` | Workflow CRUD (`Workflow`). PUT bumps `version`                                                                                        |
| `GET /api/templates`                                            | Workflow templates (`BMW_DEFAULT_TEMPLATE`)                                                                                            |
| `POST /api/uploads` (multipart)                                 | Store a BMW file → `{ fileId }`                                                                                                        |
| `POST /api/workflows/:id/runs`                                  | Start a run → `WorkflowRun`                                                                                                            |
| `GET /api/runs/:id`                                             | Run status (the UI polls about every 1 s while running)                                                                                |
| `GET /api/runs/:id/nodes/:nodeId/output`                        | That node's output `PipelineData`                                                                                                      |
| `POST /api/runs/:id/resume` · `POST /api/runs/:id/cancel`       | Gate resume / cancel                                                                                                                   |
| `GET /api/requirements?runId&status&category&priority`          | List (latest versions)                                                                                                                 |
| `GET /api/requirements/:id`                                     | Requirement + expanded findings, evidence and sources + version list                                                                   |
| `PATCH /api/requirements/:id`                                   | `RequirementEdit` (rationale required) → new version and audit                                                                         |
| `POST /api/requirements/:id/decision`                           | `RequirementDecision`. `challenge` makes the AI answer (`requirement.challenge_answered`) and sets the requirement back to `in_review` |
| `GET /api/audit?entityId&entityType&actorType&action&runId`     | Audit events, ascending by time                                                                                                        |
| `GET/PUT /api/settings`                                         | `Settings` (PUT logs `settings.changed` with a diff) · `GET /api/settings/status` → which API keys are configured (booleans only)      |
| `GET /api/export?runId&format=json\|csv\|md`                    | Requirement list export (logs `export.created`)                                                                                        |

## AI usage rules

- Use `ctx.llm.generateObject` with a Zod schema for every AI step. Invalid output → throw.
- **Never trust model-cited evidence.** The model returns `recordId` and `excerpt`. Code checks that the excerpt is
  a verbatim substring of that record, and drops or flags the finding if it isn't.
- Batch the records. Use `tier: "fast"` for per-record extraction and `default` for clustering, derivation and challenges.
- AI actors in the audit trail record the exact model id returned by the client.
- The `mock` provider must return schema-valid, deterministic output so the whole pipeline runs offline.
- Prompts live next to the node that uses them (`nodes/src/<area>/<node>.prompt.ts`).

## Persistence notes (WS1)

- Requirements are versioned: one row per `(id, version)`. "Current" means the max version.
- `audit_events` is insert-only, with no update or delete code path.
- Node outputs are stored per `(runId, nodeId)` as JSON.
- Resolve `DATABASE_PATH` and `UPLOAD_DIR` against the repo root (Next runs with `cwd = apps/web`).
