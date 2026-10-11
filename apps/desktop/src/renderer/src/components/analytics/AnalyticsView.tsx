import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  graphAt,
  TimeGranularity,
  walkBlocks,
  type WorkflowBlock,
  type WorkflowGraph,
  type WorkflowRun,
} from "@reqflow/core";
import { dataflowStore, useDataflow } from "@/components/dataflow/store";
import { runStore } from "@/components/dataflow/run-session";
import { BlockIcon } from "@/components/dataflow/BlockIcon";
import { GROUP_STYLE } from "@/components/dataflow/groups";
import { MStripe } from "@/components/ui/MStripe";
import { Button } from "@/components/ui/Button";
import { MaximizeIcon, MinimizeIcon, XIcon } from "@/components/ui/icons";
import { cx } from "@/lib/cx";
import { AnalyticsContext, type AnalyticsContextValue } from "./context";
import {
  applyFilters,
  colorSlots,
  countByCountry,
  peopleCount,
  timeExtent,
} from "./engine/aggregate";
import { autoGranularity } from "./engine/time";
import type { AnalyticsFilters, AnalyticsInput } from "./engine/types";
import { formatNumber } from "./charts/format";
import { OTHER_COLOR, seriesColor } from "./charts/palette";
import { FilterBar } from "./FilterBar";
import { useAnalyticsData, type LoadState } from "./useAnalyticsData";
import { OverviewTab } from "./tabs/OverviewTab";
import { CountriesTab } from "./tabs/CountriesTab";
import { TimelineTab } from "./tabs/TimelineTab";
import { VoiceTab } from "./tabs/VoiceTab";
import { TopicsTab } from "./tabs/TopicsTab";
import { CompareTab } from "./tabs/CompareTab";
import { FlowTab } from "./tabs/FlowTab";
import { QualityTab } from "./tabs/QualityTab";

const TABS = [
  { id: "overview", label: "Overview", Component: OverviewTab },
  { id: "countries", label: "Countries", Component: CountriesTab },
  { id: "timeline", label: "Timeline", Component: TimelineTab },
  { id: "voice", label: "What people say", Component: VoiceTab },
  { id: "topics", label: "Topics & sentiment", Component: TopicsTab },
  { id: "compare", label: "Compare sources", Component: CompareTab },
  { id: "flow", label: "Flow", Component: FlowTab },
  { id: "quality", label: "Data quality", Component: QualityTab },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Mounted once on the Data Flow page; shows the analytics of the block opened in the store. */
export function AnalyticsHost() {
  const open = useDataflow((s) => s.analytics);
  const editorRoot = useDataflow((s) => s.root);
  const currentRun = useStore(runStore, (s) => s.run);
  // The saved run, when it contains this block: show exactly what arrived in it.
  const inRun = useMemo(
    () =>
      currentRun && open
        ? [...walkBlocks(currentRun.graph)].some(({ block }) => block.id === open.blockId)
        : false,
    [currentRun, open],
  );
  const run = inRun ? currentRun : null;
  const root = run?.graph ?? editorRoot;
  const path = useMemo(() => {
    if (!open) return [];
    if (!run) return open.path;
    return (
      [...walkBlocks(run.graph)].find(({ block }) => block.id === open.blockId)?.path ?? open.path
    );
  }, [open, run]);
  const block = useMemo(() => {
    if (!open) return null;
    try {
      return graphAt(root, path).blocks.find((b) => b.id === open.blockId) ?? null;
    } catch {
      return null; // its workplace was deleted
    }
  }, [root, path, open]);
  // Params (inputs' names, phrases, columns) always come from the editor, so edits show at once.
  const editorBlock = useMemo(() => {
    if (!open) return null;
    try {
      return graphAt(editorRoot, open.path).blocks.find((b) => b.id === open.blockId) ?? null;
    } catch {
      return null;
    }
  }, [editorRoot, open]);

  useEffect(() => {
    if (open && !block) dataflowStore.getState().closeAnalytics();
  }, [open, block]);

  if (!open || !block) return null;
  return (
    <AnalyticsScreen
      key={`${run?.id ?? "preview"}:${block.id}`}
      root={root}
      path={path}
      block={editorBlock ?? block}
      runBlock={block}
      run={run}
    />
  );
}

function AnalyticsScreen({
  root,
  path,
  block,
  runBlock,
  run,
}: {
  root: WorkflowGraph;
  path: string[];
  block: WorkflowBlock;
  runBlock: WorkflowBlock;
  run: WorkflowRun | null;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState<TabId>("overview");
  const state = useAnalyticsData({ root, path, block: runBlock, run, reload });

  // Opening the analytics takes the whole screen; Esc leaves full screen first, then closes.
  useEffect(() => {
    const el = screenRef.current;
    el?.focus();
    const onChange = () => setIsFullscreen(document.fullscreenElement === el);
    document.addEventListener("fullscreenchange", onChange);
    el?.requestFullscreen?.().catch(() => {
      /* not allowed here (no user gesture, or a test window): the overlay still fills the app */
    });
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) {
        dataflowStore.getState().closeAnalytics();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toggleFullscreen = () => {
    const el = screenRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div
      ref={screenRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="analytics-title"
      data-testid="analytics-view"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-canvas text-ink outline-none"
    >
      <MStripe className="rounded-none" />
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-panel px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={cx(
              "flex size-10 shrink-0 items-center justify-center rounded-xl",
              GROUP_STYLE.insight.tile,
            )}
          >
            <BlockIcon kind="analytics" className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 id="analytics-title" className="truncate text-lg font-semibold">
              Analytics · {block.label}
            </h2>
            <p className="text-xs text-muted">
              {run ? "Saved data of the current run" : "Live read of the connected sources"} ·
              counted by rules, no AI
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            data-testid="analytics-refresh"
            onClick={() => setReload((n) => n + 1)}
          >
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="analytics-fullscreen"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Leave full screen" : "Enter full screen"}
          >
            {isFullscreen ? (
              <MinimizeIcon className="size-4" />
            ) : (
              <MaximizeIcon className="size-4" />
            )}
            {isFullscreen ? "Exit full screen" : "Full screen"}
          </Button>
          <button
            type="button"
            aria-label="Close analytics"
            data-testid="analytics-close"
            className="rounded-lg p-2 text-muted hover:bg-panel-2 hover:text-ink"
            onClick={() => dataflowStore.getState().closeAnalytics()}
          >
            <XIcon className="size-5" />
          </button>
        </div>
      </header>
      <AnalyticsBody state={state} block={block} tab={tab} setTab={setTab} />
    </div>
  );
}

function AnalyticsBody({
  state,
  block,
  tab,
  setTab,
}: {
  state: LoadState;
  block: WorkflowBlock;
  tab: TabId;
  setTab: (tab: TabId) => void;
}) {
  if (state.status === "loading") {
    return (
      <div
        className="grid flex-1 place-items-center text-sm text-muted"
        data-testid="analytics-loading"
      >
        Reading the inputs and counting…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="grid flex-1 place-items-center p-8">
        <p role="alert" className="max-w-lg text-center text-sm text-danger">
          {state.message}
        </p>
      </div>
    );
  }
  return (
    <ReadyBody
      inputs={state.inputs}
      dataset={state.dataset}
      block={block}
      tab={tab}
      setTab={setTab}
    />
  );
}

function ReadyBody({
  inputs,
  dataset,
  block,
  tab,
  setTab,
}: {
  inputs: AnalyticsInput[];
  dataset: Extract<LoadState, { status: "ready" }>["dataset"];
  block: WorkflowBlock;
  tab: TabId;
  setTab: (tab: TabId) => void;
}) {
  const [filters, setFiltersState] = useState<AnalyticsFilters>({});
  const setFilters = useCallback(
    (patch: Partial<AnalyticsFilters>) => setFiltersState((f) => ({ ...f, ...patch })),
    [],
  );
  const rows = useMemo(() => applyFilters(dataset.rows, filters), [dataset, filters]);

  const countrySlots = useMemo(() => colorSlots(countByCountry(dataset.rows)), [dataset]);
  const granularitySetting = TimeGranularity.catch("auto").parse(block.params.timeGranularity);
  const extent = useMemo(() => timeExtent(dataset.rows), [dataset]);
  const granularity = useMemo(() => {
    if (granularitySetting !== "auto") return granularitySetting;
    return autoGranularity(dataset.rows.flatMap((r) => (r.time === null ? [] : [r.time])));
  }, [granularitySetting, dataset]);
  const phrases = useMemo(
    () =>
      String(block.params.phrases ?? "")
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean),
    [block.params.phrases],
  );

  const value: AnalyticsContextValue = useMemo(
    () => ({
      dataset,
      inputs,
      rows,
      allRows: dataset.rows,
      filters,
      setFilters,
      inputColor: (index) => seriesColor(index),
      countryColor: (code) => {
        const slot = countrySlots.get(code);
        return slot === undefined ? OTHER_COLOR : seriesColor(slot);
      },
      granularity,
      granularitySetting,
      setGranularity: (next) =>
        dataflowStore.getState().setParams(block.id, { ...block.params, timeGranularity: next }),
      phrases,
      setPhrases: (next) =>
        dataflowStore
          .getState()
          .setParams(block.id, { ...block.params, phrases: next.join("\n").slice(0, 5000) }),
      blockLabel: block.label,
    }),
    [
      dataset,
      inputs,
      rows,
      filters,
      setFilters,
      countrySlots,
      granularity,
      granularitySetting,
      phrases,
      block,
    ],
  );

  const Active = TABS.find((t) => t.id === tab)!.Component;
  const people = peopleCount(rows);

  return (
    <AnalyticsContext.Provider value={value}>
      <InputStrip inputs={inputs} />
      <nav
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-panel px-5"
        role="tablist"
        aria-label="Analytics views"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`analytics-tab-${t.id}`}
            onClick={() => setTab(t.id)}
            className={cx(
              "shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap",
              tab === t.id
                ? "border-brand text-brand"
                : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <FilterBar extent={extent} />
      <main className="min-h-0 flex-1 overflow-auto px-5 py-4" role="tabpanel">
        {dataset.rows.length === 0 ? (
          <NothingYet inputs={inputs} />
        ) : (
          <>
            <p className="mb-3 text-xs text-muted" data-testid="analytics-count">
              {rows.length === dataset.rows.length
                ? `All ${formatNumber(rows.length)} records`
                : `${formatNumber(rows.length)} of ${formatNumber(dataset.rows.length)} records match the filters`}{" "}
              · {formatNumber(people)} {dataset.idColumn ? "people" : "records counted as people"}
            </p>
            <Active />
          </>
        )}
      </main>
    </AnalyticsContext.Provider>
  );
}

function InputStrip({ inputs }: { inputs: AnalyticsInput[] }) {
  return (
    <div
      className="flex shrink-0 flex-wrap gap-2 border-b border-line bg-panel px-5 py-2"
      data-testid="analytics-inputs"
    >
      {inputs.map((input) => (
        <div
          key={input.port}
          className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-1 text-xs"
          title={input.message}
        >
          <span
            aria-hidden="true"
            className="inline-block size-2.5 rounded-sm"
            style={{ background: seriesColor(input.index) }}
          />
          <span className="font-medium text-ink">{input.label}</span>
          <span className={cx(input.status === "error" ? "text-danger" : "text-muted")}>
            {input.status === "ready"
              ? `${formatNumber(input.data?.records.length ?? 0)} records · ${formatNumber(input.data?.sources.length ?? 0)} sources`
              : input.status === "unconnected"
                ? "not connected"
                : input.status === "needs_run"
                  ? "needs a run"
                  : input.status === "error"
                    ? "couldn't be read"
                    : "reading…"}
          </span>
        </div>
      ))}
    </div>
  );
}

function NothingYet({ inputs }: { inputs: AnalyticsInput[] }) {
  return (
    <div className="mx-auto mt-12 max-w-xl rounded-xl border border-dashed border-line bg-panel p-8 text-center">
      <h3 className="text-base font-semibold">Nothing to count yet</h3>
      <p className="mt-2 text-sm text-muted">
        Connect a Raw or Research block to an input of this block. Sources show right away; data
        that passes through other blocks shows after the flow has run.
      </p>
      <ul className="mt-4 space-y-1 text-left text-sm">
        {inputs.map((i) => (
          <li key={i.port} className="flex gap-2">
            <span className="font-medium">{i.label}:</span>
            <span className="text-muted">
              {i.message ?? (i.status === "ready" ? "no records" : i.status)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
