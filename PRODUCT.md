# ReqFlow — product definition

> Working name. One page, the source of truth for **what** we build. **How** is in
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), **who builds what** in [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md).

## Problem

Defining the next generation of a BMW vehicle means working out what customers will value 3–5 years
from now. Today product managers do this by hand: they read customer feedback, BMW equipment and
sales data, customer studies and competitor and market information, then turn it into requirements.
It is slow, inconsistent and hard to trace. Months later nobody can say why a requirement exists,
what evidence backs it, or who decided it.

## Product in one sentence

A visual, n8n-style **workflow** turns raw customer and market data into **evidence-linked, prioritized
car requirements**. A product manager then reviews, challenges and decides on them on a separate
**Requirements** page, and every step is recorded in an **audit trail**.

> Customer requirement = customer-relevant attribute of a car. (BMW briefing)

## Users

- **Product Manager (primary).** Owns the requirement set for one vehicle line × market. Makes every decision.
- **Analyst / PM ops (secondary).** Builds and tunes workflows, connects data and adjusts scoring in Settings.

## The app — three pages (plus the audit trail)

| Page                      | What the user does                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**              | Drag nodes onto a canvas and connect them (BMW datasets, web research, AI analysis steps, scoring, a PM-review gate, publish), then run the workflow. Each node shows its status, item counts and logs, and you can click a node to see the data it produced. A run **pauses at the review gate**.                                                                                                                                             |
| **Requirements** (output) | Shows the result: what the next car should offer. Each requirement has an ID, title, description, measurable targets, category, score breakdown, priority with rationale, evidence level, assumptions, uncertainties, conflicting evidence and status. A detail view goes from requirement → findings → verbatim evidence → source. The PM can **approve / reject / defer / edit / challenge** each one, and must give a rationale every time. |
| **Settings**              | Choose the AI provider and models, the web research provider and allowed domains, the prioritization weights and thresholds, the default scope (vehicle line, derivative, market, horizon) and the reviewer identity.                                                                                                                                                                                                                          |
| **Audit trail**           | A chronological, append-only log: who or what (AI model, PM, system) changed what, when, from what to what, and why. Filterable down to one requirement.                                                                                                                                                                                                                                                                                       |

## Pipeline (default workflow template)

The pipeline mirrors the BMW process slide (`context/` image). The robot icon means the AI does the step on its own; the person icon means a human is involved.

```
Situation analysis      Structure & context            Requirements definition      Prioritization      Review         Documentation
──────────────────      ───────────────────            ───────────────────────      ──────────────      ──────         ─────────────
BMW feedback   ┐
Customer study ┤
Equipment data ┼─▶ extract signals ─▶ scope filter ─▶ cluster ─▶ derive ─▶ specify targets ─▶ score ─▶ 🧑 PM gate ─▶ publish / export
Sales volumes  ┤     (findings +       (drop regulatory, (themes,     (drafts)   (metrics,          (weighted,   (pause until   (Requirements
Web research   ┘      evidence)         engineering,      dedupe)                evidence level,    explainable)  PM decided)    page, JSON/CSV/MD)
                                         pricing)                                assumptions)
```

**Where AI acts on its own:** ingestion, signal extraction, scope filtering, clustering, drafting
requirements, specifying targets, scoring.
**Where a human must act:** approving, rejecting, deferring or editing a requirement, overriding a
priority, answering a challenge, and resuming the run after the gate. The AI can **never** set a
requirement to `approved` or `rejected`.

## Core objects (full schemas in `packages/core`)

- **Source** — a dataset, document or web page, with a reliability rating.
- **SourceRecord** — one comment, row or paragraph from a source.
- **Finding** — a normalized signal (`complaint`, `unmet_need`, `praise`, `competitor_advantage`,
  `market_trend` or `usage_pattern`). It always cites ≥ 1 verbatim evidence excerpt.
- **Theme** — a cluster of duplicate or related findings.
- **Requirement** — `REQ-<vehicle>-<market>-<nnn>`. Holds the description, targets, linked findings and
  sources, score, priority with rationale, **evidence level A–D**, assumptions, uncertainties,
  conflicting findings and **status** (`proposed → in_review → approved | rejected | deferred`, plus
  `challenged`).
- **AuditEvent** — actor, action, entity, before/after changes, rationale and timestamp. Never edited or deleted.

## Prioritization logic (explainable by design)

Six factors, each scored 0–5 with a one-line justification. On every factor, higher means "more worth doing":
customer impact · evidence strength · competitive gap · trend momentum (3–5 yr) · brand fit ·
ease (the inverse of rough effort/cost).

`score = 100 × Σ(weight × value) / (5 × Σ weight)`. The score maps to **must / should / could / won't**
using the thresholds set in Settings. The PM can override the priority, and the override is audited.
Evidence level is shown **next to** the score, never hidden inside it. A high score built on
D-level (assumption) evidence should catch the eye.

## Evidence levels

**A** — several independent sources including quantitative BMW data · **B** — several sources, mostly
qualitative · **C** — a single source or anecdotal · **D** — rests mainly on forward-looking assumptions.

## Scope rules (from the briefing)

- **In scope:** customer-facing attributes such as features, equipment, comfort, space, usability,
  infotainment and digital services, design and quality perception, driving experience, range and charging
  _as the customer experiences them_, and variants and packages.
- **Out of scope:** regulatory and homologation topics, technical and engineering specs, and
  pricing or business cases. The scope filter removes these, and every exclusion is logged with a reason.

## Demo scenario

**BMW 5 Series Sedan · EU · 5-year horizon.** This is our default. Confirm it once BMW's datasets arrive.

1. Open the default template, attach the BMW files, enable web research, and run.
2. Watch the nodes fill up, then click _extract signals_ to see findings with their evidence.
3. The run pauses at the PM gate. On Requirements, open a must-have and trace it down to a verbatim customer quote.
4. Challenge one requirement. The AI answers. Edit one, approve one with a priority override, and reject one.
5. Resume the run, which publishes and exports. The audit trail shows the full history of one requirement.
6. Switch the scope to another series or market in Settings to show the workflow isn't a one-off.

## Deliverables checklist (briefing → where we show it)

- [ ] Concept and working prototype → the app and this document
- [ ] Structured sample list of requirements with all the required fields → Requirements page and export
- [ ] End-to-end workflow showing which steps the AI does alone and where a human must act → Workflow page and the diagram above
- [ ] Audit trail from source to decision → Audit trail page and the requirement History tab

## Non-goals for the hackathon

Authentication and roles (one demo reviewer identity), multi-user live collaboration, production
deployment and real-time streaming. Any of these can be mocked if the demo needs them.
