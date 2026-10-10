import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createFileStore } from "./files";

const root = mkdtempSync(join(tmpdir(), "reqflow-files-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("file store", () => {
  it("imports a copy and reads it back by id", async () => {
    const original = join(root, "Take Rates.CSV");
    writeFileSync(original, "a;b\n1;2\n");
    const store = createFileStore(join(root, "uploads"));
    const info = await store.importFile(original);
    expect(info).toMatchObject({ name: "Take Rates.CSV", mimeType: "text/csv", sizeBytes: 8 });
    expect(info.id).toMatch(/^file_[a-z0-9]{16}$/);
    const file = await store.get(info.id);
    expect(Buffer.from(file.bytes).toString()).toBe("a;b\n1;2\n");
    expect(await store.info(info.id)).toEqual(info);
    writeFileSync(original, "changed"); // the store keeps its own copy
    expect(Buffer.from((await store.get(info.id)).bytes).toString()).toBe("a;b\n1;2\n");
  });

  it("rejects crafted ids and missing files with a clear message", async () => {
    const store = createFileStore(join(root, "uploads"));
    await expect(store.get("../../etc/passwd")).rejects.toThrow(/not a valid file id/);
    await expect(store.get("file_0000000000000000")).rejects.toThrow(/isn't in the store/);
    await expect(store.importFile(join(root, "missing.csv"))).rejects.toThrow();
    expect(() => readFileSync(join(root, "uploads", "file_0000000000000000.json"))).toThrow();
  });

  it("removes a stored copy and its metadata, and only by a valid id", async () => {
    const original = join(root, "remove-me.csv");
    writeFileSync(original, "x\n1\n");
    const store = createFileStore(join(root, "removal"));
    const info = await store.importFile(original);
    expect(readdirSync(join(root, "removal"))).toHaveLength(2);
    await store.remove(info.id);
    expect(readdirSync(join(root, "removal"))).toHaveLength(0);
    await expect(store.get(info.id)).rejects.toThrow(/isn't in the store/);
    await expect(store.remove(info.id)).resolves.toBeUndefined(); // already gone: fine
    await expect(store.remove("../removal")).rejects.toThrow(/not a valid file id/);
    expect(readFileSync(original, "utf8")).toBe("x\n1\n"); // the original is untouched
  });
});
