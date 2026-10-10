import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretName, SecretStatus } from "@reqflow/core/ipc";

const ENV_VAR_MAP: Record<SecretName, string> = {
  anthropic_api_key: "ANTHROPIC_API_KEY",
  tavily_api_key: "TAVILY_API_KEY",
  openai_api_key: "OPENAI_API_KEY",
};

async function getSafeStorage() {
  try {
    const electron = await import("electron");
    return electron.safeStorage;
  } catch {
    return undefined;
  }
}

export class SecretsStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "secrets.json");
  }

  private readAll(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    try {
      const content = readFileSync(this.filePath, "utf8");
      return JSON.parse(content) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, string>): void {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
  }

  async getSecret(name: SecretName): Promise<string | null> {
    const all = this.readAll();
    const stored = all[name];
    if (stored) {
      try {
        const safeStorage = await getSafeStorage();
        if (safeStorage && safeStorage.isEncryptionAvailable()) {
          const buf = Buffer.from(stored, "base64");
          return safeStorage.decryptString(buf);
        }
        return Buffer.from(stored, "base64").toString("utf8");
      } catch {
        // Fallback / corrupted
      }
    }

    const envVar = ENV_VAR_MAP[name];
    if (envVar && process.env[envVar]) {
      return process.env[envVar]!;
    }

    return null;
  }

  async setSecret(name: SecretName, value: string | null): Promise<void> {
    const all = this.readAll();
    if (value === null || value === undefined || value.trim() === "") {
      delete all[name];
    } else {
      const safeStorage = await getSafeStorage();
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(value);
        all[name] = encrypted.toString("base64");
      } else {
        if (name === "openai_api_key")
          throw new Error(
            "OS-protected key storage is unavailable. Configure OPENAI_API_KEY in the main-process environment instead.",
          );
        all[name] = Buffer.from(value, "utf8").toString("base64");
      }
    }
    this.writeAll(all);
  }

  async getStatus(): Promise<SecretStatus> {
    const all = this.readAll();
    const result: SecretStatus = {
      anthropic_api_key: { configured: false, source: null },
      tavily_api_key: { configured: false, source: null },
      openai_api_key: { configured: false, source: null },
    };

    const keys: SecretName[] = ["anthropic_api_key", "tavily_api_key", "openai_api_key"];
    for (const key of keys) {
      if (all[key]) {
        result[key] = { configured: true, source: "keychain" };
      } else {
        const envVar = ENV_VAR_MAP[key];
        if (envVar && process.env[envVar]) {
          result[key] = { configured: true, source: "env" };
        } else {
          result[key] = { configured: false, source: null };
        }
      }
    }

    return result;
  }
}
