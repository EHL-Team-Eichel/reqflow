import {
  Finding,
  Requirement,
  type RequirementDetail,
  type RequirementFilter,
  Source,
  SourceRecord,
  type PipelineData,
  PipelineData as PipelineDataSchema,
  ProductScope,
} from "@reqflow/core";
import type { DatabaseSync } from "node:sqlite";

export class SqliteRequirementRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Reserve before generation/publication; gaps after cancellation are intentional, ids are never reused. */
  reserveSequences(scope: ProductScope, count = 1): number {
    const valid = ProductScope.parse(scope);
    if (!Number.isInteger(count) || count < 1)
      throw new Error("Requirement sequence count must be a positive integer");
    const prefix = `REQ-${valid.vehicleCode}-${valid.market}-`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const saved = this.db
        .prepare("SELECT next_seq FROM requirement_sequences WHERE scope_key = ?")
        .get(prefix) as { next_seq: number } | undefined;
      const existing = this.db
        .prepare(
          "SELECT COALESCE(MAX(CAST(substr(id, ?) AS INTEGER)), 0) AS max_seq FROM requirements WHERE id LIKE ?",
        )
        .get(prefix.length + 1, `${prefix}%`) as { max_seq: number };
      const first = Math.max(saved?.next_seq ?? 1, existing.max_seq + 1);
      this.db
        .prepare(
          "INSERT INTO requirement_sequences(scope_key, next_seq) VALUES (?, ?) ON CONFLICT(scope_key) DO UPDATE SET next_seq = excluded.next_seq",
        )
        .run(prefix, first + count);
      this.db.exec("COMMIT");
      return first;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

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

  async saveVersion(req: Requirement): Promise<Requirement> {
    return this.writeVersion(req);
  }

  private writeVersion(req: Requirement): Requirement {
    const validated = Requirement.parse(req);
    const json = JSON.stringify(validated);

    const stmt = this.db.prepare(`
      INSERT INTO requirements (
        id, version, title, category, status, priority, evidence_level, run_id, json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, version) DO UPDATE SET
        title = excluded.title,
        category = excluded.category,
        status = excluded.status,
        priority = excluded.priority,
        evidence_level = excluded.evidence_level,
        run_id = excluded.run_id,
        json = excluded.json,
        updated_at = excluded.updated_at
    `);

    stmt.run(
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
    );

    return validated;
  }

  async savePipelineData(data: PipelineData, runId?: string): Promise<void> {
    data = PipelineDataSchema.parse(data);
    this.db.exec("BEGIN IMMEDIATE");
    try {
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
        this.writeVersion(withRun);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
