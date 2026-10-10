import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";

/**
 * Where the database and imported datasets live. Per-user and per-OS by default:
 *   macOS   ~/Library/Application Support/ReqFlow/data
 *   Windows %APPDATA%\ReqFlow\data
 *   Linux   ~/.config/ReqFlow/data
 * REQFLOW_DATA_DIR overrides it (tests, smoke runs, demos with a prepared dataset).
 */
export function dataDir(override?: string | null): string {
  const custom = override ?? process.env.REQFLOW_DATA_DIR;
  return custom ? resolve(custom) : join(app.getPath("userData"), "data");
}

export const dbFile = (dir: string): string => join(dir, "reqflow.db");
export const uploadsDir = (dir: string): string => join(dir, "uploads");

/** Dev only: load apps/desktop/.env (API keys for local testing). Packaged apps use the OS keychain. */
export function loadDevEnv(): void {
  if (app.isPackaged) return;
  const file = join(app.getAppPath(), ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}
