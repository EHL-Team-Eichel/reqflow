import { useEffect, useState } from "react";
import type { LineageStep, PipelineData, Requirement } from "@reqflow/core";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/controls";
import {
  SourcesTable,
  RecordsTable,
  FindingsTable,
  ThemesTable,
  RequirementsTable,
} from "../dataflow/report/DataTables";
import { SplitterPanel } from "../dataflow/report/SplitterPanel";
import { reportForStep } from "../dataflow/report/splitter-view";
import { loadOriginStepData, type RequirementOrigin } from "./requirement-origin";

const LAYERS = [
  { key: "requirements", label: "Requirements", Table: RequirementsTable },
  { key: "themes", label: "Themes", Table: ThemesTable },
  { key: "findings", label: "Findings", Table: FindingsTable },
  { key: "records", label: "Records", Table: RecordsTable },
  { key: "sources", label: "Sources", Table: SourcesTable },
] as const;
type Layer = (typeof LAYERS)[number]["key"];
type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: PipelineData };

export function OriginStepData({
  origin,
  requirement,
  step,
}: {
  origin: RequirementOrigin;
  requirement: Requirement;
  step: LineageStep;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [layer, setLayer] = useState<Layer>("records");
  const [filter, setFilter] = useState("");
  const [scores, setScores] = useState(step.block.kind === "ai_splitter");
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void loadOriginStepData(origin, requirement, step, api.runs.blockOutput).then(
      (data) => {
        if (!cancelled) {
          setState({ status: "ready", data });
          setLayer(LAYERS.find(({ key }) => data[key].length)?.key ?? "sources");
        }
      },
      (error: unknown) => {
        if (!cancelled)
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Could not read saved data.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [origin, requirement, step, attempt]);
  const data = state.status === "ready" ? state.data : null;
  const { Table } = LAYERS.find(({ key }) => key === layer)!;
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="car-origin-step-data"
      data-step-id={step.block.id}
    >
      <div className="shrink-0 border-b border-line p-4">
        <h3 className="text-sm font-semibold">Data at {step.block.label}</h3>
        <p className="mt-1 text-xs text-muted">
          {step.block.id === origin.step.block.id
            ? "Saved inputs to this option's Add to Car block"
            : "Saved data at this workflow step"}
          {step.block.id === origin.step.block.id && requirement.inputRank
            ? ` · ${requirement.inputRank}. Priority and shared context`
            : ""}
          . Upstream tables may include other options; Requirement & sources shows this option's
          exact citations.
        </p>
        {step.block.kind === "ai_splitter" && (
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant={scores ? "secondary" : "ghost"}
              onClick={() => setScores(true)}
            >
              Scores / routing
            </Button>
            <Button
              size="sm"
              variant={!scores ? "secondary" : "ghost"}
              onClick={() => setScores(false)}
            >
              Source / raw data
            </Button>
          </div>
        )}
      </div>
      {scores ? (
        <div className="min-h-0 flex-1 overflow-auto">
          {/* No active review run is supplied: historical inspection cannot write routing corrections. */}
          <SplitterPanel
            report={reportForStep(origin.run, step.block.id)}
            run={null}
            data={data}
            loading={state.status === "loading"}
            error={state.status === "error" ? state.message : null}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        </div>
      ) : state.status === "loading" ? (
        <p role="status" className="p-5 text-sm text-muted">
          Reading saved run data…
        </p>
      ) : state.status === "error" ? (
        <div role="alert" className="p-5 text-sm">
          <p className="mb-3 text-danger">{state.message}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry saved data read</Button>
        </div>
      ) : (
        <>
          <div
            className="flex shrink-0 flex-wrap gap-3 border-b border-line px-4 pt-3"
            role="tablist"
            aria-label="Saved data layers"
          >
            {LAYERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={layer === key}
                data-testid={`data-tab-${key}`}
                onClick={() => setLayer(key)}
                className={`border-b-2 pb-3 text-sm ${layer === key ? "border-brand text-brand" : "border-transparent text-muted"}`}
              >
                {label} ({state.data[key].length})
              </button>
            ))}
          </div>
          <div className="shrink-0 border-b border-line p-4">
            <TextInput
              aria-label="Filter rows"
              placeholder="Filter rows…"
              value={filter}
              onChange={setFilter}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <Table data={state.data} filter={filter} />
          </div>
        </>
      )}
    </div>
  );
}
