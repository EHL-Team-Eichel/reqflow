import React, { useEffect, useId, useState } from "react";
import { AuditAction, type AuditEvent } from "@reqflow/core";
import { api } from "@/lib/api";
import {
  actorLabel,
  filterAuditEvents,
  formatAuditValue,
  loadAuditEvents,
  type AuditState,
  type AuditViewFilters,
} from "./audit-view";

export interface AuditTimelineProps {
  requirementId?: string;
  refreshKey?: number;
}

export function AuditTimeline(props: AuditTimelineProps) {
  // A scope boundary resets filters and discards all previous-scope UI immediately.
  return (
    <ScopedAuditTimeline
      key={props.requirementId === undefined ? "global" : `requirement:${props.requirementId}`}
      {...props}
    />
  );
}

function ScopedAuditTimeline({ requirementId, refreshKey = 0 }: AuditTimelineProps) {
  const id = useId();
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{
    refreshKey: number;
    retry: number;
    state: AuditState;
  }>();
  const [filters, setFilters] = useState<AuditViewFilters>({ action: "", actorType: "", text: "" });

  useEffect(
    () =>
      loadAuditEvents(
        requirementId,
        (filter) => api.audit.list(filter),
        (state) => setResult({ refreshKey, retry, state }),
      ),
    [requirementId, refreshKey, retry],
  );

  // Do not show a previous result during the render before the new effect starts.
  const state: AuditState =
    result && Object.is(result.refreshKey, refreshKey) && result.retry === retry
      ? result.state
      : { status: "loading" };
  const events = state.status === "ready" ? filterAuditEvents(state.events, filters) : [];
  const control =
    "mt-1 w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-ink focus-visible:outline-2 focus-visible:outline-brand";

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4 text-sm text-ink">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`${id}-title`} className="font-semibold">
            Audit timeline
          </h3>
          <p className="mt-1 break-words text-muted">
            {requirementId !== undefined ? `Requirement: ${requirementId}` : "All entities"}
          </p>
        </div>
        <button
          type="button"
          className="rounded-md border border-line px-3 py-2 focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50"
          disabled={state.status === "loading"}
          onClick={() => setRetry((value) => value + 1)}
        >
          {state.status === "error" ? "Retry" : "Refresh"}
        </button>
      </div>
      <p className="text-xs text-muted">
        Latest up to 200 events for this scope, not the full history. Filters apply only to this
        window. No events does not mean no changes occurred outside this window.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          Action
          <select
            className={control}
            value={filters.action}
            onChange={(event) => setFilters({ ...filters, action: event.target.value })}
          >
            <option value="">All actions</option>
            {AuditAction.options.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </label>
        <label>
          Actor type
          <select
            className={control}
            value={filters.actorType}
            onChange={(event) => setFilters({ ...filters, actorType: event.target.value })}
          >
            <option value="">All actors</option>
            <option value="human">Human</option>
            <option value="ai">AI</option>
            <option value="system">System</option>
          </select>
        </label>
        <label>
          Search events
          <input
            type="search"
            className={control}
            value={filters.text}
            placeholder="Actor, reason, entity or changes"
            onChange={(event) => setFilters({ ...filters, text: event.target.value })}
          />
        </label>
      </div>
      <div aria-busy={state.status === "loading"}>
        {state.status === "loading" && <p role="status">Loading or refreshing audit events...</p>}
        {state.status === "error" && (
          <p role="alert" className="whitespace-pre-wrap text-danger">
            {state.message}
          </p>
        )}
        {state.status === "ready" && (
          <>
            <p role="status" className="mb-3 text-xs text-muted">
              {events.length} of {state.events.length} loaded events shown, newest first.
            </p>
            {state.events.length === 0 ? (
              <p>No audit events returned in this window.</p>
            ) : events.length === 0 ? (
              <p>No events match these filters in the loaded window.</p>
            ) : (
              <ol aria-label="Audit events, newest first" className="space-y-3">
                {events.map((event) => (
                  <AuditEventItem key={event.id} event={event} />
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function AuditEventItem({ event }: { event: AuditEvent }) {
  return (
    <li className="min-w-0 rounded-lg border border-line bg-panel p-4">
      <div className="flex flex-wrap justify-between gap-2">
        <span className="break-all font-medium">{event.action}</span>
        <time dateTime={event.at} className="text-xs text-muted">
          {event.at}
        </time>
      </div>
      <p className="mt-2 break-words">
        {event.actor.type}: {actorLabel(event.actor)}
      </p>
      <p className="mt-1 break-all text-xs text-muted">
        {event.entityType}: {event.entityId} / Event: {event.id}
      </p>
      {(event.runId || event.blockId) && (
        <p className="mt-1 break-all text-xs text-muted">
          {event.runId && `Run: ${event.runId}`}
          {event.blockId && ` Block: ${event.blockId}`}
        </p>
      )}
      <p className="mt-3 font-medium">Reason</p>
      <p className="whitespace-pre-wrap break-words">
        {event.rationale ?? "No rationale recorded."}
      </p>
      {event.changes.length === 0 ? (
        <p className="mt-3 text-xs text-muted">No field diffs recorded for this event.</p>
      ) : (
        <details className="mt-3">
          <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-brand">
            Field changes ({event.changes.length})
          </summary>
          <ul className="mt-3 space-y-3">
            {event.changes.map((change, index) => (
              <li key={index} className="rounded-md bg-panel-2 p-3">
                <p className="break-all font-mono text-xs">{change.path}</p>
                <dl className="mt-2 grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="text-xs font-medium text-muted">Before</dt>
                    <dd>
                      <pre className="whitespace-pre-wrap break-words text-xs">
                        {formatAuditValue(change.before)}
                      </pre>
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs font-medium text-muted">After</dt>
                    <dd>
                      <pre className="whitespace-pre-wrap break-words text-xs">
                        {formatAuditValue(change.after)}
                      </pre>
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}
