import { DEFAULT_SETTINGS, Settings } from "@reqflow/core";
import type { DatabaseSync } from "node:sqlite";

export class SqliteSettingsRepository {
  constructor(private readonly db: DatabaseSync) {}

  async get(): Promise<Settings> {
    const stmt = this.db.prepare("SELECT json FROM settings WHERE id = 'default'");
    const row = stmt.get() as { json: string } | undefined;
    if (!row) {
      return DEFAULT_SETTINGS;
    }
    return Settings.parse(JSON.parse(row.json));
  }

  async save(settings: Settings): Promise<Settings> {
    const validated = Settings.parse(settings);
    const now = new Date().toISOString();
    const json = JSON.stringify(validated);

    const stmt = this.db.prepare(`
      INSERT INTO settings (id, json, updated_at)
      VALUES ('default', ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `);
    stmt.run(json, now);

    return validated;
  }
}
