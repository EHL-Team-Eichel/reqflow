import {
  fixtureAuditEvents,
  fixturePipelineData,
  fixtureRun,
  fixtureWorkflow,
} from "@reqflow/core/fixtures";
import { DEFAULT_SETTINGS } from "@reqflow/core";
import type { DatabaseSync } from "node:sqlite";

export function seedFixturesIfEmpty(db: DatabaseSync): boolean {
  const checkStmt = db.prepare("SELECT COUNT(*) AS count FROM requirements");
  const row = checkStmt.get() as { count: number };
  if (row.count > 0) {
    return false;
  }

  const now = new Date().toISOString();

  // 1. Settings
  const settingsStmt = db.prepare(`
    INSERT INTO settings (id, json, updated_at)
    VALUES ('default', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  settingsStmt.run(JSON.stringify(DEFAULT_SETTINGS), now);

  // 2. Workflow
  const wfGraph = JSON.stringify({
    nodes: fixtureWorkflow.nodes,
    edges: fixtureWorkflow.edges,
  });
  const wfStmt = db.prepare(`
    INSERT INTO workflows (id, version, name, description, scope, graph, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);
  wfStmt.run(
    fixtureWorkflow.id,
    fixtureWorkflow.version,
    fixtureWorkflow.name,
    fixtureWorkflow.description ?? null,
    JSON.stringify(fixtureWorkflow.scope),
    wfGraph,
    fixtureWorkflow.createdAt,
    fixtureWorkflow.updatedAt,
  );

  // 3. Run
  const runStmt = db.prepare(`
    INSERT INTO runs (
      id, workflow_id, workflow_version, status, scope, graph, started_by, started_at, finished_at, error, node_runs
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
    JSON.stringify(fixtureRun.nodeRuns),
  );

  // 4. Pipeline Data: sources, records, findings, themes, requirements
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

  // 5. Audit Events
  const auditStmt = db.prepare(`
    INSERT INTO audit_events (
      id, at, action, entity_type, entity_id, actor, changes, rationale, run_id, node_id
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
      evt.nodeId ?? null,
    );
  }

  return true;
}
