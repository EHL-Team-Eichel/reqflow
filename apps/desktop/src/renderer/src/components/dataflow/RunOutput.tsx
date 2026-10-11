import { useEffect, useState } from "react";
import { useStore } from "zustand";
import {
  blockPorts,
  countPipelineData,
  type DataKey,
  type PipelineData,
  type WorkflowBlock,
} from "@reqflow/core";
import { api } from "@/lib/api";
import { Button } from "../ui/Button";
import { runStore } from "./run-session";
import {
  BLOCK_STATUS_LABELS,
  blockDraftChanged,
  loadSelectedOutput,
  snapshotBlock,
} from "./run-view";
import { reportRevision } from "./report/splitter-view";
import { boundedRawPreview } from "./run-controls";

type OutputState =
  | { key: string; status: "loading" }
  | { key: string; status: "error"; message: string }
  | { key: string; status: "ready"; outputs: Record<string, PipelineData> };

export function RunOutput({ block }: { block: WorkflowBlock }) {
  const run = useStore(runStore, (state) => state.run);
  const [state, setState] = useState<OutputState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [port, setPort] = useState("");
  const saved = snapshotBlock(run, block.id);
  const status = run?.blockRuns.find((entry) => entry.blockId === block.id);
  const key = `${run?.id ?? ""}:${block.id}:${status?.status ?? ""}:${reportRevision(run)}:${attempt}`;
  const ports = saved ? blockPorts(saved).outputs : [];
  useEffect(() => {
    if (
      !run ||
      !saved ||
      !ports.length ||
      status?.status === "pending" ||
      status?.status === "running"
    )
      return;
    setState({ key, status: "loading" });
    return loadSelectedOutput(run, block.id, api.runs.blockOutput, (result) =>
      setState({ ...result, key }),
    );
  }, [key]);
  if (!run || !saved)
    return (
      <section
        data-testid="run-output-inspector"
        className="border-t border-line pt-3 text-xs text-muted"
      >
        No saved run output exists for this draft block. Only Start executes it.
      </section>
    );
  const selectedPort = ports.some((entry) => entry.id === port) ? port : (ports[0]?.id ?? "");
  const current = state?.key === key ? state : null;
  const data = current?.status === "ready" ? current.outputs[selectedPort] : undefined;

  return (
    <section data-testid="run-output-inspector" className="space-y-3 border-t border-line pt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Saved run output</h3>
      <p className="text-xs text-ink">
        {status ? BLOCK_STATUS_LABELS[status.status] : "Not executed"} / {run.scope.market} /{" "}
        {new Date(run.startedAt).toLocaleString()}
      </p>
      <p className="break-all font-mono text-[10px] text-muted">{run.id}</p>
      <p className="text-xs text-muted">
        Read-only frozen snapshot.{" "}
        {blockDraftChanged(block, saved)
          ? "This draft has changed; the output below still belongs to the saved block and its original ports."
          : "Edits apply only to a later run."}
      </p>
      {status?.error && (
        <p role="alert" className="text-xs text-danger">
          {status.error}
        </p>
      )}
      {!!status?.logs.length && (
        <details>
          <summary className="cursor-pointer text-xs text-brand">
            Block logs ({status.logs.length})
          </summary>
          <ul className="mt-2 max-h-40 space-y-1 overflow-auto text-xs text-muted">
            {status.logs.map((log, index) => (
              <li key={index}>
                {new Date(log.at).toLocaleTimeString()}: {log.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!ports.length ? (
        <p className="text-xs text-muted">This block is a sink and has no output ports.</p>
      ) : (
        <>
          <label className="block text-xs text-muted">
            Saved output port
            <select
              data-testid="run-output-port"
              value={selectedPort}
              onChange={(event) => setPort(event.target.value)}
              className="mt-1 h-8 w-full rounded border border-line bg-panel-2 px-2 text-ink"
            >
              {ports.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          {status?.status === "pending" || status?.status === "running" ? (
            <p className="text-xs text-muted">Output has not been recorded yet.</p>
          ) : !current || current.status === "loading" ? (
            <p role="status" className="text-xs text-muted">
              Reading saved output...
            </p>
          ) : current.status === "error" ? (
            <div>
              <p role="alert" className="text-xs text-danger">
                {current.message}
              </p>
              <Button
                size="sm"
                data-testid="run-output-retry"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry output
              </Button>
            </div>
          ) : !data ? (
            <p className="text-xs text-muted">
              No output was emitted on this port. A paused HIL has not passed its inputs on.
            </p>
          ) : (
            <OutputData data={data} />
          )}
        </>
      )}
    </section>
  );
}

function OutputData({ data }: { data: PipelineData }) {
  const [chosen, setChosen] = useState<DataKey>("records");
  const counts = countPipelineData(data);
  const layers = ["requirements", "themes", "findings", "records", "sources"] as const;
  const layer = data[chosen].length
    ? chosen
    : (layers.find((key) => data[key].length) ?? "records");
  const items =
    layer === "requirements"
      ? data.requirements.slice(0, 20).map((item) => ({
          id: item.id,
          text: item.description,
          locator: item.title,
          fields: item,
        }))
      : layer === "themes"
        ? data.themes.slice(0, 20).map((item) => ({ id: item.id, text: item.label, fields: item }))
        : layer === "findings"
          ? data.findings
              .slice(0, 20)
              .map((item) => ({ id: item.id, text: item.statement, fields: item }))
          : layer === "records"
            ? data.records.slice(0, 20).map((item) => ({
                id: item.id,
                text: item.text,
                locator: item.locator,
                fields: item,
              }))
            : data.sources
                .slice(0, 20)
                .map((item) => ({ id: item.id, text: item.title, fields: item }));
  return (
    <div className="space-y-2 text-xs">
      <p data-testid="run-output-counts" className="text-muted">
        {Object.entries(counts)
          .map(([name, count]) => `${count} ${name}`)
          .join(" / ")}
      </p>
      <label className="block text-muted">
        Data layer
        <select
          value={layer}
          onChange={(event) => setChosen(event.target.value as DataKey)}
          className="mt-1 h-8 w-full rounded border border-line bg-panel-2 px-2 text-ink"
        >
          {layers.map((key) => (
            <option key={key} value={key} disabled={!data[key].length}>
              {key} ({data[key].length})
            </option>
          ))}
        </select>
      </label>
      <p className="text-muted">
        Showing {items.length} of {data[layer].length} items. Supporting evidence remains in the
        saved output and review reports.
      </p>
      {!items.length && <p className="text-muted">This port contains an empty data stream.</p>}
      <div className="max-h-72 space-y-2 overflow-auto">
        {items.map((item) => (
          <details key={item.id} className="rounded border border-line bg-panel-2 p-2">
            <summary className="cursor-pointer break-words text-ink">
              {item.text.slice(0, 220)}
              {item.text.length > 220 ? "..." : ""}
            </summary>
            <p className="mt-2 whitespace-pre-wrap break-words">
              {item.text.slice(0, 4000)}
              {item.text.length > 4000 &&
                "\nText preview limited to 4,000 characters. The full original remains in the saved run."}
            </p>
            {"locator" in item && item.locator && <p className="mt-1 text-muted">{item.locator}</p>}
            <p className="mt-1 break-all font-mono text-[10px] text-muted">{item.id}</p>
            {item.fields && (
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px]">
                {boundedRawPreview(item.fields)}
              </pre>
            )}
          </details>
        ))}
      </div>
    </div>
  );
}
