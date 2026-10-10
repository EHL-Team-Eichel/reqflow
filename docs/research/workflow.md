# Generic workflow execution and research run controls

## Scope and acceptance

This slice adds one generic executor to `@reqflow/engine` and exposes the existing run IPC contract
on the Data Flow page. It does not implement AI blocks, register blocks, construct research providers,
change shared schemas, persist data, or make human decisions. Those responsibilities remain in main
and the owning block implementations.

Acceptance is an offline run of a validated workflow graph with correct port routing, independent
branch preservation, boundary routing, cancellation, and resumable nested HIL pauses. The renderer
saves the root graph before starting, displays live run states and research collection limitations,
and delegates exports to the native main-process save dialog.

## Engine API

```ts
type WorkflowOutputs = Record<string, Record<string, PipelineData>>;

function executeWorkflow(options: {
  run: WorkflowRun;
  registry: BlockRegistry;
  context: (blockId: string) => BlockContext;
  outputs?: WorkflowOutputs;
  onUpdate: (run: WorkflowRun) => void | Promise<void>;
}): Promise<{ run: WorkflowRun; outputs: WorkflowOutputs }>;
```

The function and named option/result/output types are exported from `@reqflow/engine`.

- `validateGraph` runs before contexts or updates. Invalid graphs reject immediately.
- Each workplace runs in stable topological order. Multiple incoming edges merge in graph edge order
  with `mergePipelineData`; later duplicate IDs win. Unconnected inputs receive empty envelopes.
- Inputs are cloned so an implementation cannot corrupt an earlier successful output by mutating its input.
- A Custom block always runs its inner workplace. Research and AI Filter use their registered builtin
  when their inner workplace has only untouched boundary blocks. An inner edge or non-boundary block
  overrides the builtin, including a direct input-to-output boundary connection.
- `block_input.out` carries its parent's named input. `block_output.in` becomes the parent's named
  output. Boundaries are engine-owned and do not require registry entries.
- A missing builtin fails that block with a clear registry error. Failed descendants are skipped;
  independent branches continue and keep their outputs. There are no placeholder AI implementations.
- Implementations must return exactly the output ports declared by `blockPorts`. Every envelope is
  schema-validated before publication. Validation preserves research provenance extensions instead
  of stripping extended record fields. Sink outputs are `{}`.
- Counts are computed from the deduplicated union of a block's output envelopes. Sinks have zero
  output counts. Builtin placeholder boundaries are explicitly skipped, not left pending.
- Only HIL implementations may return `paused`. Ancestors reflect `waiting_for_review`, dependent
  nodes remain pending, and independent branches may finish. If failure and review coexist, the run
  waits for review while retaining the failure; the final resumed run fails unless no branch failed.
- Terminal runs cannot be re-executed. Successful and failed blocks are not replayed when continuing.
  Only previously paused HIL receives `ctx.resumed = true`; newly reached HIL still pauses normally.
- Cancellation stops awaiting even an implementation that ignores its signal. Successful data stays
  available; unfinished states become skipped, and the run becomes cancelled. Late engine logs,
  progress, and results are ignored. Blocks must still obey their signal before external side effects:
  the executor cannot undo a provider request or database write performed by an uncooperative block.
- Log/progress callbacks preserve the supplied context callbacks and emit immutable run snapshots.
  Subscriber calls are serialized and awaited. Persistence/subscriber errors reject instead of being
  silently reported as successful execution.

## Main-process integration requirements

There must be **no second orchestrator** in the IPC handlers. Main starts this executor in the
background and retains/observes its promise; `runs.start` returns the initial snapshot promptly.

1. Register every builtin actually used by the selected workflow in `BlockRegistry`. A customized
   expandable subflow does not require that parent's builtin, but its inner leaf implementations do.
2. Build `WorkflowRun` from the saved workflow version and graph/scope snapshot. Supply contexts
   with one shared run `AbortSignal`, settings snapshot, audit/files/LLM/car services, and `ctx.research`
   for the registered Research implementation. The executor does not construct a collector or resolve
   advanced research scope; the registered block and shared parameter contract own that behavior.
3. Pass an explicit mutable `outputs` map. The executor writes a validated output before emitting its
   succeeded snapshot. `onUpdate` can persist the snapshot and newly succeeded outputs atomically,
   then push `IPC_EVENTS.runUpdate`. Persist all output maps, including `{}` for sinks and boundaries.
   Do not parse extended research records into a stripped-down persistence representation.
4. Record run lifecycle audit events in main, based on actual status transitions. Blocks remain
   responsible for their domain audit events. The executor does not approve/reject/defer requirements.
5. Retain one `AbortController` and active execution promise per run. `runs.cancel` aborts it and
   waits for the executor's final cancelled snapshot. To cancel a persisted paused run after its
   execution promise has settled, main must also persist a cancelled status or re-enter the executor
   with that paused snapshot and an already-aborted signal.
6. `runs.resume` accepts a waiting run only, reloads the same graph and every successful block's
   persisted per-port outputs, applies already-audited human edits through main's existing review
   services, supplies a fresh non-aborted context signal, and calls this same executor. Missing stored
   successful outputs reject clearly; they are never silently rebuilt or replaced with empty data.
7. Persist collector `ResearchDataset` results under the run ID before final run completion reaches
   the renderer. `research.dataset` should return successful and partial collections, including
   blocked/missing-credential outcomes with zero records. Keep these distinct from an absent dataset.
8. Implement `exports.research({ runId, format })` for JSON, XLSX, and CSV with a native save dialog.
   Return `null` for dialog cancellation; surface real errors through the existing IPC error contract.

Because `onUpdate` receives only the run snapshot, main must use its explicit shared output map when
persisting per-port data during execution. Awaiting only the final result would lose outputs on an
application shutdown during human review.

## Renderer behavior

Run controls save `dataflowStore.getState().root`, never the open inner workplace, as
`Research workflow` with Settings' `defaultScope`. Further runs reuse the saved workflow ID and let
main bump its version. Advanced scope remains a generic Research inspector parameter.

The controls subscribe before starting so fast pushed completion cannot be overwritten by a stale
`runs.start` response. Save/start/cancel/export have explicit busy flags and visible error states.
The latest workflow/run identity survives tab navigation for the current app session; remounting
refreshes that run through `runs.get`. The editor is still session-only on application restart.
This slice does not add a second workflow browser or autosave system.

An expandable last-run panel shows each non-boundary block's status, progress, output counts, errors,
and recent logs. Output inspection calls `runs.blockOutput` and limits the JSON preview to 20,000
characters. Completed, failed, and cancelled Research runs load `research.dataset` and display every
agent's status, record count, request count, and limitations. An unavailable dataset is an error,
not an empty result. Synthetic datasets are marked explicitly. JSON/XLSX/CSV exports include the full
dataset and remain main-process operations. Waiting runs link to Car review; controls never decide
requirements or automatically resume human review.

## Offline verification

```sh
npx vitest run packages/engine/src/executor.test.ts \
  apps/desktop/src/renderer/src/components/dataflow/RunControls.test.ts
```

Executor tests cover DAG ordering, merge/fan-out, splitter ports, invalid graphs/outputs, missing
implementations, independent failures, Research collector invocation, nested boundaries, builtin
fallback/override, nested and sequential HIL resume, missing resume data, cancellation, late result
suppression, progress/log snapshots, persistence errors, provenance preservation, and input isolation.
Run-control helper tests exercise save-before-start, root/scope/version reuse, invalid/offline errors,
stale-response handling, cancel behavior, distinct agent statuses, and native export IPC contracts.

Full main-process end-to-end research execution depends on the integration requirements above; the
helper tests deliberately use synthetic fixtures and never call a real research provider.
