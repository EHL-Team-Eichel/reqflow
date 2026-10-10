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

A visual, n8n-style **data flow** built from **building blocks** turns raw customer and market data into
**evidence-linked, prioritized car requirements**. A product manager reviews, challenges and decides on
them on the **Car** page, and every step is recorded in an **audit trail**.

> Customer requirement = customer-relevant attribute of a car. (BMW briefing)

## Users

- **Product Manager (primary).** Owns the requirement set for one vehicle line × market. Makes every decision.
- **Analyst / PM ops (secondary).** Builds and tunes workflows, connects data and adjusts scoring in Settings.

## The app — three tabs

A **native desktop app for Windows, macOS and Linux**, not a web app. Everything runs locally on
the PM's machine. BMW files are imported through the system file dialog, results are exported
through the save dialog, and API keys are stored in the OS keychain. Only the AI and web-research
calls leave the machine. Layout (sketch: `context/Building_Blocks.jpeg`): the page fills the window, and
a tab bar at the bottom switches between **Data Flow · Car · Settings** (⌘/Ctrl + 1–3).

| Tab           | What the user does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data Flow** | **Building Blocks** on the left, the **Workplace** on the right. Drag blocks (or click them) onto the workplace, connect an output to an input, and set each block's parameters in the inspector. Custom, Research and AI Filter blocks **expand** into their own inner workplace, built from the same blocks. Later: run the flow, see each block's status, counts and logs, and inspect what it produced. A run **pauses at HIL blocks** until a person has reviewed.                                                                                                            |
| **Car**       | The output: what the next car should offer. Today a placeholder (a car and the global vehicle/market). WS3 builds the requirement list here. Each requirement has an ID, title, description, measurable targets, category, score breakdown, priority with rationale, evidence level, assumptions, uncertainties, conflicting evidence and status, with a drill-down requirement → findings → verbatim evidence → source, **approve / reject / defer / edit / challenge** (rationale required) and the **audit trail**: who or what changed what, when, from what to what, and why. |
| **Settings**  | **App** (theme, workplace grid and minimap, delete confirmation) · **Global parameters** (vehicle line, derivative, code, market, horizon; prioritization weights and thresholds with a live example; output language) · **AI & research** (provider, models, temperature, web research, domains, API-key status) · **Collaboration** (your name and role for the audit trail, team members and invitations, sharing via a shared folder or Git repo, notifications, four-eyes approval) · **About**.                                                                              |

## The building blocks

Each block is specified as **Block (params / inner workplace / inputs / outputs)**, e.g. HIL (t/f/1/1)
= has parameters, no inner workplace, 1 input, 1 output. "n" = one port per entry of a list parameter.
Blocks are finalized one at a time; **State** says how far each one is.

| Block           | Spec      | What it does                                                                                                                                                                                                                                                                                                                    | State                                                                                             |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Custom**      | (f/t/1/1) | An empty block. Build any sub-flow inside it.                                                                                                                                                                                                                                                                                   | placeholder                                                                                       |
| **Raw**         | (t/f/0/1) | Brings in an Excel (.xlsx) or CSV file or a SQLite query as one unified data stream: one record per row (repeated feedback rows merged), report-style sheets read by section, plus usage findings from take rates and sales volumes. "Preview data" shows the parsed result right away.                                         | **built**: .xlsx, CSV, SQLite; reads BMW's exports; runs in a flow once the executor exists (WS1) |
| **Research**    | (t/t/0/1) | Searches the web; emits a data stream in the same format as Raw.                                                                                                                                                                                                                                                                | placeholder params                                                                                |
| **AI Filter**   | (t/t/1/1) | Keeps the items that match a criterion written in plain language.                                                                                                                                                                                                                                                               | placeholder params                                                                                |
| **AI Splitter** | (t/f/1/n) | Sorts every item into one branch (e.g. by priority or category). One output per branch.                                                                                                                                                                                                                                         | placeholder params                                                                                |
| **HIL**         | (t/f/1/1) | Human in the loop (capacitor icon). The flow waits here until a person has reviewed what arrived, then passes it on. **Double-click opens the review report:** a flow chart of how the data was collected (every step it passed through, across inner workplaces) and a table icon on every step to see the data at that point. | **finalized** — report and pause/continue logic built; runs once the executor exists (WS1)        |
| **Add to Car**  | (t/f/n/0) | Adds what arrives to the car's requirements. The input it arrives on sets the ranking.                                                                                                                                                                                                                                          | placeholder params                                                                                |

Spec and ports: `packages/core/src/blocks.ts`. Implementations: `packages/blocks/src/<block>/`.

## Default flow (template)

The default template mirrors the BMW process slide (`context/` image). The robot icon means the AI does the step on its own; the person icon means a human is involved.

```
Situation analysis        Structure & context          Prioritization                  Review          Documentation
──────────────────        ───────────────────          ──────────────                  ──────          ─────────────
Raw: customer feedback ┐
Raw: customer study    ┤
Raw: equipment data    ┼─▶ AI Filter ───────────────▶ AI Splitter ──must───▶ 🧑 HIL ──┐
Raw: sales volumes     ┤   "customer-facing only"     "by priority" ──should─▶ 🧑 HIL ──┼─▶ Add to Car
Research: web          ┘   (findings + evidence;       (explainable ──could─────────────┘   (requirements,
                            drops regulatory,           weighted       (unreviewed)          ranked by input)
                            engineering, pricing)       score)
```

**Where AI acts on its own:** ingestion (Raw, Research), filtering and extracting evidence-linked
findings (AI Filter), scoring and routing (AI Splitter), drafting requirements (Add to Car).
**Where a human must act:** at every HIL block, and when approving, rejecting, deferring or editing a
requirement, overriding a priority or answering a challenge on the Car tab. The AI can **never** set
a requirement to `approved` or `rejected`.

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
  pricing or business cases. An AI Filter removes these, and every exclusion is logged with a reason.

## Demo scenario

**BMW 1 Series (F70) · EU · 5-year horizon**, because BMW's data is for the F70: customer feedback,
customer studies (the F70 next to the G60/G68 5 Series and G70 7 Series), sales volumes and the option
list. The requirements are for the F70's successor. This is the default scope in Settings.

1. Open the default template, attach the BMW files to the Raw blocks, enable web research, and run.
2. Watch the blocks fill up, then click the AI Filter to see findings with their evidence.
3. The run pauses at the HIL block. On the Car tab, open a must-have and trace it down to a verbatim customer quote.
4. Challenge one requirement. The AI answers. Edit one, approve one with a priority override, and reject one.
5. Resume the run, which publishes and exports. The audit trail shows the full history of one requirement.
6. Switch the scope to another series or market in Settings to show the workflow isn't a one-off.

## Deliverables checklist (briefing → where we show it)

- [ ] Concept and working prototype → the app and this document
- [ ] Structured sample list of requirements with all the required fields → Car tab and export
- [ ] End-to-end workflow showing which steps the AI does alone and where a human must act → Data Flow tab (HIL blocks) and the diagram above
- [ ] Audit trail from source to decision → audit trail on the Car tab and the requirement History

## Non-goals for the hackathon

Authentication, live multi-user editing and a sync server (Settings → Collaboration keeps the team and
the sharing choice on this computer; sending invitations and syncing come later, if at all), web and
mobile versions, signed installers and auto-update. Any of these can be mocked if the
demo needs them.
