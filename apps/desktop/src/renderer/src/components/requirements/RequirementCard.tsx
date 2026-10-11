import React from "react";
import type { ClassifiedRequirement } from "../car/classify";
import { PRIORITY_LABELS, STATUS_LABELS } from "./labels";

/** Bounded overview: the requirement, its first two targets, and essential review signals. */
export function RequirementCard({
  item,
  onOpen,
}: {
  item: ClassifiedRequirement;
  onOpen: () => void;
}) {
  const { requirement: r, assignment: a } = item;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`View details and sources for ${r.id}: ${r.title}`}
      aria-haspopup="dialog"
      data-testid="car-requirement"
      data-requirement-id={r.id}
      className="block w-full rounded-lg border border-line bg-panel p-3 text-left transition-colors hover:border-brand hover:bg-panel-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="line-clamp-2 text-sm leading-snug font-medium text-ink">{r.title}</span>
        <span
          className="shrink-0 text-right text-xs text-brand"
          title="Part-placement confidence: share of weighted keyword matches, not evidence certainty."
          data-testid="car-requirement-part-confidence"
        >
          <span className="block text-sm font-semibold tabular-nums">{a.confidencePercent}%</span>
          <span className="text-[10px] text-muted">part confidence</span>
        </span>
      </span>
      <span className="mt-1.5 block space-y-1 text-xs leading-relaxed text-muted">
        {r.targets.length > 0 ? (
          <>
            {r.targets.slice(0, 2).map((target, index) => (
              <span key={index} className="line-clamp-2" data-testid="car-requirement-target">
                {target.target}
              </span>
            ))}
            {r.targets.length > 2 && (
              <span className="block">+{r.targets.length - 2} more targets</span>
            )}
          </>
        ) : (
          <span className="line-clamp-2">{r.description}</span>
        )}
      </span>
      <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
        {r.priority && (
          <span className="font-semibold text-ink">{PRIORITY_LABELS[r.priority]}</span>
        )}
        <span>{STATUS_LABELS[r.status]}</span>
        {r.inputRank && <span>from {r.inputRank}. Priority</span>}
        {r.confidence && (
          <span
            data-testid="car-requirement-confidence"
            title={r.confidence.signals
              .map((signal) => `${signal.label}: ${Math.round(signal.value * 100)} %`)
              .join("\n")}
          >
            Agent confidence {Math.round(r.confidence.value * 100)}%
          </span>
        )}
        {(r.evidenceLevel === "C" || r.evidenceLevel === "D") && (
          <span className="text-warn">
            {r.evidenceLevel === "D" ? "Assumption-led" : "Weak evidence"}
          </span>
        )}
        {r.conflictingFindingIds.length > 0 && (
          <span className="text-warn">Conflicting evidence</span>
        )}
        {a.confidence === "low" && <span className="text-warn">Check placement</span>}
        <span className="ml-auto text-brand" aria-hidden="true">
          Details →
        </span>
      </span>
    </button>
  );
}
