import { z } from "zod";

/** Who or what initiated a change. Every audit event names one. */
export const Actor = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ai"),
    component: z.string().min(1), // node type, e.g. "requirements.derive"
    model: z.string().min(1), // exact model id, or "deterministic" for rule-based steps
  }),
  z.object({
    type: z.literal("human"),
    userId: z.string().min(1),
    name: z.string().min(1),
    role: z.string().optional(), // "Product Manager"
  }),
  z.object({
    type: z.literal("system"),
    component: z.string().min(1), // "engine", "api", …
  }),
]);
export type Actor = z.infer<typeof Actor>;

export const AuditAction = z.enum([
  "source.ingested",
  "finding.extracted",
  "finding.merged",
  "finding.excluded", // scope filter dropped it (rationale = reason)
  "requirement.proposed",
  "requirement.edited",
  "requirement.scored",
  "requirement.prioritized",
  "requirement.evidence_linked",
  "requirement.evidence_unlinked",
  "requirement.merged",
  "requirement.status_changed",
  "requirement.challenged",
  "requirement.challenge_answered",
  "requirement.viewed", // access event
  "workflow.saved",
  "run.started",
  "run.paused",
  "run.resumed",
  "run.completed",
  "run.failed",
  "settings.changed",
  "export.created",
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditEntityType = z.enum([
  "source",
  "finding",
  "requirement",
  "workflow",
  "run",
  "settings",
  "export",
]);
export type AuditEntityType = z.infer<typeof AuditEntityType>;

export const FieldChange = z.object({
  path: z.string().min(1), // dot path into the entity, e.g. "score.total", "status"
  before: z.unknown(),
  after: z.unknown(),
});
export type FieldChange = z.infer<typeof FieldChange>;

/**
 * Append-only record. Never updated or deleted.
 * Human decisions MUST carry a `rationale` (enforced by the API, see RequirementDecision).
 */
export const AuditEvent = z.object({
  id: z.string().startsWith("aud_"),
  at: z.iso.datetime(),
  actor: Actor,
  action: AuditAction,
  entityType: AuditEntityType,
  entityId: z.string().min(1),
  changes: z.array(FieldChange),
  rationale: z.string().optional(),
  runId: z.string().startsWith("run_").optional(),
  nodeId: z.string().optional(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/** What callers pass to `AuditLogger.record`; the logger assigns `id` and `at`. */
export type AuditEventInput = Omit<AuditEvent, "id" | "at" | "changes"> & {
  changes?: FieldChange[];
};
