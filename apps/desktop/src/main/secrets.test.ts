import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECRET_NAMES } from "@reqflow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretsStore, type SecureStorage } from "./secrets";

// Synthetic boundary double, not cryptography or an OS keyring claim.
const storage: SecureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`cipher:${value.split("").reverse().join("")}`),
  decryptString: (value) => {
    const text = value.toString();
    if (!text.startsWith("cipher:")) throw new Error("synthetic private keyring detail");
    return text.slice(7).split("").reverse().join("");
  },
};
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reqflow-main-secrets-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const store = (environment: Record<string, string | undefined> = {}) =>
  new SecretsStore(dir, { secureStorage: storage, environment });

describe("unified main SecretsStore", () => {
  it("supports every contract name, async API, encryption and central environment lookup", async () => {
    const service = store({
      OPENAI_API_KEY: "synthetic-env-openai",
      GOOGLE_API_KEY: "synthetic-env-google",
    });
    expect(Object.keys(await service.getStatus())).toEqual([...SECRET_NAMES]);
    expect(await service.getSecret("openai_api_key")).toBe("synthetic-env-openai");
    expect((await service.getStatus()).google_api_key).toEqual({ configured: true, source: "env" });
    await service.setSecret("openai_api_key", "synthetic-stored-openai");
    expect(await service.getSecret("openai_api_key")).toBe("synthetic-stored-openai");
    expect(await readFile(join(dir, "secrets.enc.json"), "utf8")).not.toContain(
      "synthetic-stored-openai",
    );
    await service.setSecret("openai_api_key", null);
    expect(await service.getSecret("openai_api_key")).toBe("synthetic-env-openai");
  });
  it("migrates only OS-decryptable legacy ciphertext and leaves legacy file intact", async () => {
    const original = JSON.stringify({
      google_api_key: storage.encryptString("synthetic-legacy").toString("base64"),
    });
    await writeFile(join(dir, "secrets.json"), original);
    expect(await store().getSecret("google_api_key")).toBe("synthetic-legacy");
    expect(await readFile(join(dir, "secrets.json"), "utf8")).toBe(original);
    await store().setSecret("google_api_key", null);
    expect(await store().getSecret("google_api_key")).toBeNull();
  });
  it("never interprets legacy plaintext/base64 as credentials or hides failure with environment fallback", async () => {
    const original = JSON.stringify({
      openai_api_key: Buffer.from("synthetic-plaintext").toString("base64"),
    });
    await writeFile(join(dir, "secrets.json"), original);
    await expect(
      store({ OPENAI_API_KEY: "synthetic-env" }).getSecret("openai_api_key"),
    ).rejects.toMatchObject({ code: "secret_storage_error" });
    expect(await readFile(join(dir, "secrets.json"), "utf8")).toBe(original);
  });
  it("refuses unavailable encryption and Linux basic_text without writing fallback", async () => {
    for (const secureStorage of [
      { ...storage, isEncryptionAvailable: () => false },
      { ...storage, getSelectedStorageBackend: () => "basic_text" },
    ]) {
      const service = new SecretsStore(dir, { secureStorage, environment: {}, platform: "linux" });
      await expect(service.setSecret("google_api_key", "synthetic-key")).rejects.toMatchObject({
        code: "secure_storage_unavailable",
      });
      await expect(readFile(join(dir, "secrets.enc.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
  it("serializes concurrent writes and deletion without lost credentials", async () => {
    const service = store();
    await Promise.all([
      service.setSecret("openai_api_key", "synthetic-openai"),
      service.setSecret("google_api_key", "synthetic-google"),
      service.setSecret("openai_api_key", null),
    ]);
    const restarted = store();
    expect(await restarted.getSecret("openai_api_key")).toBeNull();
    expect(await restarted.getSecret("google_api_key")).toBe("synthetic-google");
    expect(await readFile(join(dir, "secrets.enc.json"), "utf8")).not.toContain("synthetic-google");
  });
  it("validates environment credentials before reporting configured and never exposes invalid values", async () => {
    const service = store({ GOOGLE_API_KEY: "synthetic-invalid\nprivate-detail" });
    await expect(service.getStatus()).rejects.toMatchObject({ code: "secret_storage_error" });
    await expect(service.getSecret("google_api_key")).rejects.toThrow(/failed validation/);
    await expect(service.getSecret("google_api_key")).rejects.not.toThrow(/private-detail/);
  });
  it("rejects encrypted-store symlinks and does not mask corruption with environment credentials", async () => {
    const original = JSON.stringify({
      google_api_key: storage.encryptString("synthetic-original").toString("base64"),
    });
    const outside = join(dir, "synthetic-outside.json");
    await writeFile(outside, original);
    await symlink(outside, join(dir, "secrets.enc.json"));
    await expect(
      store({ GOOGLE_API_KEY: "synthetic-env" }).getSecret("google_api_key"),
    ).rejects.toMatchObject({ code: "secret_storage_error" });
    expect(await readFile(outside, "utf8")).toBe(original);
  });
  it("keeps previous ciphertext on encryption failure and allows a later valid queued write", async () => {
    const service = new SecretsStore(dir, {
      environment: {},
      secureStorage: {
        ...storage,
        encryptString(value) {
          if (value === "synthetic-failure") throw new Error("synthetic-private-keyring-detail");
          return storage.encryptString(value);
        },
      },
    });
    await service.setSecret("google_api_key", "synthetic-original");
    const original = await readFile(join(dir, "secrets.enc.json"), "utf8");
    await expect(service.setSecret("google_api_key", "synthetic-failure")).rejects.not.toThrow(
      /private-keyring-detail/,
    );
    expect(await readFile(join(dir, "secrets.enc.json"), "utf8")).toBe(original);
    expect(await service.getSecret("google_api_key")).toBe("synthetic-original");
    await service.setSecret("openai_api_key", "synthetic-new");
    expect(await store().getSecret("openai_api_key")).toBe("synthetic-new");
  });
});
