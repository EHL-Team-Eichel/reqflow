import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FixedSecretName, SecretName, SecretStatus } from "@reqflow/core/ipc";

const ENV_VAR_MAP: Record<FixedSecretName, string> = {
  anthropic_api_key: "ANTHROPIC_API_KEY",
  tavily_api_key: "TAVILY_API_KEY",
};
const FIXED: FixedSecretName[] = ["anthropic_api_key", "tavily_api_key"];
const envVar = (name: SecretName): string | undefined =>
  (ENV_VAR_MAP as Record<string, string | undefined>)[name];

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

    const variable = envVar(name);
    if (variable && process.env[variable]) {
      return process.env[variable]!;
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
      setups: {},
    };

    for (const key of FIXED) {
      if (all[key]) {
        result[key] = { configured: true, source: "keychain" };
      } else {
        const variable = ENV_VAR_MAP[key];
        result[key] = process.env[variable]
          ? { configured: true, source: "env" }
          : { configured: false, source: null };
      }
    }
    // API setup keys live only in the keychain; setups without a key are simply absent.
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith("setup:") && value) {
        result.setups[key.slice("setup:".length)] = { configured: true, source: "keychain" };
      }
    }

    return result;
  }
}
