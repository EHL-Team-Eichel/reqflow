import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function createDatabase(dbPath = ":memory:"): DatabaseSync {
  if (dbPath !== ":memory:") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  initSchema(db);
  return db;
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requirements (
      id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT,
      evidence_level TEXT NOT NULL,
      run_id TEXT,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_requirements_id ON requirements (id);
    CREATE INDEX IF NOT EXISTS idx_requirements_run_id ON requirements (run_id);
    CREATE INDEX IF NOT EXISTS idx_requirements_status ON requirements (status);

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      run_id TEXT,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS themes (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      changes TEXT NOT NULL,
      rationale TEXT,
      run_id TEXT,
      block_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events (at);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events (entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events (run_id);

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      graph TEXT NOT NULL,
      started_by TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT,
      block_runs TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS block_outputs (
      run_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      outputs TEXT NOT NULL,
      PRIMARY KEY (run_id, block_id)
    );

    CREATE TABLE IF NOT EXISTS reasoning_traces (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reasoning_run ON reasoning_traces (run_id, block_id);

    CREATE TABLE IF NOT EXISTS reasoning_requirements (
      requirement_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      PRIMARY KEY (requirement_id, trace_id)
    );

  `);

  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version < 1) {
    db.exec("SAVEPOINT filter_migration");
    try {
      db.exec(`
    CREATE TABLE IF NOT EXISTS filter_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_hash TEXT NOT NULL,
      configuration_hash TEXT NOT NULL,
      version INTEGER NOT NULL,
      actor TEXT NOT NULL,
      at TEXT NOT NULL,
      rationale TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_filter_overrides_lookup ON filter_overrides (workflow_id, block_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_filter_overrides_version ON filter_overrides (workflow_id, block_id, version);
    PRAGMA user_version = 1;
      `);
      db.exec("RELEASE filter_migration");
    } catch (error) {
      db.exec("ROLLBACK TO filter_migration; RELEASE filter_migration");
      throw error;
    }
  }

  try {
    db.exec("ALTER TABLE audit_events ADD COLUMN block_id TEXT;");
  } catch {
    // column already exists
  }
}
