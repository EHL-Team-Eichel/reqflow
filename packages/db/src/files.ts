import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type FileStore, type StoredFile, type StoredFileInfo, newId } from "@reqflow/core";

export class SqliteFileStore implements FileStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly uploadDir: string,
  ) {
    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true });
    }
  }

  async get(fileId: string): Promise<StoredFile> {
    const stmt = this.db.prepare(
      "SELECT id, name, mime_type, relative_path FROM files WHERE id = ?",
    );
    const row = stmt.get(fileId) as
      { id: string; name: string; mime_type: string; relative_path: string } | undefined;

    if (!row) {
      throw new Error(`File not found: ${fileId}`);
    }

    const fullPath = join(this.uploadDir, row.relative_path);
    const buffer = await readFile(fullPath);

    return {
      id: row.id,
      name: row.name,
      mimeType: row.mime_type,
      bytes: new Uint8Array(buffer),
    };
  }

  async save(name: string, mimeType: string, bytes: Uint8Array): Promise<StoredFileInfo> {
    const id = newId("file");
    const sanitizedName = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
    const relativePath = `${id}_${sanitizedName}`;
    const fullPath = join(this.uploadDir, relativePath);

    await writeFile(fullPath, bytes);

    const importedAt = new Date().toISOString();
    const sizeBytes = bytes.byteLength;

    const stmt = this.db.prepare(`
      INSERT INTO files (id, name, mime_type, size_bytes, imported_at, relative_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, name, mimeType, sizeBytes, importedAt, relativePath);

    return {
      id,
      name,
      mimeType,
      sizeBytes,
      importedAt,
    };
  }

  async list(): Promise<StoredFileInfo[]> {
    const stmt = this.db.prepare(`
      SELECT id, name, mime_type, size_bytes, imported_at FROM files ORDER BY imported_at DESC
    `);
    const rows = stmt.all() as Array<{
      id: string;
      name: string;
      mime_type: string;
      size_bytes: number;
      imported_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      importedAt: r.imported_at,
    }));
  }
}
