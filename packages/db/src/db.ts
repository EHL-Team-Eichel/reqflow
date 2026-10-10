import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ReqflowDbOptions {
  path?: string; // ":memory:" or file path
}

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
    CREATE TABLE IF NOT EXISTS settings (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      scope TEXT NOT NULL,
      graph TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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
      node_runs TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_outputs (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id)
    );

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
      node_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events (at);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events (entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events (run_id);

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      relative_path TEXT NOT NULL
    );
  `);
}
