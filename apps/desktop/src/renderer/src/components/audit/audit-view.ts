import { AuditEvent, type Actor } from "@reqflow/core";
import type { AuditFilter } from "@reqflow/core/ipc";
import { z } from "zod";

export type AuditState =
  | { status: "loading" }
  | { status: "ready"; events: AuditEvent[] }
  | { status: "error"; message: string };

export interface AuditViewFilters {
  action: string;
  actorType: string;
  text: string;
}

export function actorLabel(actor: Actor): string {
  switch (actor.type) {
    case "human":
      return `${actor.name} (${actor.userId})${actor.role ? ` / ${actor.role}` : ""}`;
    case "ai":
      return `${actor.component} / ${actor.model}`;
    case "system":
      return actor.component;
  }
}

/** Strings are verbatim; missing values remain distinct from JSON null. */
export function formatAuditValue(value: unknown): string {
  if (value === undefined) return "(Absent)";
  if (typeof value === "string") return value;
  try {
    return (
      JSON.stringify(
        value,
        (_key, item: unknown) => (typeof item === "bigint" ? `${item}n` : item),
        2,
      ) ?? "(Value cannot be represented as JSON)"
    );
  } catch {
    return "(Value cannot be represented as JSON: circular or unsupported value)";
  }
}

export function filterAuditEvents(
  events: readonly AuditEvent[],
  filters: AuditViewFilters,
): AuditEvent[] {
  const query = filters.text.trim().toLowerCase();
  return events
    .filter((event) => {
      if (filters.action && event.action !== filters.action) return false;
      if (filters.actorType && event.actor.type !== filters.actorType) return false;
      if (!query) return true;
      return [
        event.id,
        event.at,
        event.action,
        event.entityType,
        event.entityId,
        event.actor.type,
        actorLabel(event.actor),
        event.rationale ?? "",
        event.runId ?? "",
        event.blockId ?? "",
        ...event.changes.flatMap((change) => [
          change.path,
          formatAuditValue(change.before),
          formatAuditValue(change.after),
        ]),
      ].some((text) => text.toLowerCase().includes(query));
    })
    .sort((a, b) => {
      const time = Date.parse(b.at) - Date.parse(a.at);
      return time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
}

/** Cleanup ignores late IPC replies on retry, scope change and unmount. */
export function loadAuditEvents(
  requirementId: string | undefined,
  list: (filter: AuditFilter) => Promise<unknown>,
  publish: (state: AuditState) => void,
): () => void {
  let cancelled = false;
  publish({ status: "loading" });
  void Promise.resolve()
    .then(() => {
      if (cancelled) return;
      return list(
        requirementId !== undefined
          ? { entityId: requirementId, entityType: "requirement", limit: 200 }
          : { limit: 200 },
      );
    })
    .then((value) => {
      if (cancelled) return;
      const events = AuditEvent.array().parse(value);
      if (
        requirementId !== undefined &&
        events.some(
          (event) => event.entityId !== requirementId || event.entityType !== "requirement",
        )
      ) {
        throw new Error("The returned audit events do not match this requirement. Please retry.");
      }
      publish({ status: "ready", events });
    })
    .catch((error: unknown) => {
      if (cancelled) return;
      publish({
        status: "error",
        message:
          error instanceof z.ZodError
            ? "The audit events are incomplete or invalid. Please retry."
            : error instanceof Error
              ? error.message
              : "Could not load audit events. Please retry.",
      });
    });
  return () => {
    cancelled = true;
  };
}
