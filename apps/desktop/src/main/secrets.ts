import { mkdir, readFile, writeFile, rename, rm, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  SECRET_NAMES,
  SecretName,
  SETUP_SECRET_PATTERN,
  type AnySecretName,
  type SecretStatus,
  type SecretState,
} from "@reqflow/core";
import { z } from "zod";
import { ReqflowError } from "./dispatch";

export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface SecretsStoreOptions {
  secureStorage?: SecureStorage;
  environment?: Record<string, string | undefined>;
  /** Test seam; production defaults to the host platform. */
  platform?: NodeJS.Platform;
}
const ENV_VAR_MAP: Record<SecretName, string> = {
  anthropic_api_key: "ANTHROPIC_API_KEY",
  openai_api_key: "OPENAI_API_KEY",
  google_api_key: "GOOGLE_API_KEY",
  tavily_api_key: "TAVILY_API_KEY",
  firecrawl_api_key: "FIRECRAWL_API_KEY",
  youtube_api_key: "YOUTUBE_API_KEY",
  apify_api_token: "APIFY_API_TOKEN",
  x_bearer_token: "X_BEARER_TOKEN",
  reddit_client_id: "REDDIT_CLIENT_ID",
  reddit_client_secret: "REDDIT_CLIENT_SECRET",
  reddit_refresh_token: "REDDIT_REFRESH_TOKEN",
  openalex_api_key: "OPENALEX_API_KEY",
};

const Credential = z
  .string()
  .min(1)
  .max(8192)
  .refine(
    (s) => s.trim().length > 0 && !/[\r\n\0]/.test(s),
    "Credential must be nonempty and contain no line breaks",
  );

export const AnySecretNameSchema = z.union([
  SecretName,
  z.string().regex(SETUP_SECRET_PATTERN, "Invalid setup secret name"),
]);

const Ciphertexts = z.record(
  z.string().refine((k) => SecretName.safeParse(k).success || SETUP_SECRET_PATTERN.test(k)),
  z
    .string()
    .min(1)
    .max(65536)
    .regex(/^[A-Za-z0-9+/]+=*$/),
);
const storageError = (message: string) => new ReqflowError("secret_storage_error", message);

/** Main-process only. Values never cross IPC; persistence always requires OS encryption. */
export class SecretsStore {
  private data: Record<string, string> = {};
  private queue: Promise<unknown> = Promise.resolve();
  private loading?: Promise<void>;
  private storage?: SecureStorage;
  private readonly environment: Record<string, string | undefined>;
  private readonly platform: NodeJS.Platform;
  constructor(
    private readonly dir: string,
    options: SecretsStoreOptions = {},
  ) {
    this.storage = options.secureStorage;
    this.environment = options.environment ?? process.env;
    this.platform = options.platform ?? process.platform;
  }
  private async resolveStorage(): Promise<void> {
    if (this.storage) return;
    try {
      const electron = await import("electron");
      this.storage = electron.safeStorage;
    } catch {
      // requireSecure supplies the stable, sanitized error. No plaintext fallback.
    }
  }
  private requireSecure(): SecureStorage {
    let available = false;
    try {
      available =
        !!this.storage?.isEncryptionAvailable() &&
        !(this.platform === "linux" && this.storage.getSelectedStorageBackend?.() === "basic_text");
    } catch {
      // Native keyring failures must not expose OS error details or enable a fallback.
    }
    if (!available)
      throw new ReqflowError(
        "secure_storage_unavailable",
        "OS-backed credential encryption is unavailable. Configure a secure OS keyring; plaintext fallback is disabled.",
      );
    return this.storage!;
  }
  private decrypt(encrypted: string): string {
    const storage = this.requireSecure();
    try {
      return Credential.parse(storage.decryptString(Buffer.from(encrypted, "base64")));
    } catch {
      throw storageError("Credential could not be decrypted with the OS keyring.");
    }
  }
  private async read(name: string): Promise<Record<string, string> | undefined> {
    try {
      const path = join(this.dir, name);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
        throw new Error("Unsafe credential store");
      return Ciphertexts.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw storageError("Encrypted credential store could not be read.");
    }
  }
  private async persist(next: Record<string, string>): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = join(this.dir, `.secrets-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, join(this.dir, "secrets.enc.json"));
      this.data = next;
    } catch {
      throw storageError("Encrypted credential store could not be written.");
    } finally {
      await rm(temp, { force: true });
    }
  }
  load(): Promise<void> {
    return (this.loading ??= (async () => {
      const current = await this.read("secrets.enc.json");
      if (current !== undefined) {
        this.data = current;
        if (Object.keys(current).length) await this.resolveStorage();
        return;
      }
      const legacy = await this.read("secrets.json");
      if (legacy === undefined) return;
      await this.resolveStorage();
      // Old main builds also stored base64 plaintext. Only successful OS decryption proves
      // an entry is legitimate. Never decode it as UTF-8, and never hide failure with env.
      for (const encrypted of Object.values(legacy)) this.decrypt(encrypted);
      await this.persist(legacy); // Leave the original legacy file untouched.
    })());
  }
  async getSecret(input: AnySecretName | string): Promise<string | null> {
    const name = AnySecretNameSchema.parse(input) as AnySecretName;
    await this.load();
    return this.get(name) ?? null;
  }
  async setSecret(input: AnySecretName | string, value: string | null): Promise<void> {
    const name = AnySecretNameSchema.parse(input) as AnySecretName;
    const validated = value === null ? null : Credential.parse(value);
    const operation = this.queue.then(async () => {
      await this.load();
      const next = { ...this.data };
      if (validated === null) delete next[name];
      else {
        await this.resolveStorage();
        try {
          next[name] = this.requireSecure().encryptString(validated).toString("base64");
        } catch (error) {
          if (error instanceof ReqflowError) throw error;
          throw storageError("Credential could not be encrypted with the OS keyring.");
        }
      }
      await this.persist(next);
    });
    this.queue = operation.catch(() => {});
    await operation;
  }
  async getStatus(): Promise<SecretStatus> {
    await this.load();
    // Stored-but-undecryptable credentials must not look usable to provider gates.
    for (const key of Object.keys(this.data)) this.get(key);
    for (const name of SECRET_NAMES) {
      if (!this.data[name]) this.get(name);
    }
    return this.status();
  }
  /** Compatibility for the isolated legacy Research tests; production uses async methods. */
  get(input: AnySecretName | string): string | undefined {
    const name = AnySecretNameSchema.parse(input) as AnySecretName;
    if (this.data[name]) return this.decrypt(this.data[name]);
    if (name in ENV_VAR_MAP) {
      const value = this.environment[ENV_VAR_MAP[name as SecretName]];
      try {
        return value ? Credential.parse(value) : undefined;
      } catch {
        throw storageError("Environment credential failed validation.");
      }
    }
    return undefined;
  }
  status(): SecretStatus {
    const base = Object.fromEntries(
      SECRET_NAMES.map((name) => [
        name,
        {
          configured: !!(this.data[name] || this.environment[ENV_VAR_MAP[name]]),
          source: this.data[name] ? "keychain" : this.environment[ENV_VAR_MAP[name]] ? "env" : null,
        },
      ]),
    ) as Record<SecretName, SecretState>;

    const setups: Record<string, SecretState> = {};
    for (const [key, value] of Object.entries(this.data)) {
      if (key.startsWith("setup:") && value) {
        setups[key.slice("setup:".length)] = { configured: true, source: "keychain" };
      }
    }
    return { ...base, setups };
  }
  async set(name: AnySecretName | string, value: string | null): Promise<SecretStatus> {
    await this.setSecret(name, value);
    return this.status();
  }
}
