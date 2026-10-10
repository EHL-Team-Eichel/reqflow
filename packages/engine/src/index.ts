// @reqflow/engine — workflow runtime. Owner: WS1 (see docs/WORKSTREAMS.md).
// Contract (stable): BlockDefinition / BlockContext / BlockResult / BlockRegistry.
export * from "./block";
export * from "./registry";
// Lifecycle wrapper and standalone executeWorkflow share one validated execution kernel.
export * from "./executor";
