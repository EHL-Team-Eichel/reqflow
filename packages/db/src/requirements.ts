import {
  AuditEvent,
  Finding,
  Requirement,
  type RequirementDetail,
  type RequirementFilter,
  Source,
  SourceRecord,
  type PipelineData,
  type AuditEventInput,
  newId,
} from "@reqflow/core";
import type { DatabaseSync } from "node:sqlite";

export class RequirementConflictError extends Error {
  constructor() {
    super("Requirement changed or was removed; reload before applying this change.");
    this.name = "RequirementConflictError";
  }
}

export class SqliteRequirementRepository {
  constructor(private readonly db: DatabaseSync) {}

  async list(filter?: RequirementFilter): Promise<Requirement[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.runId) {
      conditions.push("r.run_id = ?");
      params.push(filter.runId);
    }
    if (filter?.status && filter.status.length > 0) {
      const placeholders = filter.status.map(() => "?").join(", ");
      conditions.push(`r.status IN (${placeholders})`);
      params.push(...filter.status);
    }
    if (filter?.category && filter.category.length > 0) {
      const placeholders = filter.category.map(() => "?").join(", ");
      conditions.push(`r.category IN (${placeholders})`);
      params.push(...filter.category);
    }
    if (filter?.priority && filter.priority.length > 0) {
      const placeholders = filter.priority.map(() => "?").join(", ");
      conditions.push(`r.priority IN (${placeholders})`);
      params.push(...filter.priority);
    }
    if (filter?.evidenceLevel && filter.evidenceLevel.length > 0) {
      const placeholders = filter.evidenceLevel.map(() => "?").join(", ");
      conditions.push(`r.evidence_level IN (${placeholders})`);
      params.push(...filter.evidenceLevel);
    }

    let sql = `
      SELECT r.json FROM requirements r
      INNER JOIN (
        SELECT id, MAX(version) AS max_v FROM requirements GROUP BY id
      ) m ON r.id = m.id AND r.version = m.max_v
    `;

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += ` ORDER BY r.id ASC`;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{ json: string }>;
    return rows.map((r) => Requirement.parse(JSON.parse(r.json)));
  }

  async get(id: string): Promise<RequirementDetail> {
    const vStmt = this.db.prepare(
      "SELECT json, version FROM requirements WHERE id = ? ORDER BY version ASC",
    );
    const vRows = vStmt.all(id) as Array<{ json: string; version: number }>;

    if (vRows.length === 0) {
      throw new Error(`Requirement not found: ${id}`);
    }

    const versions = vRows.map((r) => Requirement.parse(JSON.parse(r.json)));
    const requirement = versions[versions.length - 1]!;

    const allFindingIds = Array.from(
      new Set([...requirement.findingIds, ...requirement.conflictingFindingIds]),
    );

    let findings: Finding[] = [];
    if (allFindingIds.length > 0) {
      const placeholders = allFindingIds.map(() => "?").join(", ");
      const fStmt = this.db.prepare(`SELECT json FROM findings WHERE id IN (${placeholders})`);
      const fRows = fStmt.all(...allFindingIds) as Array<{ json: string }>;
      findings = fRows.map((r) => Finding.parse(JSON.parse(r.json)));
    }

    const sourceIdSet = new Set<string>(requirement.sourceIds);
    const recordIdSet = new Set<string>();

    for (const f of findings) {
      for (const e of f.evidence) {
        sourceIdSet.add(e.sourceId);
        if (e.recordId) recordIdSet.add(e.recordId);
      }
    }

    let sources: Source[] = [];
    if (sourceIdSet.size > 0) {
      const sIds = Array.from(sourceIdSet);
      const placeholders = sIds.map(() => "?").join(", ");
      const sStmt = this.db.prepare(`SELECT json FROM sources WHERE id IN (${placeholders})`);
      const sRows = sStmt.all(...sIds) as Array<{ json: string }>;
      sources = sRows.map((r) => Source.parse(JSON.parse(r.json)));
    }

    let records: SourceRecord[] = [];
    if (recordIdSet.size > 0) {
      const rIds = Array.from(recordIdSet);
      const placeholders = rIds.map(() => "?").join(", ");
      const rStmt = this.db.prepare(`SELECT json FROM records WHERE id IN (${placeholders})`);
      const rRows = rStmt.all(...rIds) as Array<{ json: string }>;
      records = rRows.map((r) => SourceRecord.parse(JSON.parse(r.json)));
    }

    return {
      requirement,
      findings,
      sources,
      records,
      versions,
    };
  }

  /** The stored findings with these ids, in the order asked for; unknown ids are left out. */
  async findingsByIds(ids: readonly string[]): Promise<Finding[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const placeholders = unique.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT json FROM findings WHERE id IN (${placeholders})`)
      .all(...unique) as Array<{ json: string }>;
    const byId = new Map(
      rows.map((r) => Finding.parse(JSON.parse(r.json))).map((f) => [f.id, f] as const),
    );
    return unique.flatMap((id) => byId.get(id) ?? []);
  }

  /**
   * Deletes every requirement with all its versions and returns the latest version of each.
   * Only what was listed is deleted, so a requirement added meanwhile is never removed unseen.
   */
  async removeAll(): Promise<Requirement[]> {
    const removed = await this.list();
    return this.transaction(() => this.removeChecked(removed));
  }

  /** Synchronous CAS + audit. No facade promises or external work inside the transaction. */
  removeAllWithAudit(expected: Requirement[], events: AuditEventInput[]): Requirement[] {
    for (const req of expected) {
      Requirement.parse(req);
      if (
        !events.some(
          (event) =>
            event.entityType === "requirement" &&
            event.entityId === req.id &&
            event.action === "requirement.deleted",
        )
      )
        throw new Error("Requirement deletion requires an audit event");
    }
    return this.transaction(() => {
      const removed = this.removeChecked(expected);
      for (const event of events) this.insertAudit(event);
      return removed;
    });
  }

  private removeChecked(expected: Requirement[]): Requirement[] {
    const stmt = this.db.prepare(`DELETE FROM requirements WHERE id = ? AND
      (SELECT MAX(version) FROM requirements WHERE id = ?) = ?`);
    for (const req of expected) {
      if (!stmt.run(req.id, req.id, req.version).changes) throw new RequirementConflictError();
    }
    return expected;
  }

  /**
   * Highest sequence number ever used for ids starting with `prefix` ("REQ-F70-EU-"), counting
   * deleted requirements too: they live on in the audit trail, so their ids must not come back.
   */
  async maxSeq(prefix: string): Promise<number> {
    const like = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
    const rows = this.db
      .prepare(
        `SELECT id FROM requirements WHERE id LIKE ? ESCAPE '\\'
         UNION SELECT entity_id AS id FROM audit_events
           WHERE entity_type = 'requirement' AND entity_id LIKE ? ESCAPE '\\'`,
      )
      .all(like, like) as Array<{ id: string }>;
    const seqs = rows
      .map((r) => r.id.slice(prefix.length))
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
    return seqs.length ? Math.max(...seqs) : 0;
  }

  async saveVersion(
    req: Requirement,
    expectedCurrentVersion: number | null = req.version === 1 ? null : req.version - 1,
  ): Promise<Requirement> {
    return this.insertVersion(req, expectedCurrentVersion);
  }

  /** Keeps async saveVersion callers compatible while providing a non-yielding IPC write seam. */
  saveVersionWithAudit(
    req: Requirement,
    expectedCurrentVersion: number | null,
    events: AuditEventInput[],
  ): Requirement {
    if (
      !events.length ||
      events.some((event) => event.entityType !== "requirement" || event.entityId !== req.id)
    )
      throw new Error("Requirement mutation requires matching audit events");
    return this.transaction(() => {
      const saved = this.insertVersion(req, expectedCurrentVersion);
      for (const event of events) this.insertAudit(event);
      return saved;
    });
  }

  private insertVersion(req: Requirement, expectedCurrentVersion: number | null): Requirement {
    const validated = Requirement.parse(req);
    if (
      (expectedCurrentVersion !== null &&
        (!Number.isSafeInteger(expectedCurrentVersion) || expectedCurrentVersion < 1)) ||
      validated.version !== (expectedCurrentVersion ?? 0) + 1
    )
      throw new RequirementConflictError();
    const json = JSON.stringify(validated);

    const stmt = this.db.prepare(`
      INSERT INTO requirements (
        id, version, title, category, status, priority, evidence_level, run_id, json, created_at, updated_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT MAX(version) FROM requirements WHERE id = ?) IS ?
        AND NOT EXISTS (SELECT 1 FROM audit_events WHERE entity_type = 'requirement'
          AND entity_id = ? AND action = 'requirement.deleted')
    `);

    const result = stmt.run(
      validated.id,
      validated.version,
      validated.title,
      validated.category,
      validated.status,
      validated.priority ?? null,
      validated.evidenceLevel,
      validated.runId ?? null,
      json,
      validated.createdAt,
      validated.updatedAt,
      validated.id,
      expectedCurrentVersion,
      validated.id,
    );
    if (!result.changes) throw new RequirementConflictError();
    return validated;
  }

  private transaction<T>(write: () => T): T {
    this.db.exec("SAVEPOINT requirement_mutation");
    try {
      const result = write();
      this.db.exec("RELEASE requirement_mutation");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO requirement_mutation; RELEASE requirement_mutation");
      throw error;
    }
  }

  private insertAudit(input: AuditEventInput): void {
    // Same append-only table/shape as SqliteAuditLogger; deliberately synchronous
    // rather than calling its async facade inside the requirement transaction.
    const event = AuditEvent.parse({
      ...input,
      id: newId("aud"),
      at: new Date().toISOString(),
      changes: input.changes ?? [],
    });
    this.db
      .prepare(
        `INSERT INTO audit_events
      (id, at, action, entity_type, entity_id, actor, changes, rationale, run_id, block_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
  }

  async savePipelineData(data: PipelineData, runId?: string): Promise<void> {
    // Publishing evidence and new requirements must also be all-or-nothing on a
    // version collision. The synchronous body cannot interleave human decisions.
    this.transaction(() => {
      for (const src of data.sources) {
        const stmt = this.db.prepare(`
        INSERT INTO sources (id, run_id, json) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json, run_id = excluded.run_id
      `);
        stmt.run(src.id, runId ?? null, JSON.stringify(src));
      }

      for (const rec of data.records) {
        const stmt = this.db.prepare(`
        INSERT INTO records (id, source_id, run_id, json) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json, run_id = excluded.run_id
      `);
        stmt.run(rec.id, rec.sourceId, runId ?? null, JSON.stringify(rec));
      }

      for (const fnd of data.findings) {
        const stmt = this.db.prepare(`
        INSERT INTO findings (id, run_id, json) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json, run_id = excluded.run_id
      `);
        stmt.run(fnd.id, runId ?? null, JSON.stringify(fnd));
      }

      for (const thm of data.themes) {
        const stmt = this.db.prepare(`
        INSERT INTO themes (id, run_id, json) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json, run_id = excluded.run_id
      `);
        stmt.run(thm.id, runId ?? null, JSON.stringify(thm));
      }

      for (const req of data.requirements) {
        const withRun = runId && !req.runId ? { ...req, runId } : req;
        this.insertVersion(withRun, withRun.version === 1 ? null : withRun.version - 1);
      }
    });
  }
}
