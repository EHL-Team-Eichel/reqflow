# 0003 — The flow is built from user-facing building blocks

**Status:** accepted (2026-10-10) · **Replaces:** the fine-grained node types from the first scaffold

## Context

The first scaffold modelled the pipeline as eleven technical node types (`analysis.extract_signals`,
`requirements.derive`, …), each with exactly one input and one output. The team then specified
the app from the user's point of view (sketch in `context/Building_Blocks.jpeg`): a palette of a few
**building blocks** (Custom, Raw, Research, AI Filter, AI Splitter, HIL, Add to Car) that a PM
drags onto a **workplace**, where some blocks have several outputs or inputs and some can be expanded
into their own **inner workplace**.

## Decision

- The block kinds, their params and their ports are pure data in `packages/core/src/blocks.ts`.
  The editor renders the palette and the parameter forms from it, and the engine validates against it.
- Edges connect **ports** (`sourcePort` → `targetPort`). Ports may depend on params (one splitter
  output per branch, one Add to Car input per ranking).
- A workflow is a **tree**: Custom, Research and AI Filter carry an inner `WorkflowGraph` with fixed
  boundary blocks (`block_input` / `block_output`) for the parent's ports.
- Graph rules (connect, remove, params, cycle check, validation) are pure functions in
  `packages/core/src/graph.ts`, shared by the editor and the engine.
- The package `@reqflow/nodes` became `@reqflow/blocks`, with one folder per block. The IPC method
  `nodes.catalog()` was removed (the renderer reads `BLOCK_SPECS` directly), and `runs.nodeOutput`
  became `runs.blockOutput` (output per port).
- The app has three tabs: **Data Flow**, **Car** (the output: requirements for the car) and
  **Settings**. The former Requirements and Audit pages move into the Car tab (WS3).

## Consequences

- The analysis steps that used to be separate nodes (signal extraction, clustering, derivation,
  scoring) now happen inside blocks: AI Filter, AI Splitter (priority mode uses WS8's scoring) and
  Add to Car. Users can still compose finer steps inside inner workplaces.
- Block params are placeholders until the owning workstream builds the block; changing a param spec is
  a contract change (WS0).
