# ReqFlow

From customer evidence to prioritized, PM-approved vehicle requirements. A **desktop app for Windows,
macOS and Linux** (Electron), built as a hackathon prototype for the BMW challenge _AI for Product
Decision Making_.

| Read                                         | For                                                     |
| -------------------------------------------- | ------------------------------------------------------- |
| [PRODUCT.md](PRODUCT.md)                     | What we build and why (the product definition)          |
| [AGENTS.md](AGENTS.md)                       | Challenge digest and rules for every coding agent       |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, layout, processes, IPC API, engine semantics     |
| [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md)   | Parallel work packages and path ownership               |
| [docs/STATUS.md](docs/STATUS.md)             | Current state, task list per workstream, handoffs       |
| [docs/AGENT_PROMPT.md](docs/AGENT_PROMPT.md) | The prompt that starts a new AI teammate                |
| [docs/decisions/](docs/decisions/)           | Architecture decisions (why Electron, why one TS stack) |
| [context/](context/)                         | Original briefing material                              |

## Setup (once)

Requires Node ≥ 22.13 (see `.nvmrc`) and git. Install **Entire**, which records agent sessions as
checkpoints on each commit:

- macOS / Linux:

  ```bash
  brew install --cask entireio/tap/entire
  ```

- Windows (PowerShell):

  ```powershell
  irm https://entire.io/install.ps1 | iex
  ```

Then, in each clone:

```bash
entire enable --agent claude-code
```

```bash
npm install
```

Optional, dev only: copy `.env.example` to `apps/desktop/.env` and add an `ANTHROPIC_API_KEY`. Without
one, the default AI provider is the offline `mock`.

## Mastra AI Judge

The existing **Add to Car** block turns connected datasets into evidence-linked proposals, using four roles:
scope resolver, web researcher, solution proposer and an independent confidence judge. Importance
is computed deterministically; solution confidence is displayed separately on the Car tab.

1. In **Settings → AI & research**, save an OpenAI key (OS-protected storage), or configure
   `OPENAI_API_KEY` in the main-process development environment. Stored keys are never displayed.
2. Add Raw blocks for feedback, studies and optional sales context. Connect them to Add to Car's
   inputs; order the source labels from most important to least important.
3. In Add to Car, use **Requirement generation → AI agents (OpenAI)**. Set **Part or problem**,
   for example `seats`, or leave it blank for all customer-facing topics. The default model is
   `openai/gpt-6-luna`. **Offline agent demo** makes no model calls and leaves confidence at zero.
4. Press **Start**. The existing executor runs the agents inside Add to Car and publishes proposals
   to the existing Car store. No separate Judge node is required. Existing HIL blocks still pause
   for review where connected. Publishing does not approve a requirement. Older saved flows keep
   their rules-only behavior; choose AI agents in the inspector to enable judging.
5. On **Car**, select a part and expand **Why, uncertainty & evidence** to see source excerpts,
   assumptions, conflicts and separate importance/confidence scores.

Live runs send selected internal evidence to OpenAI. Web research is opt-in, uses the domain policy
from Settings and accepts only exact normalized quotations on fetched public pages. This integration
does not configure Mastra cloud telemetry. Confidence scores and rank ranges are decision-support
heuristics and sensitivity analysis, not statistical probabilities. Agent integration tests and the
desktop smoke scenario use only synthetic data and the explicit offline provider.

## Daily commands

```bash
npm run dev       # open the app with hot reload
npm run smoke     # build, screenshot every screen to apps/desktop/out/smoke/, check the IPC bridge
npm run check     # typecheck + tests + format check
npm run package   # installer for your OS → apps/desktop/release/
```
