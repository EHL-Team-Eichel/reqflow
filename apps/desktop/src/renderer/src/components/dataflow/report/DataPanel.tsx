import { useState, useMemo, useEffect } from "react";
import { type LineageStep, type WorkflowGraph } from "@reqflow/core";
import { Button } from "@/components/ui/Button";
import { TableIcon } from "@/components/ui/icons";
import { TextInput } from "@/components/ui/controls";
import { sampleDataAt } from "./sample";
import { type PreviewState } from "../usePreview";
import { api } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { previewReportInputs, reportPreviewInputs } from "./preview";
import {
  SourcesTable,
  RecordsTable,
  FindingsTable,
  ThemesTable,
  RequirementsTable,
} from "./DataTables";
import { cx } from "@/lib/cx";

interface Props {
  root: WorkflowGraph;
  step: LineageStep;
  isTarget: boolean;
  showSample: boolean;
  onShowSample: (show: boolean) => void;
}

const TABS = ["Requirements", "Themes", "Findings", "Records", "Sources"] as const;
type Tab = (typeof TABS)[number];

export function DataPanel({ root, step, isTarget, showSample, onShowSample }: Props) {
  const [filter, setFilter] = useState("");
  const [activeTab, setActiveTab] = useState<Tab | null>(null);

  const scope = useSettings((s) => s.settings.defaultScope);
  const inputs = useMemo(() => reportPreviewInputs(root, step), [root, step]);
  const [result, setResult] = useState<{
    inputs: typeof inputs;
    scope: typeof scope;
    state: PreviewState;
  } | null>(null);
  const previewable = inputs !== null;
  useEffect(() => {
    if (!inputs) return;
    let cancelled = false;
    setResult({ inputs, scope, state: { status: "loading" } });
    void previewReportInputs(inputs, scope, api.blocks.preview).then(
      ({ data, logs }) => {
        if (!cancelled) setResult({ inputs, scope, state: { status: "ready", data, logs } });
      },
      (err: unknown) => {
        if (!cancelled)
          setResult({
            inputs,
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
  }, [inputs, scope]);
  // Hide old results immediately, before the effect reloads changed inputs or scope.
  const state: PreviewState =
    result?.inputs === inputs && result.scope === scope ? result.state : { status: "idle" };
  const real = state.status === "ready" ? state.data : null;

  // Real data wins. The synthetic sample is only for steps whose data needs a run.
  const data = useMemo(() => {
    if (previewable) return real;
    return showSample ? sampleDataAt(step.block.kind) : null;
  }, [previewable, real, showSample, step.block.kind]);

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
            </div>
          ) : (
            <div>
              <div className="mb-1 font-medium text-ink">No data yet</div>
              <div className="text-sm text-muted">
                This flow hasn't run, so nothing has reached this point. Once flows can run, the
                data that arrived here appears in this view.
              </div>
            </div>
          )}
          {!previewable && (
            <Button data-testid="data-sample" onClick={() => onShowSample(true)}>
              Preview with synthetic sample data
            </Button>
          )}
        </div>
      </div>
    );
  }

  const currentTab = activeTab || "Sources";

  return (
    <div data-testid="data-panel" className="flex flex-col h-full border-l border-line bg-panel">
      <div className="border-b border-line p-4 text-sm font-medium text-ink">{headerLabel}</div>

      {real ? (
        <div data-testid="data-real" className="bg-brand-soft px-4 py-2 text-xs text-brand">
          {step.block.kind === "hil"
            ? "Preview of connected source inputs, read just now. This flow has not run; no review or approval has been recorded."
            : `Read from the block's ${step.block.params.source === "database" ? "database" : "file"} just now: its own output, not a run.`}
        </div>
      ) : (
        <div className="flex items-center justify-between bg-warn-soft px-4 py-2 text-xs text-warn">
          <span>Synthetic sample — F70 demo fixtures, not data from this flow.</span>
          <button className="font-medium hover:underline" onClick={() => onShowSample(false)}>
            Hide
          </button>
        </div>
      )}

      <div className="border-b border-line px-4 pt-2">
        <div role="tablist" className="flex gap-4">
          {TABS.map((tab) => (
            <button
              key={tab}
              role="tab"
              aria-selected={currentTab === tab}
              data-testid={`data-tab-${tab.toLowerCase()}`}
              className={cx(
                "pb-2 text-sm font-medium border-b-2 transition-colors",
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
