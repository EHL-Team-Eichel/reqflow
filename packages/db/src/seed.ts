import { fixtureAuditEvents, fixturePipelineData, fixtureRun } from "@reqflow/core/fixtures";
import type { DatabaseSync } from "node:sqlite";

/**
 * TESTS ONLY: fills an empty database with the synthetic F70 fixtures. The app never calls this;
 * it removes these rows instead (`removeDemoData`), so demo data never mixes with real results.
 */
export function seedFixtures(db: DatabaseSync): boolean {
  const checkStmt = db.prepare("SELECT COUNT(*) AS count FROM requirements");
  const row = checkStmt.get() as { count: number };
  if (row.count > 0) {
    return false;
  }

  // 1. Run
  const runStmt = db.prepare(`
    INSERT INTO runs (
      id, workflow_id, workflow_version, status, scope, graph, started_by, started_at, finished_at, error, block_runs
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  runStmt.run(
    fixtureRun.id,
    fixtureRun.workflowId,
    fixtureRun.workflowVersion,
    fixtureRun.status,
    JSON.stringify(fixtureRun.scope),
    JSON.stringify(fixtureRun.graph),
    JSON.stringify(fixtureRun.startedBy),
    fixtureRun.startedAt,
    fixtureRun.finishedAt ?? null,
    fixtureRun.error ?? null,
    JSON.stringify(fixtureRun.blockRuns),
  );

  // 2. Sources, records, findings, themes, requirements
  const srcStmt = db.prepare(`
    INSERT INTO sources (id, run_id, json) VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  for (const src of fixturePipelineData.sources) {
    srcStmt.run(src.id, fixtureRun.id, JSON.stringify(src));
  }

  const recStmt = db.prepare(`
    INSERT INTO records (id, source_id, run_id, json) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  for (const rec of fixturePipelineData.records) {
    recStmt.run(rec.id, rec.sourceId, fixtureRun.id, JSON.stringify(rec));
  }

  const fndStmt = db.prepare(`
    INSERT INTO findings (id, run_id, json) VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  for (const fnd of fixturePipelineData.findings) {
    fndStmt.run(fnd.id, fixtureRun.id, JSON.stringify(fnd));
  }

  const thmStmt = db.prepare(`
    INSERT INTO themes (id, run_id, json) VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  for (const thm of fixturePipelineData.themes) {
    thmStmt.run(thm.id, fixtureRun.id, JSON.stringify(thm));
  }

  const reqStmt = db.prepare(`
    INSERT INTO requirements (
      id, version, title, category, status, priority, evidence_level, run_id, json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id, version) DO NOTHING
  `);
  for (const req of fixturePipelineData.requirements) {
    reqStmt.run(
      req.id,
      req.version,
      req.title,
      req.category,
      req.status,
      req.priority ?? null,
      req.evidenceLevel,
      req.runId ?? fixtureRun.id,
      JSON.stringify(req),
      req.createdAt,
      req.updatedAt,
    );
  }

  // 3. Audit Events
  const auditStmt = db.prepare(`
    INSERT INTO audit_events (
      id, at, action, entity_type, entity_id, actor, changes, rationale, run_id, block_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  for (const evt of fixtureAuditEvents) {
    auditStmt.run(
      evt.id,
      evt.at,
      evt.action,
      evt.entityType,
      evt.entityId,
      JSON.stringify(evt.actor),
      JSON.stringify(evt.changes),
      evt.rationale ?? null,
      evt.runId ?? null,
      evt.blockId ?? null,
    );
  }

  return true;
}
