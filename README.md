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

## Daily commands

```bash
npm run dev       # open the app with hot reload
npm run smoke     # build, screenshot every screen to apps/desktop/out/smoke/, check the IPC bridge
npm run check     # typecheck + tests + format check
npm run package   # installer for your OS → apps/desktop/release/
```
