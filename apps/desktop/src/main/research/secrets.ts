import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SECRET_NAMES, SecretName, type SecretStatus } from "@reqflow/core";
import { z } from "zod";
import { ReqflowError } from "../dispatch";

export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
/** Only ciphertext is persisted. This private main-process service has no IPC getter. */
export class SecretStore {
  private data: Partial<Record<SecretName, string>> = {};
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private dir: string,
    private storage: SecureStorage,
    private platform = process.platform,
  ) {}
  async load(): Promise<void> {
    try {
      this.data = z
        .partialRecord(SecretName, z.string().regex(/^[A-Za-z0-9+/]+=*$/))
        .parse(JSON.parse(await readFile(join(this.dir, "secrets.enc.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ReqflowError(
          "secret_storage_error",
          "Encrypted credential store could not be read.",
        );
    }
  }
  private requireSecure(): void {
    if (
      !this.storage.isEncryptionAvailable() ||
      (this.platform === "linux" && this.storage.getSelectedStorageBackend?.() === "basic_text")
    )
      throw new ReqflowError(
        "secure_storage_unavailable",
        "OS-backed credential encryption is unavailable. Configure a secure OS keyring; plaintext fallback is disabled.",
      );
  }
  status(): SecretStatus {
    return Object.fromEntries(
      SECRET_NAMES.map((name) => [
        name,
        { configured: !!this.data[name], source: this.data[name] ? "keychain" : null },
      ]),
    ) as SecretStatus;
  }
  get(name: SecretName): string | undefined {
    const encrypted = this.data[name];
    if (!encrypted) return undefined;
    this.requireSecure();
    try {
      return this.storage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      throw new ReqflowError(
        "secret_storage_error",
        "Credential could not be decrypted with the OS keyring.",
      );
    }
  }
  async set(input: SecretName, value: string | null): Promise<SecretStatus> {
    const name = SecretName.parse(input);
    const validated =
      value === null
        ? null
        : z
            .string()
            .min(1)
            .max(8192)
            .refine(
              (s) => s.trim().length > 0 && !/[\r\n\0]/.test(s),
              "Credential must be nonempty and contain no line breaks",
            )
            .parse(value);
    const operation = this.queue.then(async () => {
      if (validated !== null) this.requireSecure();
      const next = { ...this.data };
      if (validated === null) delete next[name];
      else next[name] = this.storage.encryptString(validated).toString("base64");
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const temp = join(this.dir, `.secrets-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
        await rename(temp, join(this.dir, "secrets.enc.json"));
        this.data = next;
      } finally {
        await rm(temp, { force: true });
      }
      return this.status();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
