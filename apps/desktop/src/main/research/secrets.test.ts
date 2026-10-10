import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_NAMES } from "@reqflow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretStore, type SecureStorage } from "./secrets";

// A reversible test double, NOT a claim of OS encryption or cryptographic security.
const prefix = "synthetic-cipher:v1:";
function fakeStorage(): SecureStorage {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => "synthetic-keyring"),
    encryptString: vi.fn((value: string) =>
      Buffer.concat([
        Buffer.from(prefix),
        Buffer.from([...Buffer.from(value)].map((byte) => byte ^ 0xa5)),
      ]),
    ),
    decryptString: vi.fn((value: Buffer) => {
      if (!value.subarray(0, prefix.length).equals(Buffer.from(prefix)))
        throw new Error("Synthetic cipher marker missing");
      return Buffer.from([...value.subarray(prefix.length)].map((byte) => byte ^ 0xa5)).toString(
        "utf8",
      );
    }),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reqflow-secrets-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("SecretStore", () => {
  it("reports every supported credential as unconfigured for a fresh store", async () => {
    const store = new SecretStore(dir, fakeStorage());
    await store.load();

    expect(store.status()).toEqual({
      ...Object.fromEntries(
        SECRET_NAMES.map((name) => [name, { configured: false, source: null }]),
      ),
      setups: {},
    });
  });

  it("returns status only and writes distinct ciphertext rather than the credential", async () => {
    const storage = fakeStorage();
    const store = new SecretStore(dir, storage);
    const value = "synthetic-firecrawl-credential-only";

    const status = await store.set("firecrawl_api_key", value);
    const disk = await readFile(join(dir, "secrets.enc.json"), "utf8");
    const cipher = Buffer.from(JSON.parse(disk).firecrawl_api_key, "base64");

    expect(status).toEqual({
      setups: {},
      ...Object.fromEntries(
        SECRET_NAMES.map((name) => [name, { configured: false, source: null }]),
      ),
      firecrawl_api_key: { configured: true, source: "keychain" },
    });
    expect(JSON.stringify(status)).not.toContain(value);
    expect(disk).not.toContain(value);
    expect(cipher.subarray(0, prefix.length).toString()).toBe(prefix);
    expect(cipher.includes(Buffer.from(value))).toBe(false);
    expect(store.get("firecrawl_api_key")).toBe(value);
    expect(await readdir(dir)).toEqual(["secrets.enc.json"]);
  });

  it("reloads persisted credentials through the injected secure-storage boundary", async () => {
    await new SecretStore(dir, fakeStorage()).set("youtube_api_key", "synthetic-persisted-key");
    const restored = new SecretStore(dir, fakeStorage());

    await restored.load();

    expect(restored.status().youtube_api_key).toEqual({ configured: true, source: "keychain" });
    expect(restored.get("youtube_api_key")).toBe("synthetic-persisted-key");
  });

  it.each(["", " ", "\t", "\n", "synthetic\nkey", "synthetic\rkey", "synthetic\0key"])(
    "rejects invalid credential %j without deleting an existing value",
    async (invalid) => {
      const store = new SecretStore(dir, fakeStorage());
      await store.set("tavily_api_key", "synthetic-existing-key");
      const before = await readFile(join(dir, "secrets.enc.json"), "utf8");

      await expect(store.set("tavily_api_key", invalid)).rejects.toThrow();

      expect(store.get("tavily_api_key")).toBe("synthetic-existing-key");
      expect(await readFile(join(dir, "secrets.enc.json"), "utf8")).toBe(before);
    },
  );

  it("rejects oversized credentials without replacing a valid credential", async () => {
    const store = new SecretStore(dir, fakeStorage());
    await store.set("x_bearer_token", "synthetic-existing-key");

    await expect(store.set("x_bearer_token", "s".repeat(8193))).rejects.toThrow();

    expect(store.get("x_bearer_token")).toBe("synthetic-existing-key");
  });

  it("removes only the named credential on null and persists its removal", async () => {
    const store = new SecretStore(dir, fakeStorage());
    await store.set("firecrawl_api_key", "synthetic-firecrawl-key");
    await store.set("youtube_api_key", "synthetic-youtube-key");

    const status = await store.set("firecrawl_api_key", null);
    const restored = new SecretStore(dir, fakeStorage());
    await restored.load();

    expect(status.firecrawl_api_key).toEqual({ configured: false, source: null });
    expect(restored.get("firecrawl_api_key")).toBeUndefined();
    expect(restored.get("youtube_api_key")).toBe("synthetic-youtube-key");
  });

  it.each(["unavailable", "linux-basic-text"] as const)(
    "rejects plaintext fallback when secure storage is %s",
    async (scenario) => {
      const storage = fakeStorage();
      if (scenario === "unavailable") storage.isEncryptionAvailable = () => false;
      else storage.getSelectedStorageBackend = () => "basic_text";
      const store = new SecretStore(dir, storage, scenario === "unavailable" ? "darwin" : "linux");

      await expect(store.set("firecrawl_api_key", "synthetic-key")).rejects.toMatchObject({
        code: "secure_storage_unavailable",
        message: expect.stringMatching(/plaintext fallback is disabled/i),
      });

      expect(storage.encryptString).not.toHaveBeenCalled();
      expect(store.status().firecrawl_api_key.configured).toBe(false);
      expect(await readdir(dir)).toEqual([]);
    },
  );

  it("does not decrypt existing values when encryption becomes unavailable, but permits removal", async () => {
    const storage = fakeStorage();
    const store = new SecretStore(dir, storage);
    await store.set("firecrawl_api_key", "synthetic-key");
    storage.isEncryptionAvailable = () => false;

    expect(() => store.get("firecrawl_api_key")).toThrow(/encryption is unavailable/i);
    expect(storage.decryptString).not.toHaveBeenCalled();
    await expect(store.set("firecrawl_api_key", null)).resolves.toMatchObject({
      firecrawl_api_key: { configured: false, source: null },
    });
  });

  it("serializes independent writes without losing either credential", async () => {
    const store = new SecretStore(dir, fakeStorage());

    await Promise.all([
      store.set("firecrawl_api_key", "synthetic-first-key"),
      store.set("youtube_api_key", "synthetic-second-key"),
    ]);
    const restored = new SecretStore(dir, fakeStorage());
    await restored.load();

    expect([restored.get("firecrawl_api_key"), restored.get("youtube_api_key")]).toEqual([
      "synthetic-first-key",
      "synthetic-second-key",
    ]);
  });

  it.each([
    '{"synthetic-private-marker":',
    JSON.stringify({ unexpected_name: "synthetic-private-marker" }),
    JSON.stringify({ firecrawl_api_key: "synthetic-private-marker!!" }),
  ])("reports a corrupt encrypted store without exposing its contents", async (contents) => {
    await writeFile(join(dir, "secrets.enc.json"), contents);
    const store = new SecretStore(dir, fakeStorage());

    await expect(store.load()).rejects.toMatchObject({
      code: "secret_storage_error",
      message: "Encrypted credential store could not be read.",
    });
  });

  it("reports decryption failure without exposing ciphertext or the keyring error", async () => {
    const storage = fakeStorage();
    const store = new SecretStore(dir, storage);
    await store.set("firecrawl_api_key", "synthetic-key");
    storage.decryptString = () => {
      throw new Error("synthetic-private-keyring-detail");
    };

    expect(() => store.get("firecrawl_api_key")).toThrow(
      "Credential could not be decrypted with the OS keyring.",
    );
  });
});
