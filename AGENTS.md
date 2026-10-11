# AGENTS.md — read this first

## What we're building

**ReqFlow** is a hackathon prototype for the BMW challenge _"AI for Product Decision Making"_: a
**native desktop app for Windows, macOS and Linux** (Electron, not a web app) with three tabs. On
**Data Flow**, an n8n-style flow of **building blocks** (Custom, Raw, Research, AI Filter, AI Splitter,
HIL, Add to Car, Analytics; some expand into their own inner workplace) turns customer and market data into
prioritized, evidence-linked car requirements. The **Car** tab shows them for the PM to review, and
**Settings** configures the app, global parameters and collaboration. Full spec: [PRODUCT.md](PRODUCT.md). Your task: [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md).
Current state and handoffs: [docs/STATUS.md](docs/STATUS.md).

## The challenge in brief (from `context/`)

- **Goal:** help BMW product managers define, justify and prioritize **customer-facing requirements
  for the successor** of an existing vehicle, thinking **3–5 years ahead**. The PM stays in control of
  every decision.
- **Vehicles and markets:** the 1, 5 or 7 Series, in Europe, China or the US. Demo **one derivative in one
  market** (ours: 1 Series F70, EU), but don't build a one-off.
- **BMW provides, per vehicle:** customer feedback, equipment data, sales volumes and a customer study.
  We may add web sources such as competitors, reviews and market or technology trends.
- **The app must:** ingest the data and enrich it from the web → extract signals (complaints, unmet needs,
  competitor advantages, trends), **each linked to its sources** → derive clear, actionable, realistic
  requirements → prioritize them with explainable logic → let the PM approve, reject, edit or challenge
  them → record everything in an **audit trail** (who or what, when, and why).
- **Each requirement needs:** a unique ID, an actionable description, linked findings and sources, a
  priority or score, the prioritization rationale, an evidence level, assumptions and uncertainties, and
  a decision status.
- **In scope:** features, equipment, comfort, space, usability, infotainment and digital services,
  design and quality perception, driving experience, range and charging as the customer experiences them,
  and variants and packages. **Out of scope:** regulatory and homologation topics, engineering specs, and
  pricing or business cases (rough effort may be used as a priority factor).
- **Judges value:** trustworthy sources, transparent reasoning, thoughtful prioritization, honest
  handling of uncertainty and **conflicting evidence**, and focus on customer value. Depth in one area
  beats shallow coverage of everything.
- **BMW process we mirror:** situation analysis → structure and context (classify, cluster, dedupe) →
  requirements definition (measurable targets and acceptance criteria) → prioritization (customer and
  business) → documentation and tracking. _"From 1 billion findings to 1,000 requirements to one car."_

## Rules for every agent

1. **Stay in your lane.** Edit only the paths your workstream owns (see WORKSTREAMS.md). Do you need
   something changed elsewhere? Write it in your final report instead of editing it yourself.
2. **`packages/core` is the contract.** Build against it and don't change it on your own. If you need a
   contract change, propose it in your final report. The lead merges contract changes.
3. **No real data in git, logs or transcripts.** BMW files go in `data/raw/` (gitignored). Entire
   publishes session transcripts, so when you inspect them, print only structure and counts (sheet
   and column names, row counts), never cell values, and never send them to delegated agents.
   Committed tests use synthetic data (`@reqflow/core/fixtures`, `data/samples/`). Never commit or
   print API keys.
4. **No silent failures.** Validate inputs with the Zod schemas, throw clear errors, and never invent
   sources or evidence. Every finding needs a verbatim excerpt.
5. **AI never decides.** Only a human sets `approved`, `rejected` or `deferred`. Every change to a
   requirement writes an AuditEvent.
6. **Prove it works.** Add colocated `*.test.ts` files. Before you report done, run
   `npm run typecheck && npm test` from the repo root. For UI work, also run `npm run smoke` and look at
   the screenshots in `apps/desktop/out/smoke/`.
7. **Respect the process split.** UI code (renderer) has no Node, no `fs` and no network. It talks to the
   main process only through `api` from `@/lib/api` (contract: `packages/core/src/ipc.ts`). Data, AI
   calls, files and API keys live in the main process. Build paths with `node:path` so they work on Windows.
8. **Sessions are tracked with [Entire](https://github.com/entireio/cli).** Commit with plain `git`.
   Entire attaches your session to each commit as a checkpoint and pushes it on `git push`. Don't
   remove its hooks (`.claude/settings.json`, `.git/hooks`) and never put secrets in prompts.

9. **Hand off in [docs/STATUS.md](docs/STATUS.md).** Claim your workstream there when you start; your
   tasks are the checklist in its section, in priority order. Update your own section (and only that
   one) when you finish a slice, get blocked or stop: tick done tasks, add a log entry. The next agent
   starts from it. The repo and Entire transcripts are **public**, so never paste keys or BMW data anywhere.

## Commands (repo root, Node ≥ 22.13; works on Windows, macOS, Linux)

```
npm install          # once
npm run dev          # opens the desktop app with hot reload
npm run smoke        # builds, screenshots every screen, checks the IPC bridge
npm test             # vitest, all packages
npm run typecheck    # all workspaces
npm run format       # prettier
npm run package      # installer for your OS → apps/desktop/release/
```
