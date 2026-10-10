import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { FileStore, StoredFile } from "@reqflow/core";
import type { StoredFileInfo } from "@reqflow/core/ipc";

/** Uploads larger than this are refused (BMW exports are spreadsheets, not media). */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const ID = /^file_[a-z0-9]{16}$/;

const MIME: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
};

export interface LocalFileStore extends FileStore {
  /** Copies a file into the store and returns its info. The original is left untouched. */
  importFile(path: string): Promise<StoredFileInfo>;
  info(fileId: string): Promise<StoredFileInfo>;
  /** Deletes the stored copy and its metadata. A file that isn't there is not an error. */
  remove(fileId: string): Promise<void>;
}

/**
 * Imported files live in `<dir>/<id><ext>` with metadata in `<id>.json`. Ids are validated before
 * any path is built from them, so a crafted id can't read outside the store.
 */
export function createFileStore(dir: string): LocalFileStore {
  const metaPath = (id: string) => join(dir, `${id}.json`);
  const checkId = (id: string) => {
    if (!ID.test(id)) throw new Error(`"${id}" is not a valid file id`);
  };

  const info = async (fileId: string): Promise<StoredFileInfo & { stored: string }> => {
    checkId(fileId);
    try {
      return JSON.parse(await readFile(metaPath(fileId), "utf8"));
    } catch {
      throw new Error(
        `File ${fileId} isn't in the store (was it deleted?). Choose the file again.`,
      );
    }
  };

  return {
    async importFile(path) {
      const size = (await stat(path)).size;
      if (size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `"${basename(path)}" is ${Math.round(size / 1e6)} MB; the limit is ${MAX_UPLOAD_BYTES / 1e6} MB`,
        );
      }
      await mkdir(dir, { recursive: true });
      const id = `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const ext = extname(path).toLowerCase();
      const stored = `${id}${ext}`;
      const fileInfo: StoredFileInfo = {
        id,
        name: basename(path),
        mimeType: MIME[ext] ?? "application/octet-stream",
        sizeBytes: size,
        importedAt: new Date().toISOString(),
      };
      await copyFile(path, join(dir, stored));
      try {
        await writeFile(metaPath(id), JSON.stringify({ ...fileInfo, stored }, null, 2));
      } catch (err) {
        await rm(join(dir, stored), { force: true }); // no orphan without metadata
        throw err;
      }
      return fileInfo;
    },

    async info(fileId) {
      const { stored: _stored, ...rest } = await info(fileId);
      return rest;
    },

    async remove(fileId) {
      checkId(fileId);
      let stored: string | null = null;
      try {
        stored = (await info(fileId)).stored;
      } catch {
        // no metadata: nothing to delete
      }
      if (stored && basename(stored) === stored) await rm(join(dir, stored), { force: true });
      await rm(metaPath(fileId), { force: true });
    },

    async get(fileId): Promise<StoredFile> {
      const meta = await info(fileId);
      if (basename(meta.stored) !== meta.stored) throw new Error(`Corrupt metadata for ${fileId}`);
      const bytes = new Uint8Array(await readFile(join(dir, meta.stored)));
      return { id: meta.id, name: meta.name, mimeType: meta.mimeType, bytes };
    },
  };
}
