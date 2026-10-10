import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@reqflow/core";
import {
  getSettingsFilePath,
  loadSettings,
  mergeWithDefaultSettings,
  saveSettings,
} from "./settings-storage";

describe("settings-storage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "reqflow-settings-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns DEFAULT_SETTINGS if file does not exist", () => {
    const loaded = loadSettings(tempDir);
    expect(loaded).toEqual(DEFAULT_SETTINGS);
  });

  it("merges partial older settings with DEFAULT_SETTINGS", () => {
    const older = {
      app: { theme: "dark" },
      llm: { model: "claude-3-haiku" },
    };
    const merged = mergeWithDefaultSettings(older);
    expect(merged.app.theme).toBe("dark");
    expect(merged.app.snapToGrid).toBe(true);
    expect(merged.llm.model).toBe("claude-3-haiku");
    expect(merged.scoring.thresholds.must).toBe(70);
  });

  it("saves atomically and survives restart", () => {
    const modified = {
      ...DEFAULT_SETTINGS,
      app: { ...DEFAULT_SETTINGS.app, theme: "dark" as const },
    };
    saveSettings(tempDir, modified);

    const filePath = getSettingsFilePath(tempDir);
    const rawSaved = JSON.parse(readFileSync(filePath, "utf8"));
    expect(rawSaved.app.theme).toBe("dark");

    const reloaded = loadSettings(tempDir);
    expect(reloaded.app.theme).toBe("dark");
  });
});
