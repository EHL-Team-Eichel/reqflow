import { type AuditEventInput, PipelineData, WorkflowRun } from "@reqflow/core";
import type { DatabaseSync } from "node:sqlite";
import { SqliteAuditLogger } from "./audit";

export class SqliteRunRepository {
  constructor(private readonly db: DatabaseSync) {}

  async create(run: WorkflowRun): Promise<WorkflowRun> {
    const validated = WorkflowRun.parse(run);
    const stmt = this.db.prepare(`
      INSERT INTO runs (
        id, workflow_id, workflow_version, status, scope, graph, started_by, started_at, finished_at, error, block_runs
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
      JSON.stringify(validated.blockRuns),
    );

    return validated;
  }

  async get(id: string): Promise<WorkflowRun> {
    const stmt = this.db.prepare(`
      SELECT id, workflow_id, workflow_version, status, scope, graph, started_by, started_at, finished_at, error, block_runs
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
          block_runs: string;
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
      blockRuns: JSON.parse(r.block_runs),
    });
  }

  async list(workflowId?: string): Promise<WorkflowRun[]> {
    let sql = `
      SELECT id, workflow_id, workflow_version, status, scope, graph, started_by, started_at, finished_at, error, block_runs
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
      block_runs: string;
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
        blockRuns: JSON.parse(r.block_runs),
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
        block_runs = ?
      WHERE id = ?
    `);

    stmt.run(
      validated.status,
      validated.finishedAt ?? null,
      validated.error ?? null,
      JSON.stringify(validated.blockRuns),
      validated.id,
    );

    return validated;
  }

  async saveBlockOutput(
    runId: string,
    blockId: string,
    outputs: Record<string, PipelineData>,
  ): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO block_outputs (run_id, block_id, outputs)
      VALUES (?, ?, ?)
      ON CONFLICT(run_id, block_id) DO UPDATE SET outputs = excluded.outputs
    `);
    stmt.run(runId, blockId, JSON.stringify(outputs));
  }

  async getBlockOutput(
    runId: string,
    blockId: string,
  ): Promise<Record<string, PipelineData> | null> {
    const stmt = this.db.prepare(
      "SELECT outputs FROM block_outputs WHERE run_id = ? AND block_id = ?",
    );
    const row = stmt.get(runId, blockId) as { outputs: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.outputs) as Record<string, PipelineData>;
  }

  /** Output, versioned report and human audit event become visible together or not at all. */
  async saveSplitterReview(
    run: WorkflowRun,
    blockId: string,
    outputs: Record<string, PipelineData>,
    event: AuditEventInput,
  ): Promise<void> {
    const validated = WorkflowRun.parse(run);
    for (const output of Object.values(outputs)) PipelineData.parse(output);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE runs SET block_runs = ? WHERE id = ? AND status = 'waiting_for_review'")
        .run(JSON.stringify(validated.blockRuns), run.id);
      if (Number(this.db.prepare("SELECT changes() AS n").get()?.n) !== 1)
        throw new Error("Routing correction requires a persisted paused run.");
      this.db
        .prepare(
          "INSERT INTO block_outputs (run_id, block_id, outputs) VALUES (?, ?, ?) ON CONFLICT(run_id, block_id) DO UPDATE SET outputs = excluded.outputs",
        )
        .run(run.id, blockId, JSON.stringify(outputs));
      new SqliteAuditLogger(this.db).recordSync(event);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
