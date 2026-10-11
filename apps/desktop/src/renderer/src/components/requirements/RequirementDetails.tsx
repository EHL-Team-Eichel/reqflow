import React, { type ReactNode } from "react";
import {
  CATEGORY_LABELS,
  SCORE_FACTOR_LABELS,
  type Actor,
  type Finding,
  type Source,
} from "@reqflow/core";
import type { RequirementDetail } from "@reqflow/core/ipc";
import { classifyRequirement, label } from "../car/classify";
import { EVIDENCE_LABELS, PRIORITY_LABELS, STATUS_LABELS } from "./labels";

/** Only http(s) sources are navigable; uploads and other URIs remain visible as identifiers. */
export function sourceLink(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function actorLabel(actor: Actor): string {
  return actor.type === "human"
    ? `${actor.name}${actor.role ? ` · ${actor.role}` : ""}`
    : actor.type === "ai"
      ? `${actor.component} · ${actor.model}`
      : actor.component;
}

export function RequirementDetails({ detail }: { detail: RequirementDetail }) {
  const { requirement: r } = detail;
  const a = classifyRequirement(r);
  return (
    <div className="space-y-5 text-sm" data-testid="car-requirement-full-details">
      <p className="leading-relaxed whitespace-pre-wrap">{r.description}</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg bg-panel-2 p-4 sm:grid-cols-3">
        <Fact name="Priority">{r.priority ? PRIORITY_LABELS[r.priority] : "Not prioritized"}</Fact>
        <Fact name="Status">{STATUS_LABELS[r.status]}</Fact>
        <Fact name="Priority score">{r.score ? `${r.score.total} / 100` : "Not scored"}</Fact>
        <Fact name="Evidence level">
          {r.evidenceLevel} · {EVIDENCE_LABELS[r.evidenceLevel]}
        </Fact>
        <Fact name="Category">{CATEGORY_LABELS[r.category]}</Fact>
        <Fact name="Part confidence">
          {a.confidencePercent}% · {a.confidence} keyword confidence
        </Fact>
      </dl>

      <section aria-labelledby="requirement-targets-title">
        <h3 id="requirement-targets-title" className="font-semibold">
          Targets & acceptance criteria
        </h3>
        {r.targets.length === 0 ? (
          <p className="mt-2 text-muted">No measurable targets defined yet.</p>
        ) : (
          <ul className="mt-2 space-y-3">
            {r.targets.map((target, i) => (
              <li key={i} className="rounded-lg border border-line p-3">
                <h4 className="font-medium">{target.metric}</h4>
                <p className="mt-1 whitespace-pre-wrap">{target.target}</p>
                <p className="mt-1 text-xs text-muted whitespace-pre-wrap">
                  Acceptance: {target.acceptance}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Section title="Prioritization & rationale" open>
        <p className="whitespace-pre-wrap">
          {r.priorityRationale ?? "No priority rationale recorded yet."}
        </p>
        {r.kano && <p className="mt-2 text-muted">Kano: {r.kano}</p>}
        {r.score && (
          <>
            <p className="mt-2 text-xs text-muted">
              Suggested priority: {PRIORITY_LABELS[r.score.suggestedPriority]} · Method:{" "}
              {r.score.method} · {r.score.scoredAt}
            </p>
            <p className="mt-1 text-xs text-muted">
              Score = 100 × Σ(weight × value) / (5 × Σ weight)
            </p>
            <ul className="mt-3 space-y-2">
              {Object.entries(r.score.factors).map(([factor, score]) => (
                <li key={factor} className="rounded-md bg-panel-2 p-3">
                  <div className="flex justify-between gap-4">
                    <span className="font-medium">
                      {SCORE_FACTOR_LABELS[factor as keyof typeof SCORE_FACTOR_LABELS]}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      {score.value} / 5 × weight {score.weight}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{score.note}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title={`Evidence & sources (${detail.sources.length})`} open>
        <p className="mb-3 text-xs text-muted">
          Evidence {r.evidenceLevel}: {EVIDENCE_LABELS[r.evidenceLevel]}
        </p>
        <FindingList title="Supporting findings" ids={r.findingIds} detail={detail} />
        <div className="mt-4">
          <FindingList title="Conflicting findings" ids={r.conflictingFindingIds} detail={detail} />
        </div>
        <h4 className="mt-4 font-medium">Source directory</h4>
        {detail.sources.length === 0 && (
          <p className="mt-2 text-muted">No source details available.</p>
        )}
        <ul className="mt-2 space-y-2">
          {detail.sources.map((source) => (
            <li
              key={source.id}
              id={`requirement-${source.id}`}
              className="rounded-lg bg-panel-2 p-3"
            >
              <SourceInfo source={source} />
            </li>
          ))}
          {r.sourceIds
            .filter((id) => !detail.sources.some((source) => source.id === id))
            .map((id) => (
              <li key={id} className="text-warn">
                Source unavailable: {id}
              </li>
            ))}
        </ul>
      </Section>

      <Section title="Assumptions & uncertainties" open>
        <TextList title="Assumptions" items={r.assumptions} />
        <div className="mt-3">
          <TextList title="Uncertainties" items={r.uncertainties} />
        </div>
      </Section>

      <Section title="Car-part classification" open>
        <p className="font-medium">
          {label(a.partId)} · {a.confidencePercent}% part confidence
        </p>
        <p className="mt-2 text-muted" data-testid="car-classifier-reason">
          {a.reason}
        </p>
        <p className="mt-2 text-xs text-muted">
          This percentage is the selected part's share of all weighted keyword matches (title × 3,
          description × 2, targets × 1). It is a placement heuristic, not a calibrated probability,
          evidence certainty or priority score. No keyword matches means 0%; category-only placement
          still needs review.
        </p>
        {a.alternatives.length > 0 && (
          <p className="mt-2 text-muted">
            Could also be: {a.alternatives.map((x) => label(x.partId)).join(", ")}.
          </p>
        )}
      </Section>

      <Section title={`Context & version history (${detail.versions.length})`}>
        <dl className="grid grid-cols-2 gap-3">
          <Fact name="Vehicle">
            {r.scope.vehicleLine}
            {r.scope.derivative ? ` · ${r.scope.derivative}` : ""}
          </Fact>
          <Fact name="Market / horizon">
            {r.scope.market} · {r.scope.horizonYears} years
          </Fact>
          <Fact name="Created by">{actorLabel(r.createdBy)}</Fact>
          <Fact name="Created">{r.createdAt}</Fact>
          <Fact name="Updated">{r.updatedAt}</Fact>
          <Fact name="Flow run">{r.runId ?? "Not linked to a run"}</Fact>
        </dl>
        <ul className="mt-4 space-y-2">
          {detail.versions.map((version) => (
            <li key={version.version}>
              <details className="rounded-lg bg-panel-2 p-3">
                <summary className="cursor-pointer font-medium">
                  Version {version.version} · {STATUS_LABELS[version.status]} · {version.updatedAt}
                </summary>
                <p className="mt-2">{version.title}</p>
                <p className="mt-1 text-muted whitespace-pre-wrap">{version.description}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted">
                    Full version snapshot
                  </summary>
                  <pre className="mt-2 overflow-x-auto text-xs">
                    {JSON.stringify(version, null, 2)}
                  </pre>
                </details>
              </details>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{name}</dt>
      <dd className="mt-1 break-words">{children}</dd>
    </div>
  );
}

function Section({
  title,
  open,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="rounded-lg border border-line p-4">
      <summary className="cursor-pointer font-semibold focus-visible:outline-brand">
        {title}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function TextList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4 className="font-medium">{title}</h4>
      {items.length > 0 ? (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
          {items.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-muted">None recorded.</p>
      )}
    </div>
  );
}

function FindingList({
  title,
  ids,
  detail,
}: {
  title: string;
  ids: string[];
  detail: RequirementDetail;
}) {
  return (
    <div>
      <h4 className="font-medium">{title}</h4>
      {ids.length === 0 && <p className="mt-1 text-muted">None recorded.</p>}
      <div className="mt-2 space-y-2">
        {ids.map((id) => {
          const finding = detail.findings.find((item) => item.id === id);
          return finding ? (
            <FindingEvidence key={id} finding={finding} detail={detail} />
          ) : (
            <p key={id} className="text-warn">
              Finding unavailable: {id}
            </p>
          );
        })}
      </div>
    </div>
  );
}

function FindingEvidence({ finding, detail }: { finding: Finding; detail: RequirementDetail }) {
  return (
    <details className="rounded-lg bg-panel-2 p-3">
      <summary className="cursor-pointer">{finding.statement}</summary>
      <p className="mt-2 text-xs text-muted">
        {finding.kind.replaceAll("_", " ")} · {finding.mentions} mentions ·{" "}
        {Math.round(finding.confidence * 100)}% extraction confidence
        {finding.sentiment !== undefined && ` · sentiment ${finding.sentiment}`}
        {finding.markets.length > 0 && ` · ${finding.markets.join(", ")}`}
      </p>
      {finding.evidence.map((evidence, i) => {
        const source = detail.sources.find((item) => item.id === evidence.sourceId);
        const record = detail.records.find(
          (item) => item.id === evidence.recordId && item.sourceId === evidence.sourceId,
        );
        return (
          <div key={i} className="mt-3 border-l-2 border-brand pl-3">
            <blockquote className="whitespace-pre-wrap" data-testid="car-evidence-excerpt">
              {evidence.excerpt}
            </blockquote>
            <p className="mt-1 text-xs text-muted">
              {evidence.locator ?? record?.locator ?? "No locator recorded"}
            </p>
            {source ? (
              <a
                href={`#requirement-${source.id}`}
                onClick={(event) => {
                  // Do not change the app's hash-router route when jumping inside the dialog.
                  event.preventDefault();
                  document
                    .getElementById(`requirement-${source.id}`)
                    ?.scrollIntoView({ block: "center" });
                }}
                className="mt-1 inline-block text-xs text-brand underline"
              >
                {source.title}
              </a>
            ) : (
              <p className="text-xs text-warn">Source unavailable: {evidence.sourceId}</p>
            )}
            {record && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-muted">
                  Original record · {record.id}
                </summary>
                <p className="mt-2 whitespace-pre-wrap">{record.text}</p>
                {record.fields && (
                  <pre className="mt-2 overflow-x-auto">
                    {JSON.stringify(record.fields, null, 2)}
                  </pre>
                )}
              </details>
            )}
            {evidence.recordId && !record && (
              <p className="mt-1 text-xs text-warn">
                Original record unavailable: {evidence.recordId}
              </p>
            )}
          </div>
        );
      })}
    </details>
  );
}

function SourceInfo({ source }: { source: Source }) {
  const link = sourceLink(source.uri);
  return (
    <>
      <p className="font-medium">{source.title}</p>
      <p className="mt-1 text-xs text-muted">
        {source.kind.replaceAll("_", " ")} · {source.origin.replaceAll("_", " ")} ·{" "}
        {source.reliability} reliability{source.publisher && ` · ${source.publisher}`}
      </p>
      <p className="mt-1 text-xs text-muted">
        {source.publishedAt ? `Published: ${source.publishedAt} · ` : ""}Retrieved:{" "}
        {source.retrievedAt}
      </p>
      {(source.market || source.vehicleLine) && (
        <p className="mt-1 text-xs text-muted">
          {[source.market, source.vehicleLine].filter(Boolean).join(" · ")}
        </p>
      )}
      <p className="mt-1 font-mono text-[11px] text-muted">{source.id}</p>
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block break-all text-xs text-brand underline"
        >
          Open source ↗
        </a>
      ) : (
        source.uri && <p className="mt-1 break-all text-xs text-muted">{source.uri}</p>
      )}
    </>
  );
}
