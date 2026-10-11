# Guide for judges and review agents

You are reviewing **ReqFlow**, our entry for the BMW hackathon challenge _"AI for Product Decision
Making"_. This page is the fastest way through the repo: what the app does, where each challenge
requirement is implemented, how to run and verify it, and what is not finished. Every link points to a
real file.

> **Research: evaluate the OpenCode Research block.** The repo has two research blocks. **OpenCode
> Research** (`research_opencode`, [packages/blocks/src/research-opencode/](packages/blocks/src/research-opencode/))
> is the one that works end to end and the one we use. It runs the
> [OpenCode](https://opencode.ai) CLI as an autonomous research agent per angle (editorial reviews,
> competitor models, technology, Reddit, YouTube, …), has each agent write a structured
> `research_<agent>.xlsx`, and ingests those workbooks into the same record stream the Raw block
> produces. The older **Research** block (`research`, [packages/blocks/src/research/](packages/blocks/src/research/),
> provider adapters for Firecrawl, Tavily, Exa, Apify, …, documented in
> [docs/research/](docs/research/README.md)) is the earlier provider-based approach; judge research
> capability by the OpenCode block.

## What ReqFlow is, in one paragraph

A native desktop app (Electron; macOS, Windows, Linux) that helps a BMW product manager turn customer
and market evidence into **prioritized, evidence-linked requirements for a successor vehicle** (demo:
1 Series F70, EU). On the **Data Flow** tab the PM wires building blocks (Raw → AI Filter → AI Splitter
→ HIL review → Add to Car, plus Research and Analytics). The **Car** tab shows the resulting
requirements on a 3D car, ranked Must/Should/Could/Won't, each traceable to findings, verbatim excerpts
and sources, where the PM approves, rejects, defers, edits or challenges them. Every change lands in an
append-only audit trail. **The AI proposes; only a human decides.**

## Read in this order

| #   | File                                                                   | Why                                                                       |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | This file                                                              | Map, requirement coverage, how to verify                                  |
| 2   | [PRODUCT.md](PRODUCT.md)                                               | Product definition, decision rules, prioritization method, demo script    |
| 3   | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                           | Stack, processes, IPC API, engine semantics, block contracts              |
| 4   | [packages/core/src/](packages/core/src/)                               | The typed contract (Zod schemas) every other package builds against       |
| 5   | [packages/blocks/src/](packages/blocks/src/)                           | One folder per building block — the actual pipeline logic                 |
| 6   | [apps/desktop/src/main/handlers.ts](apps/desktop/src/main/handlers.ts) | Every IPC call; where decisions, edits, challenges and audit are enforced |

You can skip [docs/STATUS.md](docs/STATUS.md) (a 1,000+ line handoff log between our coding agents),
[docs/WORKSTREAMS.md](docs/WORKSTREAMS.md), [docs/AGENT_PROMPT.md](docs/AGENT_PROMPT.md) and
[docs/AGENT_ROUTING.md](docs/AGENT_ROUTING.md): they organize how our team of humans and AI agents
built the app, not what the app does. [AGENTS.md](AGENTS.md) holds the challenge digest plus rules for
our own coding agents.

## Repo map

```
apps/desktop/                 Electron app
  src/main/                   Main process: IPC handlers, settings, secrets, smoke + demo tests
  src/preload/                The only bridge between UI and main process
  src/renderer/src/           React UI (no Node, no network)
    pages/                    Data Flow, Car, Settings
    components/dataflow/      Block editor (React Flow), run controls, HIL review, reports
    components/car/           3D car (Three.js), parts, requirement placement
    components/requirements/  Requirement browser, review/edit/challenge form, origin report
    components/audit/         Audit timeline
packages/
  core/      Contract: Zod schemas for requirements, findings, sources, scores, audit, IPC, blocks
  engine/    Workflow executor: graph validation, run state, pause/resume at HIL gates
  blocks/    Block implementations: raw, research-opencode, research, ai-filter, ai-splitter,
             hil, add-to-car, prioritization, analytics, templates (BMW default flow)
  llm/       AI clients (Claude, GPT, Gemini via Mastra), schema adapters, offline mock
  db/        SQLite (node:sqlite) repositories, audit log, exports
data/samples/  Synthetic sample data (CSV/XLSX) for tests and the offline demo — no real BMW data
context/       The original challenge briefing
docs/          Architecture, decisions (docs/decisions/), research docs
```

## Challenge requirements → where they live

| Requirement from the brief                          | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ingest BMW data (feedback, equipment, sales, study) | Raw block: [packages/blocks/src/raw/](packages/blocks/src/raw/) — CSV/XLSX/PDF (with OCR), column mapping, market filtering, customer-study comparison findings ([study.ts](packages/blocks/src/raw/study.ts))                                                                                                                                                                                                                                                                                                                |
| Enrich from the web                                 | **OpenCode Research**: [packages/blocks/src/research-opencode/](packages/blocks/src/research-opencode/) (see the note at the top)                                                                                                                                                                                                                                                                                                                                                                                             |
| Signals linked to sources, verbatim evidence        | `EvidenceRef` requires a verbatim excerpt: [packages/core/src/source.ts](packages/core/src/source.ts); findings: [packages/core/src/finding.ts](packages/core/src/finding.ts); quote verification in Add to Car: [packages/blocks/src/add-to-car/agents/evidence.ts](packages/blocks/src/add-to-car/agents/evidence.ts)                                                                                                                                                                                                       |
| Classify, cluster, dedupe ("structure and context") | AI Filter (relevance, keeps every original): [packages/blocks/src/ai-filter/](packages/blocks/src/ai-filter/); AI Splitter (themes, routing, human route corrections): [packages/blocks/src/ai-splitter/](packages/blocks/src/ai-splitter/)                                                                                                                                                                                                                                                                                   |
| Clear, measurable requirements                      | Add to Car agents (draft → critic → confidence): [packages/blocks/src/add-to-car/agents/](packages/blocks/src/add-to-car/agents/); schema with ≥ 1 measurable target and acceptance criterion: [packages/core/src/requirement.ts](packages/core/src/requirement.ts)                                                                                                                                                                                                                                                           |
| Explainable prioritization                          | `ws8-weighted@1`: `score = 100 × Σ(weight × value) / (5 × Σ weight)` ([packages/core/src/scoring.ts](packages/core/src/scoring.ts)); four rule-based factors from the evidence ([factors.ts](packages/blocks/src/prioritization/factors.ts)), two judged by the AI, each with a note and who judged it; weights editable in Settings and stored requirements are rescored                                                                                                                                                     |
| Honest uncertainty and conflicting evidence         | Evidence levels A–D, `conflictingFindingIds`, assumptions and uncertainties on every requirement; a "high score, weak evidence" flag ([scoring.ts](packages/core/src/scoring.ts))                                                                                                                                                                                                                                                                                                                                             |
| PM approves, rejects, edits, challenges             | Car tab review UI: [RequirementReview.tsx](apps/desktop/src/renderer/src/components/requirements/RequirementReview.tsx); allowed transitions: `ALLOWED_DECISIONS` in [packages/core/src/api.ts](packages/core/src/api.ts); challenge re-checks the requirement against its evidence: [packages/core/src/challenge.ts](packages/core/src/challenge.ts)                                                                                                                                                                         |
| AI never decides                                    | Blocks may only add `proposed` requirements (`aiProposalProblem` in [requirement.ts](packages/core/src/requirement.ts), enforced in [handlers.ts](apps/desktop/src/main/handlers.ts)); approved/rejected/deferred are only set by `requirements.decide`, the PM's review form's IPC call; a running block's only write path is `car.add` in its `BlockContext` ([packages/engine/src/block.ts](packages/engine/src/block.ts)), which accepts proposals only; optional four-eyes rule; HIL gates can require several reviewers |
| Audit trail (who/what, when, why)                   | Append-only `AuditEvent` with actor (human/AI model/system), before/after changes and rationale: [packages/core/src/audit.ts](packages/core/src/audit.ts), [packages/db/src/audit.ts](packages/db/src/audit.ts); timeline UI: [components/audit/](apps/desktop/src/renderer/src/components/audit/)                                                                                                                                                                                                                            |
| Not a one-off (other vehicles and markets)          | Scope (1/5/7 Series × EU/CN/US) in Settings; market country lists and vehicle codes: [packages/core/src/scope.ts](packages/core/src/scope.ts)                                                                                                                                                                                                                                                                                                                                                                                 |
| Export                                              | CSV (formula-safe), Markdown, JSON: [packages/db/src/formatters.ts](packages/db/src/formatters.ts); HIL review report as PDF: [apps/desktop/src/main/hil-exporter.ts](apps/desktop/src/main/hil-exporter.ts)                                                                                                                                                                                                                                                                                                                  |

## Run and verify

Needs Node ≥ 22.13. No API key is needed: without one the app uses an offline mock AI, so every
screen, the demo flow and all tests run locally.

```bash
npm install
npm run check   # typecheck + ~3,200 Vitest tests + format check
npm run smoke   # builds the real Electron app, clicks through every screen, saves screenshots
                # to apps/desktop/out/smoke/ and exercises review, audit, export and HIL gates
npm run dev     # open the app
```

Good entry points for reading tests:

- [apps/desktop/src/main/demo-flow.test.ts](apps/desktop/src/main/demo-flow.test.ts) — the BMW
  template on the sample data, end to end, including a restart while paused at a HIL gate.
- [apps/desktop/src/main/decision-rules.test.ts](apps/desktop/src/main/decision-rules.test.ts) —
  allowed decisions, four-eyes rule, "AI never decides".
- [apps/desktop/src/main/challenge.test.ts](apps/desktop/src/main/challenge.test.ts) — what the AI
  sees when the PM challenges a requirement, and how failures are recorded.
- [packages/blocks/src/prioritization/prioritization.test.ts](packages/blocks/src/prioritization/prioritization.test.ts)
  — the scoring rules.
- [packages/blocks/src/research-opencode/index.test.ts](packages/blocks/src/research-opencode/index.test.ts)
  — OpenCode Research orchestration and ingestion.

To run **OpenCode Research** for real, install the [OpenCode CLI](https://opencode.ai) so `opencode`
is on the PATH and give it model access; add the block on the Data Flow tab and connect it like a Raw
block.

## Data policy

The real BMW files are never committed (`data/raw/` is gitignored). Everything in
[data/samples/](data/samples/) is synthetic and generated by scripts in the same folder. API keys are
stored encrypted with the OS keychain (Electron `safeStorage`) and stay in the main process.

## Known limitations (stated honestly)

- Automated tests and smoke runs use the offline mock AI. Output quality with a live model depends on
  the configured provider and has not been benchmarked systematically.
- Offline, the mock splitter has no demand scores, so the PM review gates in the BMW template stay
  empty; a real model fills them.
- OpenCode Research needs the OpenCode CLI installed and its own model access.
- The installer has been built on macOS; Windows and Linux builds are configured but not yet built or tested.
- The Car tab does not yet show the four-eyes approval state or which judge scored each factor (both
  are stored and visible in the audit trail).
