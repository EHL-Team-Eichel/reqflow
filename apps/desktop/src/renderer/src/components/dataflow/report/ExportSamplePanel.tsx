import { useState, useRef, useEffect } from "react";
import {
  HIL_SAMPLE_LIMIT,
  type PipelineData,
  type Lineage,
  type LineageStep,
  type WorkflowBlock,
  type WorkflowRun,
  type HilReportRequest,
} from "@reqflow/core";
import { TextInput } from "@/components/ui/controls";
import { Button } from "@/components/ui/Button";
import { ChevronDownIcon, ChevronRightIcon, DownloadIcon } from "@/components/ui/icons";
import { api } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import {
  initializeSampleSelection,
  toggleSelection,
  selectedSample,
  type ExportSelection,
} from "./export-helpers";

export function ExportSamplePanel({
  data,
  counts,
  gateBlock,
  lineage,
  step,
  run,
}: {
  data: PipelineData;
  counts: HilReportRequest["fullCounts"];
  gateBlock: WorkflowBlock;
  lineage: Lineage;
  step: LineageStep;
  run?: WorkflowRun | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => initializeSampleSelection(data));
  const [notes, setNotes] = useState({
    objective: "",
    owner: "",
    nextCheckpoint: "",
    openQuestions: "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const previewScope = useSettings((s) => s.settings.defaultScope);
  const totalSelected = Object.values(selectedIds).reduce((n, ids) => n + ids.size, 0);

  const handleExport = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    const request: HilReportRequest = {
      metadata: {
        scope: run?.scope ?? previewScope,
        gate: {
          label: gateBlock.label,
          instructions: String(gateBlock.params.instructions ?? ""),
          reviewer: String(gateBlock.params.reviewer ?? "anyone"),
          approvalsNeeded: Number(gateBlock.params.approvals ?? 1),
        },
        runId: run?.id,
        runStatus: run?.status,
        currentStep: { label: step.block.label, id: step.block.id },
        lineageSteps: lineage.steps.map((s) => ({
          id: s.block.id,
          label: s.block.label,
          kind: s.block.kind,
          path: s.path,
        })),
        lineageLinks: lineage.links.map(({ source, target, sourceLabel, targetLabel }) => ({
          source,
          target,
          sourceLabel,
          targetLabel,
        })),
      },
      selectedData: selectedSample(data, selectedIds),
      fullCounts: counts,
      notes,
    };
    try {
      const result = await api.exports.hilReport(request);
      if (mounted.current)
        setMessage(result ? `PDF saved: ${result.path}` : "Export cancelled. No PDF saved.");
    } catch (err: unknown) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const renderDataset = (key: keyof ExportSelection, items: { id: string; label: string }[]) => {
    if (!items.length) return null;
    return (
      <fieldset key={key} className="mt-3 border-t border-line pt-2" disabled={busy}>
        <legend className="text-sm font-semibold text-ink">
          {key}: {selectedIds[key].size} of {items.length} selected
        </legend>
        {items.length > 50 && (
          <p className="text-xs text-muted">
            First 50 candidates shown in source order, not a representative sample.
          </p>
        )}
        <div className="mt-2 max-h-32 overflow-auto space-y-1 rounded bg-panel p-2 text-sm">
          {items.slice(0, 50).map((item) => {
            const checked = selectedIds[key].has(item.id);
            return (
              <label key={item.id} className="flex items-start gap-2 text-ink">
                <input
                  type="checkbox"
                  data-testid="sample-item"
                  data-dataset={key}
                  data-id={item.id}
                  className="mt-1 accent-brand"
                  checked={checked}
                  disabled={!checked && totalSelected >= HIL_SAMPLE_LIMIT}
                  onChange={() => {
                    setSelectedIds((prev) => toggleSelection(prev, key, item.id));
                    setMessage(null);
                    setError(null);
                  }}
                />
                <span className="min-w-0">
                  <span className="block truncate" title={item.label}>
                    {item.label || item.id}
                  </span>
                  <span className="block truncate text-xs text-muted">{item.id}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  };

  return (
    <div
      data-testid="sample-export-panel"
      className="max-h-[55%] shrink-0 overflow-y-auto border-b border-line bg-panel-2"
    >
      <button
        data-testid="sample-export-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between gap-2 p-4 text-left hover:bg-panel"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-ink">
          {expanded ? (
            <ChevronDownIcon className="size-4" />
          ) : (
            <ChevronRightIcon className="size-4" />
          )}
          Format-check PDF
        </span>
        <span className="shrink-0 text-xs text-muted">
          {totalSelected} / {HIL_SAMPLE_LIMIT} selected
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4">
          <p className="mb-3 text-xs text-muted">
            Only checked items from <b>{step.block.label}</b> are exported. Defaults: first 3 per
            dataset. This checks format, not full evidence or approval. Unselected references stay
            omitted. Share source excerpts only with authorized reviewers.
          </p>
          <div className="space-y-2">
            {(
              [
                ["objective", "Review objective"],
                ["owner", "Owner / consulted functions"],
                ["nextCheckpoint", "Next checkpoint"],
                ["openQuestions", "Open questions / validation action"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="block text-xs text-muted">
                {label} (report only)
                <TextInput
                  aria-label={label}
                  placeholder={label}
                  maxLength={2000}
                  disabled={busy}
                  value={notes[key]}
                  onChange={(value) => setNotes((prev) => ({ ...prev, [key]: value }))}
                />
              </label>
            ))}
          </div>
          {renderDataset(
            "Requirements",
            data.requirements.map((r) => ({ id: r.id, label: r.title })),
          )}
          {renderDataset(
            "Themes",
            data.themes.map((t) => ({ id: t.id, label: t.label })),
          )}
          {renderDataset(
            "Findings",
            data.findings.map((f) => ({ id: f.id, label: f.statement })),
          )}
          {renderDataset(
            "Records",
            data.records.map((r) => ({ id: r.id, label: `${r.locator ?? r.id}: ${r.text}` })),
          )}
          {renderDataset(
            "Sources",
            data.sources.map((s) => ({ id: s.id, label: s.title })),
          )}
          {error && (
            <p role="alert" className="mt-3 break-words text-sm text-danger">
              {error}
            </p>
          )}
          {message && (
            <p
              role="status"
              data-testid="sample-export-result"
              className="mt-3 break-words text-sm text-brand"
            >
              {message}
            </p>
          )}
          <Button
            data-testid="sample-export-pdf"
            variant="primary"
            disabled={busy || totalSelected === 0}
            onClick={() => void handleExport()}
            className="mt-3 gap-2"
          >
            <DownloadIcon className="size-4" />
            {busy ? "Exporting..." : "Export sample PDF"}
          </Button>
        </div>
      )}
    </div>
  );
}
