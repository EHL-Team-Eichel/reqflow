import {
  AuditEvent,
  type AuditEventInput,
  type AuditFilter,
  type AuditLogger,
  newId,
} from "@reqflow/core";
import type { DatabaseSync } from "node:sqlite";

export class SqliteAuditLogger implements AuditLogger {
  constructor(private readonly db: DatabaseSync) {}

  async record(eventInput: AuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: newId("aud"),
      at: new Date().toISOString(),
      actor: eventInput.actor,
      action: eventInput.action,
      entityType: eventInput.entityType,
      entityId: eventInput.entityId,
      changes: eventInput.changes ?? [],
      rationale: eventInput.rationale,
      runId: eventInput.runId,
      blockId: eventInput.blockId,
    };

    AuditEvent.parse(event);

    const stmt = this.db.prepare(`
      INSERT INTO audit_events (
        id, at, action, entity_type, entity_id, actor, changes, rationale, run_id, block_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.id,
      event.at,
      event.action,
      event.entityType,
      event.entityId,
      JSON.stringify(event.actor),
      JSON.stringify(event.changes),
      event.rationale ?? null,
      event.runId ?? null,
      event.blockId ?? null,
    );

    return event;
  }

  async list(filter?: AuditFilter): Promise<AuditEvent[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.entityId) {
      conditions.push("entity_id = ?");
      params.push(filter.entityId);
    }
    if (filter?.entityType) {
      conditions.push("entity_type = ?");
      params.push(filter.entityType);
    }
    if (filter?.action) {
      conditions.push("action = ?");
      params.push(filter.action);
    }
    if (filter?.runId) {
      conditions.push("run_id = ?");
      params.push(filter.runId);
    }

    let sql = `SELECT * FROM audit_events`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += ` ORDER BY at ASC`;

    if (filter?.limit && filter.limit > 0) {
      sql += ` LIMIT ?`;
      params.push(filter.limit);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      id: string;
      at: string;
      action: string;
      entity_type: string;
      entity_id: string;
      actor: string;
      changes: string;
      rationale: string | null;
      run_id: string | null;
      block_id: string | null;
    }>;

    const events = rows.map((row) => {
      const parsedActor = JSON.parse(row.actor);
      const parsedChanges = JSON.parse(row.changes);
      return AuditEvent.parse({
        id: row.id,
        at: row.at,
        actor: parsedActor,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        changes: parsedChanges,
        rationale: row.rationale ?? undefined,
        runId: row.run_id ?? undefined,
        blockId: row.block_id ?? undefined,
      });
    });

    if (filter?.actorType) {
      return events.filter((e) => e.actor.type === filter.actorType);
    }

    return events;
  }
}
