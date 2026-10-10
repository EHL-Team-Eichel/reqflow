# 0001 — Tech stack and repo shape

**Status:** accepted (2026-10-10)

**Context:** Several agents build in parallel during a hackathon. The product is a UI-heavy workflow tool
with an AI pipeline behind it.

**Decision:** TypeScript-only npm-workspaces monorepo: Next.js 16 + React Flow for the app, Zod 4 schemas in
`packages/core` as the single contract, nodes as plain modules behind a registry, SQLite via `node:sqlite`,
the Claude API behind an `LlmClient` interface with an offline `mock` provider, and Vitest for tests.

**Consequences:** one language and one set of types end to end, and no codegen between frontend and backend.
Data-science tooling (pandas and the like) is not available. If heavy tabular analysis is needed, add a small
Python script under `scripts/` that reads from `data/raw/` and writes JSON. It must not become a second backend.

New decisions: copy this file as `NNNN-<slug>.md`, keep it short (context, decision, consequences).
