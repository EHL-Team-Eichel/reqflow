import {
  fixtureAuditEvents,
  fixturePipelineData,
  fixtureRun,
  fixtureWorkflow,
} from "@reqflow/core/fixtures";
import { DEFAULT_SETTINGS } from "@reqflow/core";
import type { DatabaseSync } from "node:sqlite";
import { SqliteAuditLogger } from "./audit";
import { SqliteRequirementRepository } from "./requirements";
import { SqliteRunRepository } from "./runs";
import { SqliteSettingsRepository } from "./settings";
import { SqliteWorkflowRepository } from "./workflows";

export async function seedFixturesIfEmpty(db: DatabaseSync): Promise<boolean> {
  const checkStmt = db.prepare("SELECT COUNT(*) AS count FROM requirements");
  const row = checkStmt.get() as { count: number };
  if (row.count > 0) {
    return false;
  }

  const settingsRepo = new SqliteSettingsRepository(db);
  const workflowRepo = new SqliteWorkflowRepository(db);
  const runRepo = new SqliteRunRepository(db);
  const reqRepo = new SqliteRequirementRepository(db);

  await settingsRepo.save(DEFAULT_SETTINGS);
  await workflowRepo.save({
    id: fixtureWorkflow.id,
    name: fixtureWorkflow.name,
    description: fixtureWorkflow.description,
    scope: fixtureWorkflow.scope,
    nodes: fixtureWorkflow.nodes,
    edges: fixtureWorkflow.edges,
  });

  await runRepo.create(fixtureRun);
  await reqRepo.savePipelineData(fixturePipelineData, fixtureRun.id);

  // Seed fixture audit events
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
