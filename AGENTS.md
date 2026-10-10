# AGENTS.md — read this first

## What we're building

**ReqFlow** is a hackathon prototype for the BMW challenge _"AI for Product Decision Making"_. An
n8n-style **workflow** turns customer and market data into prioritized, evidence-linked car
requirements. A PM reviews them on a **Requirements** page, and a **Settings** page configures the
app. Full spec: [PRODUCT.md](PRODUCT.md). Your task: [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md).

## The challenge in brief (from `context/`)

- **Goal:** help BMW product managers define, justify and prioritize **customer-facing requirements
  for the successor** of an existing vehicle, thinking **3–5 years ahead**. The PM stays in control of
  every decision.
- **Vehicles and markets:** the 1, 5 or 7 Series, in Europe, China or the US. Demo **one derivative in one
  market** (ours: 5 Series Sedan, EU), but don't build a one-off.
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
3. **No real data in git.** BMW files go in `data/raw/` (gitignored). Use synthetic fixtures from
   `@reqflow/core/fixtures` until the real data arrives. Never commit or print API keys.
4. **No silent failures.** Validate inputs with the Zod schemas, throw clear errors, and never invent
   sources or evidence. Every finding needs a verbatim excerpt.
5. **AI never decides.** Only a human sets `approved`, `rejected` or `deferred`. Every change to a
   requirement writes an AuditEvent.
6. **Prove it works.** Add colocated `*.test.ts` files. Before you report done, run
   `npm run typecheck && npm test` from the repo root. For UI work, also load the page and check it.
7. **Working in `apps/web`?** Read `apps/web/AGENTS.md` too. Next.js 16 differs from older versions,
   and its bundled docs live in `node_modules/next/dist/docs/`.

8. **Sessions are tracked with [Entire](https://github.com/entireio/cli).** Commit with plain `git`.
   Entire attaches your session to each commit as a checkpoint and pushes it on `git push`. Don't
   remove its hooks (`.claude/settings.json`, `.git/hooks`) and never put secrets in prompts.

## Commands (repo root, Node ≥ 22.13)

```
npm install          # once
npm run dev          # web app on http://localhost:3000
npm test             # vitest, all packages
npm run typecheck    # all workspaces
npm run format       # prettier
```
