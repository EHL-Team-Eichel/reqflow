import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
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

describe("trusted main-only document paths", () => {
  it("copies legacy uploads even in the same directory; retries/removal never touch originals", async () => {
    const dir = join(root, "legacy-originals");
    mkdirSync(dir);
    const store = createFileStore(dir);
    const original = join(dir, "file_legacy.txt");
    writeFileSync(original, "synthetic legacy");
    const info = {
      id: "file_legacy",
      name: "legacy.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength("synthetic legacy"),
      importedAt: "2026-10-10T00:00:00.000Z",
    };
    await Promise.all([
      store.importLegacyFile(original, info),
      store.importLegacyFile(original, info),
    ]);
    const copy = (await store.resolvePath(info.id)).path;
    expect(copy).not.toBe(realpathSync(original));
    expect(readdirSync(dir)).toHaveLength(3); // original, exactly one copy, one metadata
    writeFileSync(original, "changed original");
    await store.importLegacyFile(original, info); // existing authoritative import wins
    expect(Buffer.from((await store.get(info.id)).bytes).toString()).toBe("synthetic legacy");
    await store.remove(info.id);
    expect(readdirSync(dir)).toEqual(["file_legacy.txt"]);
    expect(readFileSync(original, "utf8")).toBe("changed original");
  });
  it("rejects legacy/document symlinks and corrupt metadata without overwriting originals", async () => {
    const dir = join(root, "legacy-security");
    mkdirSync(dir);
    const store = createFileStore(dir);
    const original = join(root, "security-original.txt");
    writeFileSync(original, "synthetic");
    const info = {
      id: "file_security",
      name: "legacy.txt",
      mimeType: "text/plain",
      sizeBytes: 9,
      importedAt: "2026-10-10T00:00:00.000Z",
    };
    symlinkSync(original, join(dir, "file_security.txt"));
    await expect(store.importLegacyFile(join(dir, "file_security.txt"), info)).rejects.toThrow(
      /unsafe/i,
    );
    writeFileSync(join(dir, `${info.id}.json`), "corrupt metadata");
    await expect(store.importLegacyFile(original, info)).rejects.toThrow(/metadata/i);
    expect(readFileSync(join(dir, `${info.id}.json`), "utf8")).toBe("corrupt metadata");
    const imported = await store.importFile(original);
    rmSync(join(dir, `${imported.id}.txt`));
    symlinkSync(original, join(dir, `${imported.id}.txt`));
    await expect(store.resolvePath(imported.id)).rejects.toThrow(/unsafe/i);
    expect(readFileSync(original, "utf8")).toBe("synthetic");
  });
  it("resolves TXT/PDF/DOCX/PPTX while preserving CSV/XLSX MIME metadata", async () => {
    const store = createFileStore(join(root, "documents"));
    for (const [ext, mimeType] of [
      ["txt", "text/plain"],
      ["pdf", "application/pdf"],
      ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ]) {
      const path = join(root, `synthetic.${ext}`);
      writeFileSync(path, "synthetic original");
      const info = await store.importFile(path);
      const resolved = await store.resolvePath(info.id);
      expect(resolved.name).toBe(info.name);
      expect(resolved.path).toBe(realpathSync(join(root, "documents", `${info.id}.${ext}`)));
      expect(info.mimeType).toBe(mimeType);
    }
  });
  it("rejects metadata traversal and identifiers before returning any trusted path", async () => {
    const dir = join(root, "unsafe-documents");
    const store = createFileStore(dir);
    const path = join(root, "unsafe.txt");
    writeFileSync(path, "synthetic");
    const info = await store.importFile(path);
    writeFileSync(
      join(dir, `${info.id}.json`),
      JSON.stringify({ ...info, stored: "../unsafe.txt" }),
    );
    await expect(store.resolvePath(info.id)).rejects.toThrow(/metadata/i);
    await expect(store.resolvePath("file_../../unsafe")).rejects.toThrow(/file id/i);
  });
});
