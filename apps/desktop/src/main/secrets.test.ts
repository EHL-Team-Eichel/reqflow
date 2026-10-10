import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretsStore } from "./secrets";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(`encrypted:${v}`).reverse(),
    decryptString: (v: Buffer) =>
      Buffer.from(v)
        .reverse()
        .toString()
        .replace(/^encrypted:/, ""),
  },
}));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("OpenAI protected secret storage", () => {
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
