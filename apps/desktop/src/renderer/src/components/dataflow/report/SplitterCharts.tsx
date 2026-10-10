import React from "react";
import type { PipelineData, SplitterGroup, SplitterReport } from "@reqflow/core";
import { chartWidth, formatConfidence, formatScore, matrixDescription } from "./splitter-view";

export function ScoreBreakdown({ group }: { group: SplitterGroup }) {
  const description = `Frequency contribution: ${formatScore(group.frequencyContribution)}; impact contribution: ${formatScore(group.impactContribution)}; total score: ${formatScore(group.score)}.`;
  return (
    <div className="min-w-0">
      <div
        role="img"
        aria-label={description}
        className="flex h-3 overflow-hidden rounded bg-panel-2 ring-1 ring-line"
      >
        <div
          aria-hidden="true"
          className="h-full bg-brand"
          style={{ width: `${chartWidth(group.frequencyContribution)}%` }}
        />
        <div
          aria-hidden="true"
          className="h-full bg-warn"
          style={{ width: `${chartWidth(group.impactContribution)}%` }}
        />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted tabular-nums">
        <span>
          Frequency {formatScore(group.frequency)} · contribution{" "}
          {formatScore(group.frequencyContribution)}
        </span>
        <span>
          Impact {formatScore(group.impact)} · contribution {formatScore(group.impactContribution)}
        </span>
      </div>
    </div>
  );
}

export function EvidenceBalance({ group }: { group: SplitterGroup }) {
  // This sum controls geometry only. Stance sets can overlap; it is not a unique-unit count.
  const size = group.support + group.opposition + group.unclear;
  const description = `${group.support} support, ${group.opposition} opposition, ${group.unclear} unclear. Stance counts may overlap; not customers.`;
  return (
    <div>
      <div
        role="img"
        aria-label={description}
        className="flex h-2 overflow-hidden rounded bg-panel-2 ring-1 ring-line"
      >
        <div
          aria-hidden="true"
          className="bg-ok"
          style={{ width: size ? `${(group.support / size) * 100}%` : "0%" }}
        />
        <div
          aria-hidden="true"
          className="bg-danger"
          style={{ width: size ? `${(group.opposition / size) * 100}%` : "0%" }}
        />
        <div
          aria-hidden="true"
          className="bg-muted"
          style={{ width: size ? `${(group.unclear / size) * 100}%` : "0%" }}
        />
      </div>
      <p className="mt-1 text-xs text-muted tabular-nums">
        {group.support} support · {group.opposition} opposition · {group.unclear} unclear
      </p>
    </div>
  );
}

export function SourceHeatmap({
  report,
  data,
  onSelect,
}: {
  report: Pick<SplitterReport, "groups" | "sourceMatrix">;
  data: PipelineData | null;
  onSelect: (groupId: string, sourceId: string) => void;
}) {
  const sourceIds = [...new Set(report.sourceMatrix.map((cell) => cell.sourceId))];
  const maxSupport = Math.max(1, ...report.sourceMatrix.map((cell) => cell.support));
  if (!sourceIds.length)
    return <p className="text-sm text-muted">Source × need matrix not computed in this report.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left text-xs" aria-label="Source by need evidence counts">
        <caption className="bg-panel-2 px-3 py-2 text-left text-muted">
          S = support, O = opposition, ? = unclear. Denominators are units in each source, not
          customers or population. Stances can overlap. Shade compares support counts only. Select a
          cell for exact evidence.
        </caption>
        <thead className="bg-panel-2 text-ink">
          <tr>
            <th scope="col" className="min-w-36 px-3 py-2">
              Source
            </th>
            {report.groups.map((group) => (
              <th key={group.id} scope="col" className="min-w-32 max-w-48 px-3 py-2 font-medium">
                {group.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sourceIds.map((sourceId) => (
            <tr key={sourceId} className="border-t border-line">
              <th scope="row" className="max-w-52 break-words px-3 py-2 font-medium text-ink">
                {data?.sources.find((source) => source.id === sourceId)?.title ?? sourceId}
              </th>
              {report.groups.map((group) => {
                const cells = report.sourceMatrix.filter(
                  (cell) => cell.sourceId === sourceId && cell.groupId === group.id,
                );
                return (
                  <td key={group.id} className="p-1 text-muted">
                    {cells.length ? (
                      cells.map((cell, index) => (
                        <button
                          key={index}
                          type="button"
                          aria-label={`${group.label}, ${sourceId}: ${matrixDescription(cell)}`}
                          onClick={() => onSelect(group.id, sourceId)}
                          className="relative block w-full overflow-hidden rounded px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-brand hover:ring-1 hover:ring-brand"
                        >
                          <span
                            aria-hidden="true"
                            className="absolute inset-0 bg-brand"
                            style={{ opacity: 0.04 + (0.2 * cell.support) / maxSupport }}
                          />
                          <span className="relative block font-medium text-ink tabular-nums">
                            S {cell.support} · O {cell.opposition} · ? {cell.unclear}
                          </span>
                          <span className="relative block">
                            /{" "}
                            {cell.denominator === null
                              ? "denominator not reported"
                              : `${cell.denominator} source units`}
                          </span>
                        </button>
                      ))
                    ) : (
                      <span className="px-3">Not reported</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ConfidenceLabel({ confidence }: { confidence: number | null }) {
  return (
    <span className="text-xs text-muted">
      AI confidence {formatConfidence(confidence)} · separate from score
    </span>
  );
}
