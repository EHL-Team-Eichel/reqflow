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
    return this.recordSync(eventInput);
  }

  /** Also usable inside one synchronous SQLite transaction, without yielding between writes. */
  recordSync(eventInput: AuditEventInput): AuditEvent {
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
    if (filter?.actorType) {
      conditions.push("json_extract(actor, '$.type') = ?");
      params.push(filter.actorType);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    // Oldest first; equal timestamps keep insertion order (rowid), so the trail is deterministic.
    let sql = `SELECT * FROM audit_events${where} ORDER BY at ASC, rowid ASC`;
    if (filter?.limit && filter.limit > 0) {
      // A limit keeps the NEWEST events, still returned oldest first.
      sql = `SELECT * FROM (
        SELECT rowid AS seq, * FROM audit_events${where} ORDER BY at DESC, rowid DESC LIMIT ?
      ) ORDER BY at ASC, seq ASC`;
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

    return rows.map((row) => {
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
  }
}
