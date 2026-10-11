import { useCallback, useEffect, useState } from "react";
import type { LineageStep } from "@reqflow/core";
import type { RequirementDetail } from "@reqflow/core/ipc";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { breadcrumbOf } from "../dataflow/store";
import { RequirementDetails } from "./RequirementDetails";
import { SavedWorkflowChart } from "./SavedWorkflowChart";
import { OriginStepData } from "./OriginStepData";
import {
  loadRequirementOrigin,
  type OriginState,
  type RequirementOrigin,
} from "./requirement-origin";

export function RequirementOriginReport({ detail }: { detail: RequirementDetail }) {
  const [state, setState] = useState<OriginState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(
    () => loadRequirementOrigin(detail.requirement, api, setState),
    [detail.requirement, attempt],
  );
  if (state.status === "ready") return <SavedOriginReport detail={detail} origin={state.origin} />;
  return (
    <div className="h-full overflow-auto p-5">
      <div
        className="mb-5 rounded-lg border border-line bg-panel-2 p-4 text-sm"
        data-testid="car-origin-unavailable"
      >
        <h3 className="font-semibold">Workflow origin</h3>
        <p role={state.status === "error" ? "alert" : "status"} className="mt-1 text-muted">
          {state.status === "loading" ? "Loading the exact originating workflow…" : state.message}
        </p>
        {state.status === "error" && (
          <Button className="mt-3" onClick={() => setAttempt((n) => n + 1)}>
            Retry workflow origin
          </Button>
        )}
      </div>
      <RequirementDetails detail={detail} />
    </div>
  );
}

function SavedOriginReport({
  detail,
  origin,
}: {
  detail: RequirementDetail;
  origin: RequirementOrigin;
}) {
  const [selected, setSelected] = useState(origin.step);
  const [view, setView] = useState<"requirement" | "data">("requirement");
  const [workplace, setWorkplace] = useState<string[] | null>(null);
  const onSelect = useCallback((step: LineageStep) => {
    setSelected(step);
    setView("data");
  }, []);
  const onWorkplace = useCallback((path: string[]) => setWorkplace(path), []);
  const crumbs = breadcrumbOf(origin.run.graph, workplace ?? origin.step.path);
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="car-origin-report"
      data-run-id={origin.run.id}
      data-origin-block-id={origin.step.block.id}
    >
      <div className="shrink-0 border-b border-line bg-panel-2 px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span>
            Origin: <strong className="text-ink">{origin.step.block.label}</strong>
          </span>
          <span className="font-mono">
            {origin.run.id} · workflow v{origin.run.workflowVersion}
          </span>
          <span>
            {origin.run.scope.vehicleLine} · {origin.run.scope.market} · {origin.run.startedAt}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted">
          Saved run snapshot · read-only · no approvals, routing changes or workflow edits.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={view === "requirement" ? "secondary" : "ghost"}
            data-testid="car-origin-requirement"
            onClick={() => setView("requirement")}
          >
            Requirement & sources
          </Button>
          <Button
            size="sm"
            variant={view === "data" ? "secondary" : "ghost"}
            data-testid="car-origin-data"
            onClick={() => {
              setSelected(origin.step);
              setView("data");
            }}
          >
            Data at this point
          </Button>
          <Button
            size="sm"
            variant={workplace !== null ? "secondary" : "ghost"}
            data-testid="car-origin-workflow"
            onClick={() => setWorkplace(origin.step.path)}
          >
            Build workflow
          </Button>
          <Button
            size="sm"
            variant={workplace === null ? "secondary" : "ghost"}
            data-testid="car-origin-lineage"
            onClick={() => setWorkplace(null)}
          >
            How the data was collected
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,36%)_minmax(0,1fr)]">
        <div className="flex min-h-0 flex-col border-r border-line bg-panel-2">
          <div className="shrink-0 p-4">
            <h3 className="font-semibold">
              {workplace !== null ? "Build workflow visualizer" : "How the data was collected"}
            </h3>
            <p className="mt-1 text-xs text-muted">
              Select a step to inspect saved data. Workplace opens the original workflow, never the
              live editor.
            </p>
            {workplace !== null && (
              <nav
                className="mt-2 flex flex-wrap gap-1 text-xs"
                aria-label="Saved workflow workplaces"
              >
                {crumbs.map((crumb, i) => (
                  <button
                    type="button"
                    key={i}
                    className="rounded px-1 py-1 text-brand hover:bg-brand-soft"
                    onClick={() => setWorkplace(workplace.slice(0, i))}
                  >
                    {i > 0 ? "› " : ""}
                    {crumb.label}
                  </button>
                ))}
              </nav>
            )}
            {workplace !== null && selected.block.inner && (
              <Button
                size="sm"
                className="mt-2"
                data-testid="car-origin-inner-workplace"
                onClick={() => setWorkplace([...selected.path, selected.block.id])}
              >
                Open {selected.block.label} workplace
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <SavedWorkflowChart
              origin={origin}
              selectedStep={selected}
              workplace={workplace}
              onSelect={onSelect}
              onWorkplace={onWorkplace}
            />
          </div>
        </div>
        <div className="min-h-0">
          {view === "requirement" ? (
            <div className="h-full overflow-auto p-5">
              <RequirementDetails detail={detail} />
            </div>
          ) : (
            <OriginStepData
              key={selected.block.id}
              origin={origin}
              requirement={detail.requirement}
              step={selected}
            />
          )}
        </div>
      </div>
    </div>
  );
}
