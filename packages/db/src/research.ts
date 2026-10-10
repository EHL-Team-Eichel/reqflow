import type { DatabaseSync } from "node:sqlite";
import { BlockId, ResearchDataset, Settings } from "@reqflow/core";
import { z } from "zod";

const RunId = z.string().regex(/^run_[A-Za-z0-9_-]{1,100}$/);
const MAX_DATASET_BYTES = 16 * 1024 * 1024;

/** Additive SQLite migration; the application's existing run repository remains authoritative. */
export class ResearchDatasetRepository {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_datasets (
        run_id TEXT NOT NULL, block_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
        json TEXT NOT NULL, PRIMARY KEY (run_id, block_id),
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS run_settings (
        run_id TEXT PRIMARY KEY, json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(id)
      );
    `);
  }
  get(runId: string): ResearchDataset | null {
    return this.read(RunId.parse(runId), "");
  }
  private read(runId: string, blockId: string): ResearchDataset | null {
    const row = this.db
      .prepare("SELECT json FROM research_datasets WHERE run_id = ? AND block_id = ?")
      .get(runId, blockId) as { json: string } | undefined;
    return row ? ResearchDataset.parse(JSON.parse(row.json)) : null;
  }
  blocks(runId: string): Map<string, ResearchDataset> {
    const rows = this.db
      .prepare("SELECT block_id, json FROM research_datasets WHERE run_id = ? AND block_id <> ''")
      .all(RunId.parse(runId)) as { block_id: string; json: string }[];
    return new Map(rows.map((row) => [row.block_id, ResearchDataset.parse(JSON.parse(row.json))]));
  }
  save(runId: string, blockId: string, dataset: ResearchDataset, aggregate: ResearchDataset): void {
    RunId.parse(runId);
    BlockId.parse(blockId);
    const serialize = (value: ResearchDataset) => {
      if (value.runId !== runId)
        throw new Error("Research dataset run does not match its storage key");
      const json = JSON.stringify(ResearchDataset.parse(value));
      if (Buffer.byteLength(json) > MAX_DATASET_BYTES)
        throw new Error("Research dataset exceeds 16 MiB storage budget");
      return json;
    };
    const part = serialize(dataset),
      merged = serialize(aggregate);
    this.db.exec("SAVEPOINT research_dataset_save");
    try {
      const stmt = this.db
        .prepare(`INSERT INTO research_datasets(run_id, block_id, schema_version, json)
        VALUES (?, ?, 1, ?) ON CONFLICT(run_id, block_id) DO UPDATE SET json = excluded.json`);
      stmt.run(runId, blockId, part);
      stmt.run(runId, "", merged);
      this.db.exec("RELEASE research_dataset_save");
    } catch (error) {
      this.db.exec("ROLLBACK TO research_dataset_save; RELEASE research_dataset_save");
      throw error;
    }
  }
  saveSettings(runId: string, settings: Settings): void {
    this.db
      .prepare(
        "INSERT INTO run_settings(run_id, json) VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING",
      )
      .run(RunId.parse(runId), JSON.stringify(Settings.parse(settings)));
  }
  settings(runId: string): Settings | null {
    const row = this.db
      .prepare("SELECT json FROM run_settings WHERE run_id = ?")
      .get(RunId.parse(runId)) as { json: string } | undefined;
    return row ? Settings.parse(JSON.parse(row.json)) : null;
  }
}
