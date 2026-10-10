import React from "react";
import type { PipelineData, SplitterSignal } from "@reqflow/core";

/** Exact saved excerpts and originals; no network lookup or regenerated evidence. */
export function SplitterEvidence({
  evidence,
  data,
  loading,
  error,
}: {
  evidence: SplitterSignal["evidence"];
  data: PipelineData | null;
  loading: boolean;
  error: string | null;
}) {
  const source = data?.sources.find((item) => item.id === evidence.sourceId);
  const record = data?.records.find(
    (item) => item.id === evidence.recordId && item.sourceId === evidence.sourceId,
  );
  return (
    <div className="space-y-3 rounded-lg border border-line bg-panel p-3 text-xs">
      <div className="flex flex-wrap gap-2 text-muted">
        <span className="rounded bg-panel-2 px-2 py-1 font-medium text-ink">Verbatim evidence</span>
        <span>{source?.title ?? evidence.sourceId}</span>
        <span>{evidence.recordId}</span>
        <span>Excerpt locator: {evidence.locator ?? "Not reported"}</span>
      </div>
      <blockquote className="whitespace-pre-wrap break-words border-l-2 border-brand pl-3 text-sm leading-relaxed text-ink">
        {evidence.excerpt}
      </blockquote>
      {loading && (
        <p role="status" className="text-muted">
          Loading original fields from the saved run…
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger">
          Original data unavailable: {error}. The excerpt above is the stored report excerpt.
        </p>
      )}
      {data && !source && (
        <p className="text-warn">
          Source metadata is missing from the saved outputs. No source URI has been invented.
        </p>
      )}
      {source && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
          <dt>Source URI</dt>
          <dd className="break-all text-ink">{source.uri ?? "Not reported"}</dd>
          <dt>Provenance</dt>
          <dd>
            {source.kind} · {source.origin} · reliability {source.reliability}
          </dd>
          <dt>Publisher</dt>
          <dd>{source.publisher ?? "Not reported"}</dd>
          <dt>Retrieved</dt>
          <dd>{source.retrievedAt}</dd>
          <dt>Published</dt>
          <dd>{source.publishedAt ?? "Not reported"}</dd>
        </dl>
      )}
      {data && !record && (
        <p className="text-warn">
          Original record is missing from the saved outputs. Only the stored excerpt is available.
        </p>
      )}
      {record && (
        <details className="rounded border border-line bg-panel-2 p-3">
          <summary className="cursor-pointer font-medium text-ink">
            Original record & fields · {record.locator ?? "locator not reported"}
          </summary>
          <p className="mt-2 text-muted">
            {record.id} · {record.sourceId} · language {record.language ?? "not reported"} · market{" "}
            {record.market ?? "not reported"}
          </p>
          <pre className="my-3 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-ink">
            {record.text}
          </pre>
          {record.fields ? (
            <dl className="grid grid-cols-[minmax(100px,1fr)_minmax(0,2fr)] gap-x-3 gap-y-2">
              {Object.entries(record.fields).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="break-words font-medium text-muted">{key}</dt>
                  <dd className="whitespace-pre-wrap break-words text-ink">
                    {typeof value === "string" ? value : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-muted">No original structured fields stored.</p>
          )}
        </details>
      )}
    </div>
  );
}
