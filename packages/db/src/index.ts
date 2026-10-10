// @reqflow/db — Owner: WS1 (see docs/WORKSTREAMS.md).
// SQLite persistence via built-in `node:sqlite` (file: DATABASE_PATH, default data/app.db).
// Provides: repositories for workflows, runs (+ per-node outputs), sources, findings, requirements (+ versions),
// settings, uploaded files (FileStore), and the append-only audit log (AuditLogger). Server-only.
export {};
