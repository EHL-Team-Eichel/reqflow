import { useEffect, useMemo, useRef, useState } from "react";
import { FilterReport, FilterReviewState, type WorkflowRun } from "@reqflow/core";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { TextArea, TextInput } from "@/components/ui/controls";
import { Field } from "@/components/ui/Field";
import {
  FILTER_TABS,
  filterDisposition,
  filterPage,
  filterProvenance,
  filterRestoreGuard,
  filterRestoreRequest,
  filterRows,
  pendingFilterOverride,
  safeFilterJson,
  saveFilterRestore,
  settleFilterRequest,
  type FilterTab,
} from "./filter-view";

const INPUT_LAYERS = ["records", "findings", "themes", "requirements", "sources"] as const;

/** Reads only the preserved report input, including items that were excluded. */
export function FilterInputPanel({ run, blockId }: { run: WorkflowRun | null; blockId: string }) {
  const saved = run?.blockRuns.find((item) => item.blockId === blockId)?.filterReport;
  const parsed = useMemo(() => (saved ? FilterReport.safeParse(saved) : null), [saved]);
  const [layer, setLayer] = useState<(typeof INPUT_LAYERS)[number]>("records");
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  if (!parsed?.success || parsed.data.runId !== run?.id || parsed.data.blockId !== blockId)
    return <FilterPanel run={run} blockId={blockId} />;
  const input = parsed.data.originalInput;
  const items = input[layer].filter((item) =>
    safeFilterJson(item).toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(items.length / 20));
  const currentPage = Math.min(page, pages - 1);
  return (
    <div className="space-y-3 p-4 text-sm text-ink">
      <h3 className="font-semibold">Saved original input</h3>
      <p className="text-xs text-muted">
        Preserved from this run, not re-read from a source. Includes excluded items and extra
        structured fields.
      </p>
      <div className="flex flex-wrap gap-2">
        {INPUT_LAYERS.map((key) => (
          <Button
            key={key}
            size="sm"
            aria-pressed={key === layer}
            onClick={() => {
              setLayer(key);
              setPage(0);
            }}
          >
            {key} ({input[key].length})
          </Button>
        ))}
      </div>
      <TextInput
        aria-label="Search saved original input"
        value={query}
        onChange={(value) => {
          setQuery(value);
          setPage(0);
        }}
      />
      {items.slice(currentPage * 20, currentPage * 20 + 20).map((item) => (
        <details key={item.id} className="rounded-lg border border-line p-2">
          <summary className="cursor-pointer break-words text-brand">{item.id}</summary>
          <Json value={item} />
        </details>
      ))}
      {!items.length && <p className="text-muted">No matching saved items.</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
          Previous
        </Button>
        <span className="text-xs">
          Page {currentPage + 1} of {pages} | {items.length} matches
        </span>
        <Button
          size="sm"
          disabled={currentPage + 1 >= pages}
          onClick={() => setPage(currentPage + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export function FilterPanel({ run, blockId }: { run: WorkflowRun | null; blockId: string }) {
  const blockRun = run?.blockRuns.find((item) => item.blockId === blockId);
  const saved = blockRun?.filterReport;
  const parsed = useMemo(() => (saved ? FilterReport.safeParse(saved) : null), [saved]);
  if (!parsed)
    return (
      <div className="p-6 text-sm text-muted" data-testid="filter-report-empty">
        <h3 className="font-semibold text-ink">Filtering report not available</h3>
        <p className="mt-2">
          {!run
            ? "No saved run. No preview or filtering is performed here."
            : blockRun?.status === "running" || blockRun?.status === "pending"
              ? "Waiting for a saved filter report from this run."
              : "This saved run has no built-in filter report. A legacy run or user-authored inner workplace may not produce one."}
        </p>
        {(blockRun?.error || run?.error) && (
          <p role="alert" className="mt-2 text-danger">
            {blockRun?.error || run?.error}
          </p>
        )}
      </div>
    );
  if (!parsed.success || parsed.data.runId !== run?.id || parsed.data.blockId !== blockId)
    return (
      <p role="alert" className="p-6 text-sm text-danger">
        The saved filtering report is invalid or does not match this run and block. No report values
        have been invented.
      </p>
    );
  return <StoredFilterPanel key={`${run.id}:${blockId}`} run={run} report={parsed.data} />;
}

function StoredFilterPanel({ run, report }: { run: WorkflowRun; report: FilterReport }) {
  const rows = useMemo(() => filterRows(report), [report]);
  const [tab, setTab] = useState<FilterTab>("keep");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [pending, setPending] = useState<FilterReviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const epoch = useRef(0);
  const paged = filterPage(rows, tab, query, page);
  const selected = rows.find((row) => row.decision.itemId === selectedId);

  const refresh = () => {
    const token = ++epoch.current;
    setBusy(true);
    setPending(null);
    setError(null);
    void settleFilterRequest(
      async () => FilterReviewState.parse(await api.runs.filterReviewState(run.id, report.blockId)),
      () => epoch.current === token,
      (state) => {
        setPending(state);
        setBusy(false);
      },
      (message) => {
        setError(`Could not read pending restores: ${message}`);
        setBusy(false);
      },
    );
  };
  useEffect(() => {
    refresh();
    return () => {
      epoch.current++;
    };
  }, [run.id, report.blockId, run.status]);

  const restore = () => {
    if (!selected || busy) return;
    const token = ++epoch.current;
    let input;
    try {
      input = filterRestoreRequest(run, report, selected.decision, pending, rationale);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    void settleFilterRequest(
      () =>
        saveFilterRestore(api.runs, report, input, (state) => {
          if (epoch.current === token) setPending(state);
        }),
      () => epoch.current === token,
      (state) => {
        setPending(state);
        setBusy(false);
        setNotice(
          "Restore saved for the next full run. This historical report, output and downstream requirements are unchanged. Nothing was started or resumed.",
        );
      },
      (message) => {
        setError(message);
        setBusy(false);
      },
    );
  };

  const guard = selected ? filterRestoreGuard(run, report, selected.decision, pending) : null;
  return (
    <div data-testid="filter-report" className="space-y-4 p-4 text-sm text-ink">
      {(run.error || run.blockRuns.find((item) => item.blockId === report.blockId)?.error) && (
        <p role="alert" className="text-danger">
          {run.blockRuns.find((item) => item.blockId === report.blockId)?.error || run.error}
        </p>
      )}
      <section className="rounded-lg border border-line bg-panel-2 p-3">
        <h3 className="font-semibold">Saved filtering analysis</h3>
        <p className="mt-1 text-xs text-muted">
          {report.createdAt} | {report.primaryLayer} | {report.runId} | {run.status}
        </p>
        <p className="mt-2 text-xs text-muted">
          Original items remain unchanged. Model decision and final outcome can differ; forwarded
          items and retained supporting context are separate dispositions. Confidence is not a
          calibrated probability. Missing fields require review.
        </p>
        <p className="mt-2 text-xs text-warn">
          Restore on next run records a human override only. A full rerun is required to apply it
          and may create additional downstream requirements. It never changes this historical report
          or continues this flow.
        </p>
        <details className="mt-3">
          <summary className="cursor-pointer text-brand">Configuration snapshot & scope</summary>
          <Json
            value={{
              configuration: report.configuration,
              configurationHash: report.configurationHash,
              scope: run.scope,
            }}
          />
        </details>
        {report.warnings.length > 0 && (
          <details open className="mt-2 text-warn">
            <summary>Warnings ({report.warnings.length})</summary>
            <ul className="list-inside list-disc">
              {report.warnings.slice(0, 30).map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
            {report.warnings.length > 30 && <Json value={report.warnings} />}
          </details>
        )}
        <details className="mt-2">
          <summary className="cursor-pointer text-brand">Additional original input fields</summary>
          <Json
            value={Object.fromEntries(
              Object.entries(report.originalInput).filter(
                ([key]) =>
                  !["records", "sources", "themes", "findings", "requirements"].includes(key),
              ),
            )}
          />
        </details>
      </section>
      <div className="flex flex-wrap gap-2" aria-label="Filter dispositions">
        {FILTER_TABS.map((item) => (
          <Button
            key={item.value}
            aria-pressed={tab === item.value}
            variant={tab === item.value ? "primary" : "secondary"}
            onClick={() => {
              setTab(item.value);
              setPage(0);
              setSelectedId(null);
              setRationale("");
            }}
          >
            {item.label} ({paged.counts[item.value]})
          </Button>
        ))}
      </div>
      <TextInput
        aria-label="Search filter report"
        placeholder="Search original content, reasons, quotes, model or location"
        value={query}
        onChange={(value) => {
          setQuery(value);
          setPage(0);
          setSelectedId(null);
          setRationale("");
        }}
      />
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Saved item decisions, 20 items per page</caption>
          <thead className="bg-panel-2 text-muted">
            <tr>
              <th className="p-2">Item / original</th>
              <th className="p-2">Model / outcome</th>
              <th className="p-2">Disposition</th>
              <th className="p-2">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map(({ decision, original }) => (
              <tr key={decision.itemId} className="border-t border-line align-top">
                <td className="max-w-64 p-2">
                  <button
                    type="button"
                    className="text-left text-brand hover:underline"
                    onClick={() => {
                      setSelectedId(decision.itemId);
                      setRationale("");
                    }}
                  >
                    {decision.itemId}
                  </button>
                  <p className="line-clamp-2 break-words text-muted">
                    {original &&
                      ("text" in original
                        ? String(original.text)
                        : "title" in original
                          ? String(original.title)
                          : safeFilterJson(original)
                      ).slice(0, 300)}
                  </p>
                  {pendingFilterOverride(report, decision, pending) && (
                    <p className="text-brand">Restore pending for next run</p>
                  )}
                </td>
                <td className="p-2">
                  {decision.modelDecision} to {decision.outcome}
                </td>
                <td className="p-2">{filterDisposition(decision)}</td>
                <td className="p-2">
                  {decision.confidence.toFixed(2)}
                  <span className="block text-muted">Not calibrated</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!paged.total && <p className="p-4 text-muted">No matching items in this tab.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <Button size="sm" disabled={paged.page === 0} onClick={() => setPage(paged.page - 1)}>
          Previous
        </Button>
        <span>
          Page {paged.page + 1} of {paged.pages} | {paged.total} matches
        </span>
        <Button
          size="sm"
          disabled={paged.page + 1 >= paged.pages}
          onClick={() => setPage(paged.page + 1)}
        >
          Next
        </Button>
      </div>
      {selected && (
        <section
          className="space-y-3 rounded-lg border border-line p-3"
          aria-label="Selected filter item"
        >
          <h4 className="break-words font-semibold">{selected.decision.itemId}</h4>
          <p>
            Model decision: {selected.decision.modelDecision} | Final outcome:{" "}
            {selected.decision.outcome}
          </p>
          <p className="text-xs text-muted">
            {filterDisposition(selected.decision)} | Model: {selected.decision.model} | Confidence:{" "}
            {selected.decision.confidence.toFixed(2)} (not calibrated)
          </p>
          <p className="whitespace-pre-wrap break-words">{selected.decision.reason}</p>
          <h5 className="font-medium">Exact original {selected.layer} item / structured fields</h5>
          <Json value={selected.original} />
          <h5 className="font-medium">Exact quotes & source locations</h5>
          {selected.decision.quotes.length ? (
            selected.decision.quotes.slice(0, 30).map((quote, index) => {
              const record = report.originalInput.records.find(
                (item) => item.id === quote.recordId,
              );
              const source = report.originalInput.sources.find(
                (item) => item.id === record?.sourceId,
              );
              return (
                <div key={index} className="rounded bg-panel-2 p-2 text-xs">
                  <blockquote className="whitespace-pre-wrap break-words">
                    {quote.excerpt}
                  </blockquote>
                  <p className="mt-1 break-words text-muted">
                    {quote.recordId} | {record?.locator || "Location not recorded"} |{" "}
                    {source?.title || record?.sourceId || "Source not recorded"} |{" "}
                    {source?.uri || "URI not recorded"}
                  </p>
                </div>
              );
            })
          ) : (
            <p className="text-xs text-muted">No exact quotes recorded.</p>
          )}
          {selected.decision.quotes.length > 30 && (
            <details>
              <summary>All recorded quotes</summary>
              <Json value={selected.decision.quotes} />
            </details>
          )}
          <SourceLocations report={report} original={selected.original} />
          {selected.decision.override && (
            <details>
              <summary>Human override applied in this saved run</summary>
              <Json value={selected.decision.override} />
            </details>
          )}
          {pendingFilterOverride(report, selected.decision, pending) && (
            <div className="text-xs text-brand">
              <p>Matching restore pending for next full run.</p>
              <Json value={pendingFilterOverride(report, selected.decision, pending)} />
            </div>
          )}
          {(selected.decision.outcome === "exclude" ||
            (selected.decision.outcome === "review" && !selected.decision.forwarded)) && (
            <>
              <Field
                label="Human rationale for restore"
                help="Required, 1-2000 characters. This is a next-run override, not a requirement approval."
              >
                {(id) => (
                  <TextArea
                    data-testid="filter-restore-rationale"
                    id={id}
                    value={rationale}
                    maxLength={2000}
                    onChange={setRationale}
                    disabled={busy}
                  />
                )}
              </Field>
              {guard && <p className="text-xs text-muted">{guard}</p>}
              <Button
                data-testid="filter-restore"
                variant="primary"
                disabled={busy || !!guard || !rationale.trim() || rationale.trim().length > 2000}
                onClick={restore}
              >
                Restore on next run
              </Button>
            </>
          )}
        </section>
      )}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>
          {busy
            ? "Reading / saving pending restore state..."
            : pending
              ? `Pending restore state v${pending.version}`
              : "Pending restore state unavailable"}
        </span>
        <Button size="sm" disabled={busy} onClick={refresh}>
          Refresh pending restores
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-brand">
          {notice}
        </p>
      )}
    </div>
  );
}

function SourceLocations({
  report,
  original,
}: {
  report: FilterReport;
  original: ReturnType<typeof filterRows>[number]["original"];
}) {
  if (!original)
    return <p className="text-xs text-warn">Original item is missing from the saved input.</p>;
  return (
    <details>
      <summary className="cursor-pointer text-brand">Original source / provenance</summary>
      <Json value={filterProvenance(report, original)} />
    </details>
  );
}

function Json({ value }: { value: unknown }) {
  const text = safeFilterJson(value);
  return (
    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-panel-2 p-2 text-xs">
      {text.slice(0, 50000)}
      {text.length > 50000
        ? "\n[Display truncated at 50,000 characters; saved data is unchanged.]"
        : ""}
    </pre>
  );
}
