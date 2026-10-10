// @reqflow/engine — workflow runtime. Owner: WS1 (see docs/WORKSTREAMS.md).
// Contract (stable): BlockImplementation / BlockContext / BlockResult / BlockRegistry.
// To build here: the executor (validateGraph, topological run per workplace, inner workplaces,
// merge per input port, pause/resume at HIL, cancel). Semantics: docs/ARCHITECTURE.md.
export * from "./block";
export * from "./registry";
export * from "./executor";
