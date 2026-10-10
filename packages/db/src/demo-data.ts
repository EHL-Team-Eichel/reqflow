import { fixtureAuditEvents, fixturePipelineData, fixtureRun } from "@reqflow/core/fixtures";
import type { DatabaseSync } from "node:sqlite";

export interface DemoDataRemoved {
  requirements: number;
  sources: number;
  records: number;
  findings: number;
  themes: number;
  auditEvents: number;
  runs: number;
}

/**
 * Deletes the synthetic demo rows that earlier versions of the app seeded into every new database.
 * Only rows with the fixtures' exact ids or the demo run id are touched, so real results stay.
 * Safe to run on every start: a clean database is left as it is.
 */
export function removeDemoData(db: DatabaseSync): DemoDataRemoved {
  const runId = fixtureRun.id;
  const remove = (table: string, ids: readonly string[], alsoByRun: boolean): number => {
    const placeholders = ids.map(() => "?").join(", ");
    const where = [ids.length ? `id IN (${placeholders})` : null, alsoByRun ? "run_id = ?" : null]
      .filter(Boolean)
      .join(" OR ");
    if (!where) return 0;
    const params = [...ids, ...(alsoByRun ? [runId] : [])];
    return Number(db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params).changes);
  };
  const ids = <T extends { id: string }>(list: readonly T[]) => list.map((x) => x.id);

  db.exec("BEGIN");
  try {
    const removed: DemoDataRemoved = {
      // Older builds seeded other vehicle codes (REQ-5S-EU-…), all under the demo run id.
      requirements: remove("requirements", ids(fixturePipelineData.requirements), true),
      sources: remove("sources", ids(fixturePipelineData.sources), true),
      records: remove("records", ids(fixturePipelineData.records), true),
      findings: remove("findings", ids(fixturePipelineData.findings), true),
      themes: remove("themes", ids(fixturePipelineData.themes), true),
      auditEvents: remove("audit_events", ids(fixtureAuditEvents), true),
      runs: remove("runs", [runId], false),
    };
    db.exec("COMMIT");
    return removed;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
