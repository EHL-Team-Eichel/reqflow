import { useState, useMemo, useEffect } from "react";
import { useStore } from "zustand";
import {
  type LineageStep,
  type WorkflowGraph,
  type WorkflowRun,
  type WorkflowBlock,
  type Lineage,
} from "@reqflow/core";
import { TableIcon } from "@/components/ui/icons";
import { TextInput } from "@/components/ui/controls";
import { Button } from "@/components/ui/Button";
import { type PreviewState } from "../usePreview";
import { api } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { previewReportInputs, reportPreviewInputs } from "./preview";
import { loadRunData } from "./run-data";
import { ExportSamplePanel } from "./ExportSamplePanel";
import {
  SourcesTable,
  RecordsTable,
  FindingsTable,
  ThemesTable,
  RequirementsTable,
} from "./DataTables";
import { cx } from "@/lib/cx";
import { SplitterPanel } from "./SplitterPanel";
import { reportForStep, reportRevision } from "./splitter-view";
import { runStore } from "../run-session";
import { previewSource } from "../source-preview";

interface Props {
  root: WorkflowGraph;
  run?: WorkflowRun | null;
  onReviewReady?: (ready: boolean) => void;
  step: LineageStep;
  isTarget: boolean;
  gateBlock?: WorkflowBlock;
  lineage?: Lineage;
}

const TABS = ["Requirements", "Themes", "Findings", "Records", "Sources"] as const;
type Tab = (typeof TABS)[number];

export function DataPanel(props: Props) {
  const isSplitter = props.step.block.kind === "ai_splitter";
  const [view, setView] = useState<"scores" | "data">(isSplitter ? "scores" : "data");
  return (
    <div className="flex h-full min-h-0 flex-col">
      {isSplitter && (
        <div
          className="flex shrink-0 gap-4 border-b border-l border-line bg-panel px-4 pt-3"
          role="tablist"
          aria-label="Splitter inspection"
        >
          {(["scores", "data"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              aria-controls={`splitter-${tab}-panel`}
              id={`splitter-${tab}-tab`}
              data-testid={`splitter-tab-${tab}`}
              onClick={() => setView(tab)}
              className={cx(
                "border-b-2 pb-3 text-sm font-medium",
                view === tab
                  ? "border-brand text-brand"
                  : "border-transparent text-muted hover:text-ink",
              )}
            >
              {tab === "scores" ? "Scores / routing" : "Source / raw data"}
            </button>
          ))}
        </div>
      )}
      <div
        className="min-h-0 flex-1"
        role={isSplitter ? "tabpanel" : undefined}
        id={isSplitter ? `splitter-${view}-panel` : undefined}
        aria-labelledby={isSplitter ? `splitter-${view}-tab` : undefined}
      >
        <DataPanelBody {...props} analysisView={isSplitter && view === "scores"} />
      </div>
    </div>
  );
}

function DataPanelBody({
  root,
  run,
  step,
  isTarget,
  onReviewReady,
  gateBlock,
  lineage,
  analysisView,
}: Props & { analysisView: boolean }) {
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState<Tab | null>(null);
  const [reload, setReload] = useState(0);

  const scope = useSettings((s) => s.settings.defaultScope);
  const sourceRun = useStore(runStore, (s) => s.run);
  const inputs = useMemo(
    () => (run ? null : reportPreviewInputs(root, step)),
    [root, step, run?.id],
  );
  const revision = reportRevision(run);
  const request = useMemo(
    () => ({ inputs, run, step, sourceRun }),
    [
      inputs,
      run?.id,
      revision,
      reload,
      run?.blockRuns.find((br) => br.blockId === step.block.id)?.status,
      step.block.id,
      step.path.join("/"),
      sourceRun,
    ],
  );
  const [result, setResult] = useState<{
    request: typeof request;
    scope: typeof scope;
    state: PreviewState;
  } | null>(null);
  const previewable = !!run || inputs !== null;
  useEffect(() => {
    if (!request.run && !request.inputs) return;
    let cancelled = false;
    setResult({ request, scope, state: { status: "loading" } });
    const read = request.run
      ? loadRunData(request.run, request.step, api.runs.blockOutput).then((data) => ({
          data,
          logs: [],
        }))
      : previewReportInputs(request.inputs!, scope, api.blocks.preview, (block) =>
          previewSource(api, block, scope, request.sourceRun),
        );
    void read.then(
      ({ data, logs }) => {
        if (!cancelled) setResult({ request, scope, state: { status: "ready", data, logs } });
      },
      (err: unknown) => {
        if (!cancelled)
          setResult({
            request,
            scope,
            state: {
              status: "error",
              message: err instanceof Error ? err.message : String(err),
              logs: [],
            },
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [request, scope]);
  // Hide old results immediately, before the effect reloads changed inputs or scope.
  const state: PreviewState =
    result?.request === request && result.scope === scope ? result.state : { status: "idle" };
  const real = state.status === "ready" ? state.data : null;
  useEffect(() => {
    onReviewReady?.(!!run && isTarget && state.status === "ready");
    return () => onReviewReady?.(false);
  }, [run?.id, isTarget, state.status, onReviewReady]);

  // Only real data: a source's own output, a HIL's connected sources, or a saved run.
  const data = real;

  const counts = useMemo(() => {
    if (!data) return null;
    return {
      Requirements: data.requirements.length,
      Themes: data.themes.length,
      Findings: data.findings.length,
      Records: data.records.length,
      Sources: data.sources.length,
    };
  }, [data]);

  useEffect(() => {
    if (!counts) return;
    const defaultTab = TABS.find((t) => counts[t] > 0) || "Sources";
    setActiveTab(defaultTab);
  }, [counts, step.block.id]); // Reset tab when step changes

  const headerLabel = isTarget ? "Data at this point" : `Data at ${step.block.label}`;

  if (analysisView)
    return (
      <div className="h-full overflow-auto border-l border-line bg-panel">
        <SplitterPanel
          report={reportForStep(run, step.block.id)}
          run={run ?? null}
          data={data}
          loading={state.status === "idle" || state.status === "loading"}
          error={state.status === "error" ? state.message : null}
          onRetry={() => setReload((value) => value + 1)}
        />
      </div>
    );

  if (previewable && (state.status === "idle" || state.status === "loading")) {
    return (
      <div
        data-testid="data-panel"
        className="flex h-full flex-col border-l border-line bg-panel-2"
      >
        <div className="border-b border-line p-4 text-sm font-medium text-ink">{headerLabel}</div>
        <p className="p-6 text-sm text-muted">Reading the block's data…</p>
      </div>
    );
  }

  if (!data || !counts) {
    return (
      <div
        data-testid="data-panel"
        className="flex flex-col h-full border-l border-line bg-panel-2"
      >
        <div className="border-b border-line p-4 text-sm font-medium text-ink">{headerLabel}</div>
        <div
          data-testid="data-empty"
          className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
        >
          <TableIcon className="size-8 text-muted" />
          {previewable && state.status === "error" ? (
            <div>
              <div className="mb-1 font-medium text-ink">Couldn't read this block's data</div>
              <div role="alert" className="text-sm text-danger">
                {state.message}
              </div>
              <Button className="mt-3" onClick={() => setReload((value) => value + 1)}>
                {run ? "Retry saved data read" : "Retry source preview"}
              </Button>
            </div>
          ) : (
            <div>
              <div className="mb-1 font-medium text-ink">No data yet</div>
              <div className="text-sm text-muted">
                Nothing has reached this point yet. Start the flow to see the data that arrives
                here.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const currentTab = activeTab || "Sources";

  return (
    <div
      data-testid="data-panel"
      className="flex min-h-0 flex-col h-full border-l border-line bg-panel"
    >
      <div className="border-b border-line p-4 text-sm font-medium text-ink">{headerLabel}</div>

      {gateBlock && lineage && data && counts && (
        <ExportSamplePanel
          key={[step.block.id, run?.id].join("-")}
          data={data}
          counts={counts}
          gateBlock={gateBlock}
          lineage={lineage}
          step={step}
          run={run}
        />
      )}

      <div data-testid="data-real" className="bg-brand-soft px-4 py-2 text-xs text-brand">
        {run
          ? "Saved data from this run. Reviewing or continuing the flow does not approve its requirements."
          : inputs?.some(
                ({ block }) => block.kind === "research" || block.kind === "research_opencode",
              )
            ? `Source preview with saved Research output from run ${sourceRun?.id}.${step.block.kind === "hil" ? " This HIL step has not run; no review or approval has been recorded." : ""}`
            : step.block.kind === "hil"
              ? "Preview of connected source inputs, read just now. This flow has not run; no review or approval has been recorded."
              : `Read from the block's ${step.block.params.source === "database" ? "database" : "file"} just now: its own output, not a run.`}
      </div>

      <div className="border-b border-line px-4 pt-2">
        <div
          role="tablist"
          aria-label="Saved data layers"
          className="flex flex-wrap gap-x-4 gap-y-1"
        >
          {TABS.map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={currentTab === tab}
              data-testid={`data-tab-${tab.toLowerCase()}`}
              className={cx(
                "shrink-0 pb-2 text-sm font-medium border-b-2 transition-colors",
                currentTab === tab
                  ? "border-brand text-brand"
                  : "border-transparent text-muted hover:text-ink hover:border-line",
              )}
              onClick={() => setActiveTab(tab)}
            >
              {tab} <span className="ml-1 opacity-50">({counts[tab]})</span>
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 border-b border-line">
        <TextInput
          aria-label="Filter rows"
          placeholder="Filter rows..."
          value={filter}
          onChange={setFilter}
        />
      </div>

      <div className="flex-1 overflow-auto bg-panel">
        {currentTab === "Sources" && <SourcesTable data={data} filter={filter} />}
        {currentTab === "Records" && <RecordsTable data={data} filter={filter} />}
        {currentTab === "Findings" && <FindingsTable data={data} filter={filter} />}
        {currentTab === "Themes" && <ThemesTable data={data} filter={filter} />}
        {currentTab === "Requirements" && <RequirementsTable data={data} filter={filter} />}
      </div>
    </div>
  );
}
