import { ReasoningTrace } from "@reqflow/core";
import type { DatabaseSync } from "node:sqlite";

/**
 * The Add to Car agents' thought process, one row per trace plus a requirement → trace map for
 * "Why this requirement?". Traces are history, like the audit trail: resetting the requirements
 * does not remove them.
 */
export class SqliteReasoningRepository {
  constructor(private readonly db: DatabaseSync) {}

  async save(trace: ReasoningTrace): Promise<void> {
    const t = ReasoningTrace.parse(trace);
    const requirementIds = [...new Set(t.requirements.map((r) => r.requirementId))];
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO reasoning_traces (id, run_id, block_id, created_at, json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(t.id, t.runId, t.blockId, t.createdAt, JSON.stringify(t));
      this.db.prepare("DELETE FROM reasoning_requirements WHERE trace_id = ?").run(t.id);
      const insert = this.db.prepare(
        "INSERT INTO reasoning_requirements (requirement_id, trace_id) VALUES (?, ?)",
      );
      for (const id of requirementIds) insert.run(id, t.id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Newest trace of `blockId` in run `runId`, or null. */
  async forRun(runId: string, blockId: string): Promise<ReasoningTrace | null> {
    const row = this.db
      .prepare(
        `SELECT id, json FROM reasoning_traces WHERE run_id = ? AND block_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(runId, blockId) as TraceRow | undefined;
    return row ? parseRow(row) : null;
  }

  /** Newest trace of `blockId` over every run of workflow `workflowId`, or null. */
  async latest(workflowId: string, blockId: string): Promise<ReasoningTrace | null> {
    const row = this.db
      .prepare(
        `SELECT t.id, t.json FROM reasoning_traces t
         JOIN runs r ON r.id = t.run_id
         WHERE r.workflow_id = ? AND t.block_id = ?
         ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1`,
      )
      .get(workflowId, blockId) as TraceRow | undefined;
    return row ? parseRow(row) : null;
  }

  /** Newest trace that explains requirement `requirementId`, or null. */
  async forRequirement(requirementId: string): Promise<ReasoningTrace | null> {
    const row = this.db
      .prepare(
        `SELECT t.id, t.json FROM reasoning_traces t
         JOIN reasoning_requirements m ON m.trace_id = t.id
         WHERE m.requirement_id = ?
         ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1`,
      )
      .get(requirementId) as TraceRow | undefined;
    return row ? parseRow(row) : null;
  }
}

interface TraceRow {
  id: string;
  json: string;
}

function parseRow(row: TraceRow): ReasoningTrace {
  let raw: unknown;
  try {
    raw = JSON.parse(row.json);
  } catch (err) {
    throw new Error(`Reasoning trace ${row.id} is corrupt: not valid JSON`, { cause: err });
  }
  const parsed = ReasoningTrace.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Reasoning trace ${row.id} is corrupt: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}
