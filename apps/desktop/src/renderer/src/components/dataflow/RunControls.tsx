import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  ResearchDataset,
  WorkflowRun,
  walkBlocks,
  type PipelineData,
  type Workflow,
} from "@reqflow/core";
import { api } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { Button } from "@/components/ui/Button";
import { dataflowStore, useDataflow } from "./store";
import {
  boundedRawPreview,
  cancelWorkflow,
  collectionSummary,
  exportResearchDataset,
  isRunBusy,
  reconcileRun,
  startEditorWorkflow,
} from "./run-controls";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const label = (value: string) => value.replace(/_/g, " ");
const finished = (run: WorkflowRun | null) =>
  !!run && ["completed", "failed", "cancelled"].includes(run.status);
// Keep run identity across tab navigation, just like the editor's existing session-only graph.
let sessionWorkflow: Workflow | null = null;
let sessionRun: WorkflowRun | null = null;

export function RunControls() {
  const root = useDataflow((state) => state.root);
  const scope = useSettings((state) => state.settings.defaultScope);
  const [workflow, setWorkflow] = useState<Workflow | null>(sessionWorkflow);
  const [run, setRun] = useState<WorkflowRun | null>(sessionRun);
  const [action, setAction] = useState<"start" | "cancel" | "export" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dataset, setDataset] = useState<ResearchDataset | null>(null);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [datasetLoading, setDatasetLoading] = useState(false);
  const [output, setOutput] = useState<{
    blockId: string;
    ports: Record<string, PipelineData>;
  } | null>(null);
  const [outputLoading, setOutputLoading] = useState<string | null>(null);
  const outputPreview = useMemo(() => (output ? boundedRawPreview(output.ports) : ""), [output]);
  const current = useRef<WorkflowRun | null>(sessionRun);
  const receivedUpdates = useRef(0);
  const starting = useRef(false);
  const startingWorkflow = useRef<string | null>(null);
  const previousRunId = useRef<string | null>(null);
  const mounted = useRef(true);
  const operation = useRef(false);
  const blocks = useMemo(
    () => new Map(run ? [...walkBlocks(run.graph)].map(({ block }) => [block.id, block]) : []),
    [run?.graph],
  );
  const hasResearch = useMemo(
    () => [...blocks.values()].some((block) => block.kind === "research"),
    [blocks],
  );

  const accept = (next: WorkflowRun, response = false) => {
    const value = response ? reconcileRun(current.current, next) : next;
    current.current = value;
    sessionRun = value;
    if (mounted.current) setRun(value);
  };

  useEffect(() => {
    setOutput(null);
  }, [run?.id]);

  useEffect(() => {
    mounted.current = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = api.runs.onUpdate((value) => {
        try {
          const next = WorkflowRun.parse(value);
          const matchesStart =
            starting.current &&
            next.workflowId === startingWorkflow.current &&
            next.id !== previousRunId.current;
          if (next.id === current.current?.id || matchesStart) {
            receivedUpdates.current++;
            accept(next);
          }
        } catch (cause) {
          if (mounted.current) setError(`Invalid run update: ${errorMessage(cause)}`);
        }
      });
    } catch (cause) {
      setError(`Run updates unavailable: ${errorMessage(cause)}`);
    }
    const cached = current.current;
    const generation = receivedUpdates.current;
    let stale = false;
    if (cached)
      api.runs
        .get(cached.id)
        .then((value) => {
          if (!stale && generation === receivedUpdates.current) accept(WorkflowRun.parse(value));
        })
        .catch((cause) => {
          if (!stale) setError(`Could not refresh run: ${errorMessage(cause)}`);
        });
    return () => {
      stale = true;
      mounted.current = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    setDataset(null);
    setDatasetError(null);
    setDatasetLoading(false);
    if (!run || !finished(run) || !hasResearch) return;
    let stale = false;
    setDatasetLoading(true);
    api.research
      .dataset(run.id)
      .then((value) => {
        const parsed = ResearchDataset.parse(value);
        if (parsed.runId !== run.id) throw new Error("Research dataset belongs to another run");
        if (!stale) setDataset(parsed);
      })
      .catch((cause) => {
        if (!stale) setDatasetError(`Research dataset unavailable: ${errorMessage(cause)}`);
      })
      .finally(() => {
        if (!stale) setDatasetLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [run?.id, run?.status, hasResearch]);

  const start = async () => {
    if (operation.current || isRunBusy(current.current)) return;
    operation.current = true;
    starting.current = true;
    startingWorkflow.current = null;
    previousRunId.current = current.current?.id ?? null;
    setAction("start");
    setError(null);
    setNotice(null);
    setOutput(null);
    try {
      const next = await startEditorWorkflow(
        api,
        dataflowStore.getState().root,
        scope,
        workflow?.id,
        (saved) => {
          startingWorkflow.current = saved.id;
          sessionWorkflow = saved;
          if (mounted.current) setWorkflow(saved);
        },
      );
      accept(next, true);
    } catch (cause) {
      if (mounted.current) setError(`Could not start workflow: ${errorMessage(cause)}`);
    } finally {
      operation.current = false;
      starting.current = false;
      if (mounted.current) setAction(null);
    }
  };

  const cancel = async () => {
    const active = current.current;
    if (!active || !isRunBusy(active) || operation.current) return;
    operation.current = true;
    setAction("cancel");
    setError(null);
    setNotice(null);
    try {
      accept(await cancelWorkflow(api, active), true);
    } catch (cause) {
      if (mounted.current) setError(`Could not cancel run: ${errorMessage(cause)}`);
    } finally {
      operation.current = false;
      if (mounted.current) setAction(null);
    }
  };

  const exportResearch = async (format: "json" | "xlsx" | "csv") => {
    const active = current.current;
    if (
      !active ||
      !finished(active) ||
      !dataset ||
      dataset.runId !== active.id ||
      operation.current
    )
      return;
    operation.current = true;
    setAction("export");
    setError(null);
    setNotice(null);
    try {
      const result = await exportResearchDataset(api, dataset, format);
      if (mounted.current) setNotice(result ? `Export saved: ${result.path}` : "Export cancelled.");
    } catch (cause) {
      if (mounted.current) setError(`Could not export research: ${errorMessage(cause)}`);
    } finally {
      operation.current = false;
      if (mounted.current) setAction(null);
    }
  };

  const inspect = async (blockId: string) => {
    const active = current.current;
    if (!active || outputLoading) return;
    setOutputLoading(blockId);
    setError(null);
    try {
      const ports = await api.runs.blockOutput(active.id, blockId);
      if (mounted.current && current.current?.id === active.id) setOutput({ blockId, ports });
    } catch (cause) {
      if (mounted.current) setError(`Output unavailable: ${errorMessage(cause)}`);
    } finally {
      if (mounted.current) setOutputLoading(null);
    }
  };

  return (
    <section
      aria-label="Workflow run controls"
      className="max-h-72 shrink-0 overflow-auto rounded-xl border border-line bg-panel px-4 py-3"
      data-testid="run-controls"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={!!action || isRunBusy(run) || !root.blocks.length}
          onClick={start}
          data-testid="run-start"
        >
          {action === "start" ? "Saving & starting…" : "Run workflow"}
        </Button>
        <Button
          variant="danger"
          disabled={!!action || !isRunBusy(run)}
          onClick={cancel}
          data-testid="run-cancel"
        >
          {action === "cancel" ? "Cancelling…" : "Cancel run"}
        </Button>
        <span role="status" aria-live="polite" className="text-sm text-ink">
          {run ? `Run ${label(run.status)}` : "Ready — saves the whole workflow before running"}
        </span>
        {workflow && <span className="text-xs text-muted">Saved v{workflow.version}</span>}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-sm text-muted">
          {notice}
        </p>
      )}
      {run?.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {run.error}
        </p>
      )}
      {run?.status === "waiting_for_review" && (
        <p className="mt-2 text-sm text-ink">
          Waiting for human review.{" "}
          <Link to="/car" className="text-brand underline">
            Open Car review
          </Link>
          . No decisions are made automatically.
        </p>
      )}
      {run && (
        <details className="mt-2 text-sm" key={run.id}>
          <summary className="cursor-pointer text-ink">
            Last run: {run.blockRuns.filter((block) => block.status === "succeeded").length} blocks
            succeeded · {run.id}
          </summary>
          <ul className="mt-2 space-y-2">
            {run.blockRuns
              .filter((state) => {
                const kind = blocks.get(state.blockId)?.kind;
                return kind !== "block_input" && kind !== "block_output";
              })
              .map((state) => (
                <li key={state.blockId} className="rounded-lg border border-line p-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{blocks.get(state.blockId)?.label ?? state.blockId}</strong>
                    <span>{label(state.status)}</span>
                    <span className="text-xs text-muted">
                      {Object.entries(state.counts)
                        .map(([key, count]) => `${count} ${key}`)
                        .join(" · ")}
                    </span>
                    {state.status === "succeeded" && (
                      <Button
                        size="sm"
                        disabled={!!outputLoading}
                        onClick={() => inspect(state.blockId)}
                      >
                        {outputLoading === state.blockId ? "Loading…" : "Inspect output"}
                      </Button>
                    )}
                  </div>
                  {state.status === "running" && (
                    <progress
                      aria-label={`${blocks.get(state.blockId)?.label ?? state.blockId} progress`}
                      value={state.progress ?? 0}
                      max={1}
                      className="mt-1 w-full"
                    />
                  )}
                  {state.error && <p className="text-danger">{state.error}</p>}
                  {state.logs.slice(-2).map((entry, index) => (
                    <p key={`${entry.at}-${index}`} className="text-xs text-muted">
                      {entry.message}
                    </p>
                  ))}
                </li>
              ))}
          </ul>
          {output && (
            <div className="mt-2">
              <p>Output: {blocks.get(output.blockId)?.label ?? output.blockId}</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-panel-2 p-2 text-xs">
                {outputPreview}
              </pre>
              <p className="text-xs text-muted">
                Preview limited to 20,000 characters. Research exports contain the full dataset.
              </p>
            </div>
          )}
        </details>
      )}
      {datasetLoading && (
        <p role="status" className="mt-2 text-sm text-muted">
          Loading research summary…
        </p>
      )}
      {datasetError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {datasetError}
        </p>
      )}
      {dataset && (
        <div className="mt-3 text-sm">
          <p className="font-medium">
            Research: {dataset.sources.length} sources · {dataset.records.length} raw records
            {dataset.synthetic ? " · Synthetic fixture data" : ""}
          </p>
          {!dataset.results.length && (
            <p className="text-muted">No agent collection results were recorded.</p>
          )}
          <ul className="mt-1 space-y-1">
            {dataset.results.map((result, index) => (
              <li key={`${result.agentId}-${index}`}>
                <span className="font-medium">{label(result.agentId)}: </span>
                {collectionSummary(result)} · {result.recordIds.length} records · {result.requests}{" "}
                requests
                {result.limitations.length > 0 && (
                  <ul className="ml-4 list-disc text-xs text-muted">
                    {result.limitations.map((limitation, i) => (
                      <li key={i}>{limitation}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2" aria-label="Research exports">
            {(["json", "xlsx", "csv"] as const).map((format) => (
              <Button
                key={format}
                size="sm"
                disabled={!!action}
                onClick={() => exportResearch(format)}
              >
                Export {format.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
