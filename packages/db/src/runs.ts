import { type PipelineData, WorkflowRun } from "@reqflow/core";
import type { DatabaseSync } from "node:sqlite";

export class SqliteRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  async create(run: WorkflowRun): Promise<WorkflowRun> {
    const validated = WorkflowRun.parse(run);
    const stmt = this.db.prepare(`
      INSERT INTO runs (
        id, workflow_id, workflow_version, status, scope, graph, started_by, started_at, finished_at, error, node_runs
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      validated.id,
      validated.workflowId,
      validated.workflowVersion,
      validated.status,
      JSON.stringify(validated.scope),
      JSON.stringify(validated.graph),
      JSON.stringify(validated.startedBy),
      validated.startedAt,
      validated.finishedAt ?? null,
      validated.error ?? null,
      JSON.stringify(validated.nodeRuns),
    );

    return validated;
  }

  async get(id: string): Promise<WorkflowRun> {
    const stmt = this.db.prepare(`
      SELECT id, workflow_id, workflow_version, status, scope, graph, started_by, started_at, finished_at, error, node_runs
      FROM runs WHERE id = ?
    `);
    const r = stmt.get(id) as
      | {
          id: string;
          workflow_id: string;
          workflow_version: number;
          status: string;
          scope: string;
          graph: string;
          started_by: string;
          started_at: string;
          finished_at: string | null;
          error: string | null;
          node_runs: string;
        }
      | undefined;

    if (!r) {
      throw new Error(`Run not found: ${id}`);
    }

    return WorkflowRun.parse({
      id: r.id,
      workflowId: r.workflow_id,
      workflowVersion: r.workflow_version,
      status: r.status,
      scope: JSON.parse(r.scope),
      graph: JSON.parse(r.graph),
      startedBy: JSON.parse(r.started_by),
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
      error: r.error ?? undefined,
      nodeRuns: JSON.parse(r.node_runs),
    });
  }

  async list(workflowId?: string): Promise<WorkflowRun[]> {
    let sql = `
      SELECT id, workflow_id, workflow_version, status, scope, graph, started_by, started_at, finished_at, error, node_runs
      FROM runs
    `;
    const params: string[] = [];
    if (workflowId) {
      sql += ` WHERE workflow_id = ?`;
      params.push(workflowId);
    }
    sql += ` ORDER BY started_at DESC`;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      id: string;
      workflow_id: string;
      workflow_version: number;
      status: string;
      scope: string;
      graph: string;
      started_by: string;
      started_at: string;
      finished_at: string | null;
      error: string | null;
      node_runs: string;
    }>;

    return rows.map((r) =>
      WorkflowRun.parse({
        id: r.id,
        workflowId: r.workflow_id,
        workflowVersion: r.workflow_version,
        status: r.status,
        scope: JSON.parse(r.scope),
        graph: JSON.parse(r.graph),
        startedBy: JSON.parse(r.started_by),
        startedAt: r.started_at,
        finishedAt: r.finished_at ?? undefined,
        error: r.error ?? undefined,
        nodeRuns: JSON.parse(r.node_runs),
      }),
    );
  }

  async update(run: WorkflowRun): Promise<WorkflowRun> {
    const validated = WorkflowRun.parse(run);
    const stmt = this.db.prepare(`
      UPDATE runs SET
        status = ?,
        finished_at = ?,
        error = ?,
        node_runs = ?
      WHERE id = ?
    `);

    stmt.run(
      validated.status,
      validated.finishedAt ?? null,
      validated.error ?? null,
      JSON.stringify(validated.nodeRuns),
      validated.id,
    );

    return validated;
  }

  async saveNodeOutput(runId: string, nodeId: string, data: PipelineData): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO node_outputs (run_id, node_id, data)
      VALUES (?, ?, ?)
      ON CONFLICT(run_id, node_id) DO UPDATE SET data = excluded.data
    `);
    stmt.run(runId, nodeId, JSON.stringify(data));
  }

  async getNodeOutput(runId: string, nodeId: string): Promise<PipelineData | null> {
    const stmt = this.db.prepare("SELECT data FROM node_outputs WHERE run_id = ? AND node_id = ?");
    const row = stmt.get(runId, nodeId) as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as PipelineData;
  }
}
