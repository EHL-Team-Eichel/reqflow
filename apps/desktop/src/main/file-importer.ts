import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";
import { newId, type StoredFileInfo } from "@reqflow/core";

export function getUploadsDir(dataDir: string): string {
  return join(dataDir, "uploads");
}

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".csv":
      return "text/csv";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".md":
      return "text/markdown";
    default:
      return "application/octet-stream";
  }
}

export async function importFileFromPath(
  dataDir: string,
  sourcePath: string,
): Promise<StoredFileInfo> {
  const uploadsDir = getUploadsDir(dataDir);
  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
  }

  const fileId = newId("file");
  const originalName = basename(sourcePath);
  const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const targetPath = join(uploadsDir, `${fileId}_${sanitized}`);

  copyFileSync(sourcePath, targetPath);
  const stats = statSync(targetPath);

  return {
    id: fileId,
    name: originalName,
    mimeType: getMimeType(originalName),
    sizeBytes: stats.size,
    importedAt: new Date().toISOString(),
  };
}

export async function handleFileImport(
  dataDir: string,
  openDialog?: (opts: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
): Promise<StoredFileInfo | null> {
  let res: OpenDialogReturnValue;
  if (openDialog) {
    res = await openDialog({
      title: "Import BMW Dataset or File",
      properties: ["openFile"],
      filters: [
        { name: "Datasets", extensions: ["xlsx", "xls", "csv", "json", "pdf", "md"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
  } else {
    try {
      const electron = await import("electron");
      res = await electron.dialog.showOpenDialog({
        title: "Import BMW Dataset or File",
        properties: ["openFile"],
        filters: [
          { name: "Datasets", extensions: ["xlsx", "xls", "csv", "json", "pdf", "md"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
    } catch {
      return null;
    }
  }

  if (res.canceled || !res.filePaths || res.filePaths.length === 0 || !res.filePaths[0]) {
    return null;
  }

  return await importFileFromPath(dataDir, res.filePaths[0]);
}
