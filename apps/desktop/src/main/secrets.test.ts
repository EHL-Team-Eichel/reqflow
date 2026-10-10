import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretsStore } from "./secrets";

const storage = vi.hoisted(() => ({ available: true, backend: "keychain" }));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => storage.available,
    getSelectedStorageBackend: () => storage.backend,
    encryptString: (v: string) => Buffer.from(`encrypted:${v}`).reverse(),
    decryptString: (v: Buffer) =>
      Buffer.from(v)
        .reverse()
        .toString()
        .replace(/^encrypted:/, ""),
  },
}));
const dirs: string[] = [];
beforeEach(() => {
  storage.available = true;
  storage.backend = "keychain";
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("OpenAI protected secret storage", () => {
  it("refuses plaintext storage and never treats unreadable ciphertext as a key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reqflow-secret-test-"));
    dirs.push(dir);
    const store = new SecretsStore(dir);
    await store.setSecret("openai_api_key", "synthetic-secret-only");
    storage.available = false;
    expect(await store.getSecret("openai_api_key")).toBeNull();
    await expect(store.setSecret("openai_api_key", "synthetic-replacement")).rejects.toThrow(
      /OS-protected/,
    );
    storage.available = true;
    storage.backend = "basic_text";
    expect(await store.getSecret("openai_api_key")).toBeNull();
    await expect(store.setSecret("openai_api_key", "synthetic-replacement")).rejects.toThrow(
      /OS-protected/,
    );
    vi.stubEnv("OPENAI_API_KEY", "synthetic-environment-key");
    expect(await store.getSecret("openai_api_key")).toBe("synthetic-environment-key");
  });
  it("stores only ciphertext, exposes status without the key, and supports removal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reqflow-secret-test-"));
    dirs.push(dir);
    const store = new SecretsStore(dir);
    const synthetic = "synthetic-secret-only";
    await store.setSecret("openai_api_key", synthetic);
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain(synthetic);
    expect(await store.getSecret("openai_api_key")).toBe(synthetic);
    expect((await store.getStatus()).openai_api_key).toEqual({
      configured: true,
      source: "keychain",
    });
    await store.setSecret("openai_api_key", null);
    expect((await store.getStatus()).openai_api_key.configured).toBe(false);
  });
});
