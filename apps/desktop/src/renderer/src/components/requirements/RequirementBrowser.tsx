import React, { useId, useRef, useState } from "react";
import {
  CATEGORY_LABELS,
  DecisionStatus,
  EvidenceLevel,
  RequirementCategory,
  type ExportFormat,
  type Requirement,
} from "@reqflow/core";
import { api } from "../../lib/api";
import type { ClassifiedRequirement } from "../car/classify";
import { Button } from "../ui/Button";
import { RequirementCard } from "./RequirementCard";
import { EVIDENCE_LABELS, STATUS_LABELS } from "./labels";
import {
  exportAllRequirements,
  filterAndGroupRequirements,
  type RequirementBrowserOptions,
  type RequirementBrowserSort,
  type RequirementExportResult,
} from "./requirement-browser";

export interface RequirementBrowserProps {
  requirements: Requirement[];
  loading: boolean;
  error: string | null;
  onReload: () => Promise<void>;
  onOpen: (item: ClassifiedRequirement) => void;
}

const CONTROL =
  "h-8 w-full min-w-0 rounded-lg border border-line bg-panel-2 px-2 text-xs text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20";

export function RequirementBrowser({
  requirements,
  loading,
  error,
  onReload,
  onOpen,
}: RequirementBrowserProps) {
  const id = useId();
  const [options, setOptions] = useState<RequirementBrowserOptions>({});
  const [format, setFormat] = useState<ExportFormat>("json");
  const [exportResult, setExportResult] = useState<RequirementExportResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const exportBusy = useRef(false);
  const reloadBusy = useRef(false);
  const groups = filterAndGroupRequirements(requirements, options);
  const count = groups.reduce((total, group) => total + group.items.length, 0);
  const loadError = error ?? reloadError;

  async function reload() {
    if (loading || reloadBusy.current) return;
    reloadBusy.current = true;
    setReloading(true);
    setReloadError(null);
    try {
      await onReload();
    } catch (cause) {
      setReloadError(cause instanceof Error ? cause.message : "Could not reload requirements.");
    } finally {
      reloadBusy.current = false;
      setReloading(false);
    }
  }

  async function exportRequirements() {
    if (exportBusy.current) return;
    exportBusy.current = true;
    setExporting(true);
    setExportResult(null);
    try {
      setExportResult(
        await exportAllRequirements(format, (opts) => api.exports.requirements(opts)),
      );
    } finally {
      exportBusy.current = false;
      setExporting(false);
    }
  }

  return (
    <section
      aria-label="Requirements browser"
      data-testid="requirement-browser"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel text-ink"
    >
      <header className="shrink-0 space-y-3 border-b border-line p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Requirements</h2>
          <Button
            size="sm"
            disabled={loading || reloading}
            onClick={() => void reload()}
            data-testid="requirement-browser-reload"
          >
            {reloading ? "Reloading..." : "Reload"}
          </Button>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-query`} className="text-xs text-muted">
            Search requirements
          </label>
          <input
            id={`${id}-query`}
            type="search"
            value={options.query ?? ""}
            onChange={(event) => setOptions({ ...options, query: event.target.value })}
            placeholder="ID, title, description or target"
            data-testid="requirement-browser-query"
            className={CONTROL}
          />
        </div>
        <details data-testid="requirement-browser-filters">
          <summary className="cursor-pointer text-xs font-medium text-muted focus-visible:outline-brand">
            Filters & sorting
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label htmlFor={`${id}-category`} className="text-xs text-muted">
                Category
              </label>
              <select
                id={`${id}-category`}
                value={options.category ?? ""}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    category: event.target.value
                      ? RequirementCategory.parse(event.target.value)
                      : undefined,
                  })
                }
                data-testid="requirement-browser-category"
                className={CONTROL}
              >
                <option value="">All categories</option>
                {RequirementCategory.options.map((category) => (
                  <option key={category} value={category}>
                    {CATEGORY_LABELS[category]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-status`} className="text-xs text-muted">
                Status
              </label>
              <select
                id={`${id}-status`}
                value={options.status ?? ""}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    status: event.target.value
                      ? DecisionStatus.parse(event.target.value)
                      : undefined,
                  })
                }
                data-testid="requirement-browser-status"
                className={CONTROL}
              >
                <option value="">All statuses</option>
                {DecisionStatus.options.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-evidence`} className="text-xs text-muted">
                Evidence
              </label>
              <select
                id={`${id}-evidence`}
                value={options.evidence ?? ""}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    evidence: event.target.value
                      ? EvidenceLevel.parse(event.target.value)
                      : undefined,
                  })
                }
                data-testid="requirement-browser-evidence"
                className={CONTROL}
              >
                <option value="">All evidence levels</option>
                {EvidenceLevel.options.map((level) => (
                  <option key={level} value={level}>
                    {level}: {EVIDENCE_LABELS[level]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor={`${id}-sort`} className="text-xs text-muted">
                Sort within priority
              </label>
              <select
                id={`${id}-sort`}
                value={options.sort ?? "score"}
                onChange={(event) =>
                  setOptions({ ...options, sort: event.target.value as RequirementBrowserSort })
                }
                data-testid="requirement-browser-sort"
                className={CONTROL}
              >
                <option value="score">Score (highest first)</option>
                <option value="updated">Updated (newest first)</option>
                <option value="title">Title (A-Z)</option>
              </select>
            </div>
          </div>
        </details>
        <div className="flex items-center justify-between gap-2">
          <p role="status" className="text-xs text-muted" data-testid="requirement-browser-count">
            {count} of {requirements.length} shown
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOptions({})}
            data-testid="requirement-browser-clear"
          >
            Clear filters
          </Button>
        </div>
      </header>
      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3"
        aria-busy={loading || reloading}
        data-testid="requirement-browser-results"
      >
        {(loading || reloading) && (
          <p role="status" data-testid="requirement-browser-loading" className="text-sm text-muted">
            Loading requirements...
          </p>
        )}
        {loadError !== null && (
          <div
            role="alert"
            data-testid="requirement-browser-error"
            className="space-y-2 text-sm text-danger"
          >
            <p>Could not load requirements: {loadError}</p>
            {requirements.length > 0 && (
              <p className="text-xs text-muted">Showing previously loaded requirements.</p>
            )}
            <Button
              size="sm"
              disabled={loading || reloading}
              onClick={() => void reload()}
              data-testid="requirement-browser-retry"
            >
              Retry
            </Button>
          </div>
        )}
        {!loading && !reloading && loadError === null && count === 0 && (
          <p
            className="text-sm text-muted"
            data-testid={
              requirements.length === 0
                ? "requirement-browser-empty"
                : "requirement-browser-no-matches"
            }
          >
            {requirements.length === 0
              ? "No requirements yet. Run a workflow with Add to Car to create requirements."
              : "No requirements match these filters. Clear filters or change your search."}
          </p>
        )}
        {groups.map((group) => (
          <section
            key={group.priority}
            aria-label={`${group.label} requirements`}
            data-testid={`requirement-browser-group-${group.priority}`}
          >
            <h3 className="mb-2 flex justify-between text-xs font-semibold">
              <span>{group.label}</span>
              <span className="text-muted">{group.items.length}</span>
            </h3>
            <div className="space-y-2">
              {group.items.map((item) => (
                <RequirementCard
                  key={item.requirement.id}
                  item={item}
                  onOpen={() => onOpen(item)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <footer className="shrink-0 border-t border-line p-3">
        <details data-testid="requirement-browser-export-options">
          <summary className="cursor-pointer text-xs font-medium text-muted focus-visible:outline-brand">
            Export all requirements
          </summary>
          <div className="mt-2 space-y-2">
            <p id={`${id}-export-help`} className="text-xs leading-relaxed text-muted">
              Exports include all stored requirements, not just the filtered results. Choose a
              destination in the native save dialog.
            </p>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <label htmlFor={`${id}-format`} className="text-xs text-muted">
                  Export format
                </label>
                <select
                  id={`${id}-format`}
                  value={format}
                  disabled={exporting}
                  onChange={(event) => setFormat(event.target.value as ExportFormat)}
                  aria-describedby={`${id}-export-help`}
                  data-testid="requirement-browser-export-format"
                  className={CONTROL}
                >
                  <option value="json">JSON</option>
                  <option value="csv">CSV</option>
                  <option value="md">Markdown</option>
                </select>
              </div>
              <Button
                size="sm"
                disabled={exporting}
                onClick={() => void exportRequirements()}
                aria-describedby={`${id}-export-help`}
                data-testid="requirement-browser-export"
              >
                {exporting ? "Exporting..." : "Export all"}
              </Button>
            </div>
            {exportResult && (
              <p
                role={exportResult.status === "error" ? "alert" : "status"}
                data-testid={`requirement-browser-export-${exportResult.status}`}
                className={`break-words text-xs ${exportResult.status === "error" ? "text-danger" : "text-muted"}`}
              >
                {exportResult.status === "saved"
                  ? `Saved all stored requirements to ${exportResult.path}`
                  : exportResult.status === "cancelled"
                    ? "Export cancelled. No file saved."
                    : `Export failed: ${exportResult.message}`}
              </p>
            )}
          </div>
        </details>
      </footer>
    </section>
  );
}
