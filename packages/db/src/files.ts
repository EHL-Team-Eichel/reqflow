import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { FileStore, StoredFile } from "@reqflow/core";
import type { StoredFileInfo } from "@reqflow/core/ipc";

/** Uploads larger than this are refused (BMW exports are spreadsheets, not media). */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const ID = /^file_[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

const MIME: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export interface LocalFileStore extends FileStore {
  /** Copies a file into the store and returns its info. The original is left untouched. */
  importFile(path: string): Promise<StoredFileInfo>;
  info(fileId: string): Promise<StoredFileInfo>;
  /** Trusted main-process path for local parsers. Never exposed over IPC. */
  resolvePath(fileId: string): Promise<{ path: string; name: string }>;
  /** Migration only: copy a trusted legacy original, preserving references and metadata. */
  importLegacyFile(path: string, info: StoredFileInfo): Promise<void>;
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
      const metadata = await lstat(metaPath(fileId));
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024)
        throw new Error("unsafe metadata");
      const raw = JSON.parse(await readFile(metaPath(fileId), "utf8"));
      const meta = z
        .object({
          id: z.literal(fileId),
          name: z.string().min(1),
          mimeType: z.string().min(1),
          sizeBytes: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
          importedAt: z.iso.datetime(),
          stored: z
            .string()
            .refine(
              (name) =>
                basename(name) === name &&
                !/[\\/]/.test(name) &&
                (name === `${fileId}${extname(name)}` ||
                  (name.startsWith(`${fileId}.migrated-`) &&
                    /^[a-f0-9]{32}$/.test(
                      name.slice(`${fileId}.migrated-`.length, -extname(name).length),
                    ))) &&
                /^\.[a-z0-9]{1,10}$/.test(extname(name)),
            ),
        })
        .parse(raw);
      return meta;
    } catch {
      throw new Error(
        `File ${fileId} isn't in the store or has corrupt metadata. Choose the file again.`,
      );
    }
  };

  const resolvePath = async (fileId: string) => {
    const meta = await info(fileId);
    const path = resolve(dir, meta.stored);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_UPLOAD_BYTES)
      throw new Error(`Corrupt metadata or unsafe stored file for ${fileId}`);
    const actual = await realpath(path);
    const inside = relative(await realpath(dir), actual);
    if (inside.startsWith("..") || inside.includes("/") || inside.includes("\\"))
      throw new Error(`Unsafe stored path for ${fileId}`);
    return { path: actual, name: meta.name };
  };

  return {
    resolvePath,
    async importLegacyFile(path, fileInfo) {
      checkId(fileInfo.id);
      try {
        await resolvePath(fileInfo.id); // Existing valid authoritative imports always win.
        return;
      } catch {
        try {
          await lstat(metaPath(fileInfo.id));
          throw new Error("Corrupt existing import metadata");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const original = await lstat(path);
      if (!original.isFile() || original.isSymbolicLink()) throw new Error("Unsafe legacy file");
      if (original.size !== fileInfo.sizeBytes || fileInfo.sizeBytes > MAX_UPLOAD_BYTES)
        throw new Error("Legacy imported file size does not match metadata");
      const ext = extname(path).toLowerCase();
      if (!MIME[ext]) throw new Error("Unsupported legacy imported document");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // Legacy originals already live in uploads. A distinct copy is essential: future
      // removal/replacement of an authoritative import must never delete an original.
      const suffix = randomUUID().replace(/-/g, "");
      const stored = `${fileInfo.id}.migrated-${suffix}${ext}`;
      const temp = join(dir, `.migration-${suffix}.tmp`);
      let published = false;
      try {
        await copyFile(path, join(dir, stored), constants.COPYFILE_EXCL);
        await chmod(join(dir, stored), 0o600);
        await writeFile(temp, JSON.stringify({ ...fileInfo, stored }), { mode: 0o600, flag: "wx" });
        // Publish exclusively; concurrent retries cannot overwrite a winning import.
        await link(temp, metaPath(fileInfo.id));
        published = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await resolvePath(fileInfo.id); // Only a valid existing destination wins a conflict.
      } finally {
        await rm(temp, { force: true });
        if (!published) await rm(join(dir, stored), { force: true });
      }
    },
    async importFile(path) {
      const original = await stat(path);
      if (!original.isFile()) throw new Error("Choose a regular file to import");
      const size = original.size;
      if (size > MAX_UPLOAD_BYTES) {
        throw new Error(
          `"${basename(path)}" is ${Math.round(size / 1e6)} MB; the limit is ${MAX_UPLOAD_BYTES / 1e6} MB`,
        );
      }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const ext = extname(path).toLowerCase();
      if (!MIME[ext]) throw new Error("Choose a CSV, XLSX, TXT, PDF, DOCX or PPTX file");
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
        await chmod(join(dir, stored), 0o600);
        await writeFile(metaPath(id), JSON.stringify({ ...fileInfo, stored }, null, 2), {
          mode: 0o600,
        });
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
      const trusted = await resolvePath(fileId);
      const bytes = new Uint8Array(await readFile(trusted.path));
      return { id: meta.id, name: meta.name, mimeType: meta.mimeType, bytes };
    },
  };
}
