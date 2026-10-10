import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_SETTINGS, Settings } from "@reqflow/core";

export function getSettingsFilePath(dataDir: string): string {
  return join(dataDir, "settings.json");
}

function asObject(val: unknown): Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

export function mergeWithDefaultSettings(raw: unknown): Settings {
  const obj = asObject(raw);
  const scoring = asObject(obj.scoring);
  const review = asObject(obj.review);

  const merged = {
    ...DEFAULT_SETTINGS,
    ...obj,
    app: {
      ...DEFAULT_SETTINGS.app,
      ...asObject(obj.app),
    },
    llm: {
      ...DEFAULT_SETTINGS.llm,
      ...asObject(obj.llm),
    },
    research: {
      ...DEFAULT_SETTINGS.research,
      ...asObject(obj.research),
    },
    scoring: {
      ...DEFAULT_SETTINGS.scoring,
      ...scoring,
      weights: {
        ...DEFAULT_SETTINGS.scoring.weights,
        ...asObject(scoring.weights),
      },
      thresholds: {
        ...DEFAULT_SETTINGS.scoring.thresholds,
        ...asObject(scoring.thresholds),
      },
    },
    review: {
      ...DEFAULT_SETTINGS.review,
      ...review,
      reviewer: {
        ...DEFAULT_SETTINGS.review.reviewer,
        ...asObject(review.reviewer),
      },
    },
    defaultScope: {
      ...DEFAULT_SETTINGS.defaultScope,
      ...asObject(obj.defaultScope),
    },
    collaboration: {
      ...DEFAULT_SETTINGS.collaboration,
      ...asObject(obj.collaboration),
    },
  };

  return Settings.parse(merged);
}

export function loadSettings(dataDir: string): Settings {
  const filePath = getSettingsFilePath(dataDir);
  if (!existsSync(filePath)) {
    return DEFAULT_SETTINGS;
  }

  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    return mergeWithDefaultSettings(parsed);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(dataDir: string, settingsInput: unknown): Settings {
  const validated = Settings.parse(settingsInput);
  const filePath = getSettingsFilePath(dataDir);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = join(dir, `settings.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(validated, null, 2), "utf8");
  renameSync(tmpPath, filePath);

  return validated;
}
