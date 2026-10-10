# ReqFlow

From customer evidence to prioritized, PM-approved vehicle requirements. This is a hackathon prototype
for the BMW challenge _AI for Product Decision Making_.

| Read                                         | For                                                    |
| -------------------------------------------- | ------------------------------------------------------ |
| [PRODUCT.md](PRODUCT.md)                     | What we build and why (the product definition)         |
| [AGENTS.md](AGENTS.md)                       | Challenge digest and rules for every coding agent      |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, layout, data flow, engine semantics, API        |
| [docs/WORKSTREAMS.md](docs/WORKSTREAMS.md)   | Parallel work packages, path ownership, kickoff prompt |
| [context/](context/)                         | Original briefing material                             |

## Quickstart

```bash
brew install --cask entireio/tap/entire   # once per machine: Entire records agent sessions
entire enable --agent claude-code         # once per clone: installs Entire's git hooks
npm install
cp .env.example apps/web/.env.local   # optional: add ANTHROPIC_API_KEY; default provider is "mock"
npm run dev                           # http://localhost:3000
npm run check                         # typecheck + tests + format check
```

Requires Node ≥ 22.13 (see `.nvmrc`).
