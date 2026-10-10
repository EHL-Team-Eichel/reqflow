import { useEffect, useMemo, useRef, useState } from "react";
import { walkBlocks, type ResearchDataset, type WorkflowRun } from "@reqflow/core";
import { api } from "../../lib/api";
import { Button } from "../ui/Button";
import { boundedRawPreview, collectionSummary, exportResearchDataset } from "./run-controls";
import { runStore } from "./run-session";
import {
  canLoadResearchDataset,
  loadResearchDataset,
  loadRunOutput,
  type ResearchExportFormat,
  type RunOutput,
} from "./research-results";

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const label = (value: string) => value.replaceAll("_", " ");

export function RawOutputPreview({ ports }: { ports: RunOutput }) {
  const preview = useMemo(() => boundedRawPreview(ports), [ports]);
  return (
    <div className="mt-2">
      <pre
        data-testid="research-output-preview"
        className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-panel-2 p-2 text-xs text-ink"
      >
        {preview}
      </pre>
      <p className="mt-1 text-xs text-muted">
        Preview limited to 20,000 characters. Research exports contain the full dataset.
      </p>
    </div>
  );
}

/** Run prop always comes from run-session; local state contains only the inspected output. */
export function ResearchRunDetails({ run }: { run: WorkflowRun }) {
  const blocks = useMemo(
    () => new Map([...walkBlocks(run.graph)].map(({ block }) => [block.id, block])),
    [run.graph],
  );
  const [output, setOutput] = useState<{ blockId: string; ports: RunOutput } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const inspecting = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const inspect = async (blockId: string) => {
    if (inspecting.current || runStore.getState().run?.id !== run.id) return;
    inspecting.current = true;
    setLoading(blockId);
    setError(null);
    setOutput(null);
    const current = () => mounted.current && runStore.getState().run?.id === run.id;
    try {
      const ports = await loadRunOutput(api, run.id, blockId);
      if (current()) setOutput({ blockId, ports });
    } catch (cause) {
      if (current()) setError(`Output unavailable: ${errorMessage(cause)}`);
    } finally {
      inspecting.current = false;
      if (current()) setLoading(null);
    }
  };

  return (
    <details className="mt-2 w-full text-xs text-muted" data-testid="flow-run-details">
      <summary className="cursor-pointer">
        Block status & logs · Last run:{" "}
        {run.blockRuns.filter((state) => state.status === "succeeded").length} blocks succeeded ·{" "}
        {run.id}
      </summary>
      <div className="mt-2 max-h-56 overflow-auto">
        {run.blockRuns.map((state) => (
          <div key={state.blockId} className="border-t border-line py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">
                {blocks.get(state.blockId)?.label ?? state.blockId}: {label(state.status)}
              </span>
              <span>
                {Object.entries(state.counts)
                  .map(([key, count]) => `${count} ${key}`)
                  .join(" · ")}
              </span>
              {state.status === "succeeded" && (
                <Button
                  size="sm"
                  data-testid={`research-inspect-${state.blockId}`}
                  disabled={!!loading}
                  onClick={() => void inspect(state.blockId)}
                >
                  {loading === state.blockId ? "Loading…" : "Inspect output"}
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
            {state.error && (
              <p role="alert" className="text-danger">
                {state.error}
              </p>
            )}
            {state.logs.map((log, index) => (
              <p key={index}>{log.message}</p>
            ))}
          </div>
        ))}
        {error && (
          <p role="alert" className="mt-2 text-danger">
            {error}
          </p>
        )}
        {output && (
          <div className="mt-2">
            <p className="text-ink">
              Output: {blocks.get(output.blockId)?.label ?? output.blockId}
            </p>
            <RawOutputPreview ports={output.ports} />
          </div>
        )}
      </div>
    </details>
  );
}

export function ResearchDatasetSummary({
  dataset,
  exporting,
  onExport,
}: {
  dataset: ResearchDataset;
  exporting: boolean;
  onExport: (format: ResearchExportFormat) => void;
}) {
  return (
    <div className="mt-3 w-full text-sm" data-testid="research-results">
      <p className="font-medium text-ink">
        Research: {dataset.sources.length} sources · {dataset.records.length} raw records
        {dataset.synthetic ? " · Synthetic fixture data" : ""}
      </p>
      {!dataset.results.length && (
        <p className="text-muted">No agent collection results were recorded.</p>
      )}
      <ul className="mt-1 space-y-1">
        {dataset.results.map((result, index) => (
          <li key={`${result.agentId}-${index}`} data-testid={`research-agent-${result.agentId}`}>
            <span className="font-medium text-ink">{label(result.agentId)}: </span>
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
            data-testid={`research-export-${format}`}
            disabled={exporting}
            onClick={() => onExport(format)}
          >
            Export {format.toUpperCase()}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Owns only result loading and native export UI; it never starts, resumes or reconciles runs. */
export function ResearchResults({ run, busy }: { run: WorkflowRun; busy: boolean }) {
  const ready = canLoadResearchDataset(run);
  const [dataset, setDataset] = useState<ResearchDataset | null>(null);
  const [loading, setLoading] = useState(ready);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const exportPending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setDataset(null);
    setError(null);
    setLoading(ready);
    if (!ready) return;
    let stale = false;
    void loadResearchDataset(api, run.id)
      .then((value) => {
        if (!stale && runStore.getState().run?.id === run.id) setDataset(value);
      })
      .catch((cause) => {
        if (!stale && runStore.getState().run?.id === run.id)
          setError(`Research dataset unavailable: ${errorMessage(cause)}`);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [run.id, ready, retry]);

  const exportResearch = async (format: ResearchExportFormat) => {
    const shared = runStore.getState();
    if (
      !dataset ||
      dataset.runId !== shared.run?.id ||
      shared.busy ||
      !canLoadResearchDataset(shared.run) ||
      exportPending.current
    )
      return;
    exportPending.current = true;
    setExporting(true);
    setExportError(null);
    setNotice(null);
    const current = () => mounted.current && runStore.getState().run?.id === dataset.runId;
    try {
      const result = await exportResearchDataset(api, dataset, format);
      if (current()) setNotice(result ? `Export saved: ${result.path}` : "Export cancelled.");
    } catch (cause) {
      if (current()) setExportError(`Could not export research: ${errorMessage(cause)}`);
    } finally {
      exportPending.current = false;
      if (current()) setExporting(false);
    }
  };

  if (!ready) return null;
  return (
    <div className="w-full" aria-label="Research collection results">
      {loading && (
        <p role="status" className="mt-2 text-sm text-muted">
          Loading research summary…
        </p>
      )}
      {error && (
        <div className="mt-2">
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <Button
            size="sm"
            data-testid="research-results-retry"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry research summary
          </Button>
        </div>
      )}
      {dataset && dataset.runId === run.id && (
        <ResearchDatasetSummary
          dataset={dataset}
          exporting={exporting || busy}
          onExport={(format) => void exportResearch(format)}
        />
      )}
      {exportError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {exportError}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-sm text-muted">
          {notice}
        </p>
      )}
    </div>
  );
}
