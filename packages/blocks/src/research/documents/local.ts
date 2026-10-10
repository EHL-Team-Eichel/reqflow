import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { setImmediate } from "node:timers/promises";
import type ExcelJS from "exceljs";
import { CollectedItem, type ConnectionReport, type RawTable } from "@reqflow/core";
import { z } from "zod";
import { ProviderError, type ProviderContext } from "../provider";
import {
  parseXlsx,
  validateXlsxZip,
  XlsxLimitError,
  XLSX_LIMITS,
  type XlsxWorkbook,
} from "./xlsx-worker";

export interface LocalDocumentReaderOptions {
  resolveFile: (id: string) => Promise<{ path: string; name: string }>;
  /** A trusted main-process executable, not a shell command or renderer setting. */
  doclingCommand?: string;
  /** Absolute path to the trusted bundled research-xlsx-worker.js entry, outside ASAR. */
  xlsxWorkerPath?: string;
}
type CellValue = string | number | boolean | null;
const FILE_ID = /^file_[A-Za-z0-9_-]+$/;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 512;
const MAX_HEADER_CODE_UNITS = 16_384;
const MAX_WORKSHEET_HEADER_BYTES = 128 * 1024;
const TIMEOUT_MS = 120_000;
const XLSX_TIMEOUT_MS = 30_000;
const UNSUPPORTED = "Docling local runtime/models unavailable or incompatible; no cloud fallback.";
const COMPLEX_FORMATS = new Set([".pdf", ".docx", ".pptx"]);

function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw new ProviderError("cancelled", "Local document read cancelled.");
}
function base(fileId: string) {
  return {
    provider: "local_documents" as const,
    sourceId: fileId,
    sourceUrl: `reqflow-file:///${fileId}`,
    sourceTitle: fileId,
    sourceKind: "other_web" as const,
  };
}
function artifact(fileId: string) {
  return { originalArtifact: { fileId } };
}
function textTable(table: z.infer<typeof RawTable>) {
  return [
    table.headers.join("\t"),
    ...table.rows.map((row) =>
      row.map((value) => (value === null ? "null" : String(value))).join("\t"),
    ),
  ].join("\n");
}
function units(headers: string[], rows: CellValue[][]): string[] {
  const result = new Set<string>();
  // Only explicitly unit-marked header text or dedicated unit columns; never guess from magnitude.
  for (const [column, header] of headers.entries()) {
    const match =
      /\[([^\]]+)\]/.exec(header) ||
      /\((%|kWh|Wh|MWh|km|m|mm|cm|kg|g|s|ms|h|L|l|EUR|USD|vehicles|units|persons)\)/i.exec(header);
    if (match?.[1]) result.add(match[1]);
    if (/^(unit|units|unit of measure|einheit)$/i.test(header.trim())) {
      for (const row of rows)
        if (typeof row[column] === "string" && row[column]) result.add(row[column] as string);
    }
  }
  return [...result];
}
function scalar(value: ExcelJS.CellValue): CellValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new ProviderError("unsupported", "Non-finite XLSX cell value.");
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if ("formula" in value || "sharedFormula" in value) return scalar(value.result ?? null);
  if ("richText" in value) return value.richText.map((run) => run.text).join("");
  if ("hyperlink" in value) return value.text;
  if ("error" in value) return value.error;
  throw new ProviderError("unsupported", "Unsupported XLSX cell type.");
}
function checkHeaderLength(length: number) {
  if (length > MAX_HEADER_CODE_UNITS)
    throw new ProviderError("limit_reached", "XLSX header length exceeds 16384 UTF-16 code units.");
}
function headerText(value: ExcelJS.CellValue): string {
  // Check raw strings/runs before scalar conversion can join or normalize large header text.
  if (typeof value === "string") checkHeaderLength(value.length);
  if (value && typeof value === "object" && "richText" in value) {
    let length = 0;
    for (const run of value.richText) {
      length += run.text.length;
      checkHeaderLength(length);
    }
  }
  const original = scalar(value);
  const text = original === null ? "" : typeof original === "string" ? original : String(original);
  checkHeaderLength(text.length);
  return text;
}
function noteText(note: ExcelJS.Comment | string | undefined): string | undefined {
  if (!note) return undefined;
  return typeof note === "string" ? note : note.texts?.map((run) => run.text).join("");
}
function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function column(headers: string[], aliases: string[]) {
  return headers.findIndex((header) => aliases.includes(normalized(header)));
}

function xlsxError(reason: unknown): ProviderError {
  if (reason === "zip64")
    return new ProviderError("unsupported", "XLSX Zip64 archive unsupported.");
  if (reason === "expanded")
    return new ProviderError(
      "limit_reached",
      "XLSX expanded ZIP data exceeds declared/local bounds.",
    );
  if (reason === "dimensions")
    return new ProviderError(
      "limit_reached",
      "XLSX aggregate cell budget or row/column limits exceeded.",
    );
  if (reason === "output")
    return new ProviderError("limit_reached", "XLSX parsed data exceeds local output budget.");
  if (reason === "zip")
    return new ProviderError(
      "unsupported",
      "XLSX ZIP archive unsupported or exceeds compressed/archive entry limits.",
    );
  return new ProviderError("unsupported", "XLSX worker failed or exceeded its memory limit.");
}
const WorkbookData = z.object({
  sheets: z
    .array(
      z.object({
        id: z.number().int().positive(),
        name: z.string().max(1024),
        rowCount: z.number().int().nonnegative().max(XLSX_LIMITS.rows),
        columnCount: z.number().int().nonnegative().max(XLSX_LIMITS.columns),
        rows: z
          .array(
            z.object({
              number: z.number().int().positive().max(XLSX_LIMITS.rows),
              cells: z
                .array(
                  z.object({
                    column: z.number().int().positive().max(XLSX_LIMITS.columns),
                    address: z.string().max(20),
                    value: z.custom<ExcelJS.CellValue>(() => true),
                    note: z.custom<ExcelJS.Comment | string>(() => true).optional(),
                    numFmt: z.string().optional(),
                  }),
                )
                .max(XLSX_LIMITS.columns),
            }),
          )
          .max(XLSX_LIMITS.rows),
      }),
    )
    .max(XLSX_LIMITS.entries),
});
function validateWorkbook(data: unknown): XlsxWorkbook {
  const workbook = WorkbookData.parse(data);
  let budget = 0,
    outputBytes = 0;
  for (const sheet of workbook.sheets) {
    budget += sheet.rowCount * sheet.columnCount;
    if (budget > XLSX_LIMITS.cells) throw xlsxError("dimensions");
    const numbers = new Set<number>();
    for (const row of sheet.rows) {
      if (row.number > sheet.rowCount || numbers.has(row.number)) throw xlsxError("dimensions");
      numbers.add(row.number);
      const columns = new Set<number>();
      for (const cell of row.cells) {
        if (
          cell.column > sheet.columnCount ||
          columns.has(cell.column) ||
          cell.address !== cellAddress(cell.column, row.number)
        )
          throw xlsxError("dimensions");
        columns.add(cell.column);
        outputBytes += Buffer.byteLength(JSON.stringify(cell));
        if (outputBytes > XLSX_LIMITS.outputBytes) throw xlsxError("output");
      }
    }
    sheet.rows.sort((a, b) => a.number - b.number);
  }
  return workbook;
}
function cellAddress(column: number, row: number): string {
  let code = "";
  while (column) {
    column--;
    code = String.fromCharCode(65 + (column % 26)) + code;
    column = Math.floor(column / 26);
  }
  return `${code}${row}`;
}
async function loadXlsx(
  bytes: Buffer,
  signal: AbortSignal,
  workerPath?: string,
): Promise<XlsxWorkbook> {
  cancelled(signal);
  try {
    validateXlsxZip(bytes);
  } catch (error) {
    if (error instanceof XlsxLimitError) throw xlsxError(error.reason);
    throw xlsxError("zip");
  }
  if (!workerPath) {
    try {
      return validateWorkbook(await parseXlsx(bytes, () => cancelled(signal)));
    } catch (error) {
      if (error instanceof XlsxLimitError) throw xlsxError(error.reason);
      throw error;
    }
  }
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerPath, {
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        env: {},
        execArgv: [],
        workerData: { reqflowXlsxWorker: true },
        stdout: true,
        stderr: true,
      });
    } catch {
      reject(xlsxError("parse"));
      return;
    }
    // A parser must never print document content, environment values or runtime paths.
    worker.stdout?.resume();
    worker.stderr?.resume();
    let settled = false;
    const finish = (error?: ProviderError, workbook?: XlsxWorkbook) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      void worker.terminate().then(
        () => (error ? reject(error) : resolve(workbook!)),
        () => reject(xlsxError("parse")),
      );
    };
    const onAbort = () => finish(new ProviderError("cancelled", "Local XLSX read cancelled."));
    const timer = setTimeout(
      () => finish(new ProviderError("limit_reached", "Local XLSX worker timed out.")),
      XLSX_TIMEOUT_MS,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("error", () => finish(xlsxError("parse")));
    worker.once("exit", () => {
      if (!settled) finish(xlsxError("parse"));
    });
    worker.once("message", (reply: unknown) => {
      if (settled) return;
      try {
        cancelled(signal);
        const message = z
          .object({
            ok: z.boolean(),
            workbook: z.unknown().optional(),
            reason: z.unknown().optional(),
          })
          .parse(reply);
        if (!message.ok) {
          finish(xlsxError(message.reason));
          return;
        }
        finish(undefined, validateWorkbook(message.workbook));
      } catch (error) {
        finish(error instanceof ProviderError ? error : xlsxError("parse"));
      }
    });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      const input = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(input).set(bytes);
      worker.postMessage(new Uint8Array(input), [input]);
    } catch {
      finish(xlsxError("parse"));
    }
  });
}

async function xlsx(
  fileId: string,
  filePath: string,
  fileName: string,
  signal: AbortSignal,
  workerPath?: string,
): Promise<CollectedItem[]> {
  const bytes = await readFile(filePath, { signal });
  const workbook = await loadXlsx(bytes, signal, workerPath);
  cancelled(signal);
  const items: CollectedItem[] = [];
  const feedback = new Map<
    string,
    {
      item: CollectedItem;
      rows: CellValue[][];
      sourceRows: number[];
      vfc: string[];
      classifications: {
        column: string;
        value: CellValue;
        origin: "source_explicit";
        locator: string;
      }[];
    }
  >();
  const idTexts = new Map<string, Set<string>>();
  for (const sheet of workbook.sheets) {
    cancelled(signal);
    if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLUMNS)
      throw new ProviderError("limit_reached", "XLSX sheet exceeds local row/column limits.");
    const existingRows = new Map(sheet.rows.map((row) => [row.number, row.cells]));
    const headerRow =
      sheet.rows.find((row) =>
        row.cells.some((cell) => cell.value !== null && cell.value !== undefined),
      )?.number ?? 0;
    const width = sheet.columnCount;
    const headerCells = new Map(
      (existingRows.get(headerRow) ?? []).map((cell) => [cell.column, cell]),
    );
    // Exact serialized UTF-8 size of the header array, including brackets, commas and escaping.
    let headerBytes = 2 + Math.max(0, width - 1);
    const headers = Array.from({ length: width }, (_, i) => {
      const header = headerText(headerCells.get(i + 1)?.value ?? null);
      headerBytes += Buffer.byteLength(JSON.stringify(header), "utf8");
      if (headerBytes > MAX_WORKSHEET_HEADER_BYTES)
        throw new ProviderError(
          "limit_reached",
          "XLSX worksheet headers exceed 128 KiB serialized UTF-8 budget.",
        );
      return header;
    });
    const rows: CellValue[][] = [],
      sourceRows: number[] = [],
      footnotes: string[] = [];
    const cellArtifacts: { address: string; value: unknown; note?: unknown; numFmt?: string }[] =
      [];
    for (let row = headerRow || 1; row <= sheet.rowCount; row++) {
      if (row % 128 === 0) {
        await setImmediate();
        cancelled(signal);
      }
      const values = Array<CellValue>(width).fill(null);
      for (const cell of existingRows.get(row) ?? []) {
        const note = noteText(cell.note);
        if (note) footnotes.push(note);
        if (
          (cell.value && typeof cell.value === "object") ||
          cell.note ||
          (cell.numFmt && cell.numFmt !== "General")
        ) {
          cellArtifacts.push({
            address: cell.address,
            value: cell.value,
            note: cell.note,
            numFmt: cell.numFmt,
          });
        }
        values[cell.column - 1] = scalar(cell.value);
      }
      if (row > headerRow) {
        rows.push(values);
        sourceRows.push(row);
      }
    }
    const table = {
      headers,
      rows,
      units: units(headers, rows),
      footnotes,
      dimensions: { sheet: sheet.name, headerRow, sourceRows },
    };
    const special =
      normalized(sheet.name) === "feedbackexplorer" ||
      (workbook.sheets.length === 1 &&
        normalized(path.parse(fileName).name) === "feedbackexplorer");
    if (!special) {
      items.push(
        CollectedItem.parse({
          ...base(fileId),
          recordId: `${fileId}:sheet:${sheet.id}`,
          recordType: "table",
          text: textTable(table),
          locator: `${sheet.name}!rows ${headerRow}-${sheet.rowCount}`,
          table,
          metadata: {
            ...artifact(fileId),
            sheet: sheet.name,
            sheetId: sheet.id,
            headerRow,
            sourceRows,
            cellArtifacts,
          },
          limitations: [
            "XLSX first nonempty row is preserved as header; no semantic classification inferred. Formulas use saved results only, never evaluated. maxPages does not truncate spreadsheet sheets.",
          ],
        }),
      );
      continue;
    }
    const idColumn = column(headers, ["id", "feedbackid", "commentid", "responseid"]);
    const textColumn = column(headers, [
      "text",
      "feedback",
      "feedbacktext",
      "customerfeedback",
      "verbatim",
      "comment",
      "commenttext",
    ]);
    const vfcColumns = headers
      .map((header, i) => (normalized(header).startsWith("vfc") ? i : -1))
      .filter((i) => i >= 0);
    if (idColumn < 0 || textColumn < 0 || !vfcColumns.length)
      throw new ProviderError(
        "unsupported",
        "Feedback_Explorer requires explicit ID, text and VFC headers.",
      );
    const classificationColumns = headers
      .map((header, i) =>
        /^(sentiment|classification|category|topic|kano|feedbacktype)/.test(normalized(header))
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    const artifactsByRow = new Map<number, typeof cellArtifacts>();
    for (const cell of cellArtifacts) {
      const number = Number(cell.address.replace(/^[A-Z]+/, ""));
      const existing = artifactsByRow.get(number) ?? [];
      existing.push(cell);
      artifactsByRow.set(number, existing);
    }
    const marketColumn = column(headers, ["market", "country", "geography"]),
      vehicleColumn = column(headers, ["vehicle", "model", "vehicleline"]);
    for (const [index, row] of rows.entries()) {
      if (index % 128 === 0) {
        await setImmediate();
        cancelled(signal);
      }
      if (row.every((value) => value === null)) continue;
      const id = row[idColumn],
        text = row[textColumn],
        rowNumber = sourceRows[index]!;
      if (id === null || id === undefined || typeof text !== "string" || !text.length)
        throw new ProviderError(
          "unsupported",
          "Feedback_Explorer row requires ID and source text.",
        );
      const key = JSON.stringify([String(id), text]);
      let entry = feedback.get(key);
      const texts = idTexts.get(String(id)) ?? new Set<string>();
      texts.add(text);
      idTexts.set(String(id), texts);
      if (!entry) {
        const explicit = (i: number) =>
          i >= 0 && row[i] !== null && row[i] !== undefined
            ? {
                value: String(row[i]),
                origin: "source_explicit",
                locator: `${sheet.name}!${cellAddress(i + 1, rowNumber)}`,
              }
            : undefined;
        entry = {
          rows: [],
          sourceRows: [],
          vfc: [],
          classifications: [],
          item: CollectedItem.parse({
            ...base(fileId),
            sourceKind: "customer_feedback",
            recordId: `${fileId}:feedback:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
            recordType: "feedback",
            text,
            locator: `${sheet.name}!row ${rowNumber}`,
            market: explicit(marketColumn),
            vehicle: explicit(vehicleColumn),
            metadata: {
              ...artifact(fileId),
              feedbackId: String(id),
              sheet: sheet.name,
              independentOpinionCount: 1,
              cellArtifacts: artifactsByRow.get(headerRow) ?? [],
              sourceAssociations: [],
            },
            table: {
              headers,
              rows: [],
              units: units(headers, [row]),
              footnotes: [],
              dimensions: { sheet: sheet.name, headerRow, sourceRows: [] },
            },
            limitations: [
              "Feedback classifications and VFC associations are source-supplied, not independent opinions or model inferences.",
            ],
          }),
        };
        feedback.set(key, entry);
      }
      const associations = entry.item.metadata.sourceAssociations as unknown[];
      associations.push({ sheet: sheet.name, row: rowNumber, headers, values: row });
      const rowArtifacts = artifactsByRow.get(rowNumber) ?? [];
      (entry.item.metadata.cellArtifacts as unknown[]).push(
        ...rowArtifacts.map((cell) => ({ sheet: sheet.name, ...cell })),
      );
      if (entry.item.table) {
        for (const cell of rowArtifacts) {
          const note = noteText(cell.note as ExcelJS.Comment | string | undefined);
          if (note) entry.item.table.footnotes.push(note);
        }
      }
      for (const [attribute, i] of [
        ["market", marketColumn],
        ["vehicle", vehicleColumn],
      ] as const) {
        if (
          entry.item[attribute] &&
          i >= 0 &&
          row[i] !== null &&
          row[i] !== undefined &&
          entry.item[attribute]?.value !== String(row[i])
        ) {
          entry.item[attribute] = undefined;
          entry.item.limitations.push(
            `Conflicting source-explicit ${attribute} values across feedback associations; no single attribution retained.`,
          );
        }
      }
      if (
        entry.item.table &&
        JSON.stringify(entry.item.table.headers) !== JSON.stringify(headers)
      ) {
        // Preserve heterogeneous associations as original structured rows, never under wrong headers.
        entry.item.table = undefined;
        entry.item.limitations.push(
          "Feedback associations span different sheet headers; consult sourceAssociations for original rows.",
        );
      }
      entry.rows.push(row);
      entry.sourceRows.push(rowNumber);
      for (const i of vfcColumns)
        if (row[i] !== null && row[i] !== undefined && !entry.vfc.includes(String(row[i])))
          entry.vfc.push(String(row[i]));
      for (const i of classificationColumns)
        if (row[i] !== null && row[i] !== undefined)
          entry.classifications.push({
            column: headers[i]!,
            value: row[i]!,
            origin: "source_explicit",
            locator: `${sheet.name}!${cellAddress(i + 1, rowNumber)}`,
          });
    }
  }
  for (const entry of feedback.values()) {
    if ((idTexts.get(String(entry.item.metadata.feedbackId))?.size ?? 0) > 1)
      entry.item.limitations.push(
        "Same feedback ID has different texts; conflicting source texts are kept separately.",
      );
    entry.item.metadata.sourceRows = entry.sourceRows;
    entry.item.metadata.vfcAssociations = entry.vfc;
    entry.item.metadata.classifications = entry.classifications;
    if (entry.item.table) {
      entry.item.table.rows = entry.rows;
      entry.item.table.dimensions = {
        sheet: entry.item.metadata.sheet,
        sourceRows: entry.sourceRows,
      };
    }
    items.push(CollectedItem.parse(entry.item));
  }
  return items;
}

function localEnvironment(): NodeJS.ProcessEnv {
  // Do not leak provider credentials to parsers. No shell, remote service, plugins or model download.
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TMP",
    "TEMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "VIRTUAL_ENV",
    "PYTHONHOME",
    "DOCLING_ARTIFACTS_PATH",
    "TESSDATA_PREFIX",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_DATASETS_OFFLINE: "1",
    DOCLING_ENABLE_REMOTE_SERVICES: "false",
  };
}
async function execute(
  command: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
  cwd?: string,
): Promise<string> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      cwd,
      env: localEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      bytes = 0,
      error: ProviderError | undefined;
    const stop = (reason: ProviderError) => {
      error ??= reason;
      child.kill("SIGKILL");
    };
    const onAbort = () =>
      stop(new ProviderError("cancelled", "Local document conversion cancelled."));
    const timer = setTimeout(
      () => stop(new ProviderError("limit_reached", "Local document conversion timed out.")),
      timeoutMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024)
        stop(new ProviderError("limit_reached", "Local parser output exceeds limit."));
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024)
        stop(new ProviderError("limit_reached", "Local parser output exceeds limit."));
    });
    const clean = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    child.once("error", () => {
      clean();
      reject(error ?? new ProviderError("unsupported", UNSUPPORTED));
    });
    child.once("close", (code) => {
      clean();
      if (error) reject(error);
      else if (code !== 0)
        reject(
          new ProviderError(
            "unsupported",
            "Docling local conversion failed; check packaged models. No cloud fallback.",
          ),
        );
      else resolve(stdout);
    });
  });
}
interface Runtime {
  prefix: string[];
  artifactsPath?: string;
  available: boolean;
}
async function detect(command: string): Promise<Runtime> {
  try {
    const signal = new AbortController().signal;
    const topHelp = await execute(command, ["--help"], signal, 5000);
    const prefix = /\bconvert\b/.test(topHelp) && /COMMAND/.test(topHelp) ? ["convert"] : [];
    const help = prefix.length
      ? await execute(command, [...prefix, "--help"], signal, 5000)
      : topHelp;
    if (
      ![
        "--to",
        "--output",
        "--page-range",
        "--document-timeout",
        "--enable-remote-services",
        "--allow-external-plugins",
        "--artifacts-path",
        "--ocr",
        "--image-export-mode",
        "--abort-on-error",
      ].every((flag) => help.includes(flag))
    )
      return { prefix, available: false };
    const artifactsPath = process.env.DOCLING_ARTIFACTS_PATH;
    if (
      !artifactsPath ||
      !path.isAbsolute(artifactsPath) ||
      !(await lstat(artifactsPath)).isDirectory()
    )
      return { prefix, available: false };
    return { prefix, artifactsPath, available: true };
  } catch {
    return { prefix: [], available: false };
  }
}

const Provenance = z.object({ page_no: z.number().int().positive().optional() }).passthrough();
const Text = z
  .object({
    self_ref: z.string(),
    text: z.string().optional(),
    orig: z.string().optional(),
    label: z.string().optional(),
    prov: z.array(Provenance).optional(),
  })
  .passthrough();
const Ref = z.object({ $ref: z.string() });
const Table = z
  .object({
    self_ref: z.string(),
    prov: z.array(Provenance).optional(),
    captions: z.array(Ref).optional(),
    footnotes: z.array(Ref).optional(),
    data: z
      .object({
        num_rows: z.number().int().nonnegative().max(MAX_ROWS),
        num_cols: z.number().int().nonnegative().max(MAX_COLUMNS),
        table_cells: z.array(
          z
            .object({
              text: z.string(),
              start_row_offset_idx: z.number().int().nonnegative(),
              start_col_offset_idx: z.number().int().nonnegative(),
              end_row_offset_idx: z.number().int().nonnegative(),
              end_col_offset_idx: z.number().int().nonnegative(),
              column_header: z.boolean().optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();
const Document = z
  .object({
    schema_name: z.literal("DoclingDocument"),
    texts: z.array(Text).default([]),
    tables: z.array(Table).default([]),
  })
  .passthrough();

function doclingRecords(fileId: string, raw: unknown, maxPages: number): CollectedItem[] {
  const doc = Document.parse(raw),
    records: CollectedItem[] = [];
  const limitations = [
    `Docling local extraction is limited to first ${maxPages} pages where supported; complete document coverage is not claimed.`,
    "PDF layout/table extraction may contain errors; verify against original imported artifact. OCR is disabled; scanned PDFs require a separately approved local OCR integration.",
  ];
  const textByRef = new Map(doc.texts.map((text) => [text.self_ref, text.orig ?? text.text ?? ""]));
  const metadata = (ref: string, prov: z.infer<typeof Provenance>[] | undefined) => ({
    ...artifact(fileId),
    doclingRef: ref,
    provenance: prov ?? [],
    parser: "docling",
    maxPages,
  });
  const locator = (ref: string, prov: z.infer<typeof Provenance>[] | undefined) =>
    `${ref}${prov?.length ? `; pages ${[...new Set(prov.map((p) => p.page_no).filter(Boolean))].join(",")}` : ""}`;
  const included = (prov: z.infer<typeof Provenance>[] | undefined) =>
    !prov?.some((p) => p.page_no !== undefined && p.page_no > maxPages);
  for (const text of doc.texts) {
    if (!included(text.prov) || ["caption", "footnote"].includes(text.label || "")) continue;
    const content = text.orig ?? text.text;
    if (!content) continue;
    records.push(
      CollectedItem.parse({
        ...base(fileId),
        recordId: `${fileId}:${text.self_ref}`,
        recordType: "passage",
        text: content,
        locator: locator(text.self_ref, text.prov),
        metadata: metadata(text.self_ref, text.prov),
        limitations,
      }),
    );
  }
  for (const table of doc.tables) {
    if (!included(table.prov)) continue;
    if (table.data.num_rows * table.data.num_cols > 100_000)
      throw new ProviderError("limit_reached", "Docling table exceeds local cell limit.");
    const rows: CellValue[][] = Array.from({ length: table.data.num_rows }, () =>
      Array<CellValue>(table.data.num_cols).fill(null),
    );
    const headerRows = new Set<number>();
    for (const cell of table.data.table_cells) {
      const r = cell.start_row_offset_idx,
        c = cell.start_col_offset_idx;
      if (
        r >= rows.length ||
        c >= table.data.num_cols ||
        cell.end_row_offset_idx <= r ||
        cell.end_col_offset_idx <= c ||
        cell.end_row_offset_idx > rows.length ||
        cell.end_col_offset_idx > table.data.num_cols ||
        rows[r]?.[c] !== null
      )
        throw new ProviderError("unsupported", "Invalid Docling table cell offsets.");
      rows[r]![c] = cell.text;
      if (cell.column_header) headerRows.add(r);
    }
    let headerCount = 0;
    while (headerRows.has(headerCount)) headerCount++;
    const headers = Array.from({ length: table.data.num_cols }, (_, col) =>
      rows
        .slice(0, headerCount)
        .map((row) => row[col])
        .filter((value) => value !== null)
        .join("\n"),
    );
    const bodyRows = rows.slice(headerCount);
    const footnotes = (table.footnotes ?? [])
      .map((ref) => textByRef.get(ref.$ref))
      .filter((text): text is string => text !== undefined);
    const rawTable = { headers, rows: bodyRows, units: units(headers, bodyRows), footnotes };
    records.push(
      CollectedItem.parse({
        ...base(fileId),
        recordId: `${fileId}:${table.self_ref}`,
        recordType: "table",
        text: textTable(rawTable),
        locator: locator(table.self_ref, table.prov),
        table: rawTable,
        metadata: {
          ...metadata(table.self_ref, table.prov),
          cells: table.data.table_cells,
          captions: (table.captions ?? []).map((ref) => ({
            ref: ref.$ref,
            text: textByRef.get(ref.$ref),
          })),
          footnoteRefs: table.footnotes ?? [],
        },
        limitations,
      }),
    );
  }
  return records;
}

/** Main-process reader. Cache reads by imported ID/page limit in the parent run, not in renderer. */
export function createLocalDocumentReader(
  options: LocalDocumentReaderOptions,
): NonNullable<ProviderContext["documents"]> {
  const command = options.doclingCommand ?? "docling";
  if (!command || command.includes("\0"))
    throw new ProviderError("unsupported", "Invalid local parser executable.");
  if (
    options.xlsxWorkerPath !== undefined &&
    (!path.isAbsolute(options.xlsxWorkerPath) || options.xlsxWorkerPath.includes("\0"))
  )
    throw new ProviderError("unsupported", "XLSX worker entry must be a trusted absolute path.");
  let runtime: Promise<Runtime> | undefined;
  const getRuntime = () => (runtime ??= detect(command));
  return {
    async available(): Promise<ConnectionReport> {
      const parser = await getRuntime();
      return {
        state: "success",
        message: "Local TXT/XLSX reader available.",
        capabilities: [
          "txt",
          "xlsx",
          ...(parser.available ? ["docling", "pdf", "docx", "pptx"] : []),
        ],
        limitations: [
          ...(parser.available
            ? [
                "Docling CLI detected; model completeness is checked during conversion. OCR disabled.",
              ]
            : [UNSUPPORTED]),
          "No network/cloud fallback. Docling requires separately packaged Python runtime and local model artifacts.",
        ],
      };
    },
    async read(fileId, maxPages, signal) {
      if (!FILE_ID.test(fileId))
        throw new ProviderError(
          "unsupported",
          "Expected an imported file ID, not a filesystem path.",
        );
      if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500)
        throw new ProviderError("unsupported", "Document page limit must be 1-500.");
      cancelled(signal);
      let temp: string | undefined;
      try {
        const source = await options.resolveFile(fileId);
        cancelled(signal);
        if (!path.isAbsolute(source.path))
          throw new ProviderError(
            "unsupported",
            "Imported file resolver must return an absolute local path.",
          );
        const info = await lstat(source.path);
        if (!info.isFile() || info.isSymbolicLink())
          throw new ProviderError("unsupported", "Imported document must be a regular file.");
        if (info.size > MAX_BYTES)
          throw new ProviderError("limit_reached", "Imported document exceeds local size limit.");
        const extension = path.extname(source.name).toLowerCase();
        if (extension === ".txt") {
          const bytes = await readFile(source.path, { signal });
          cancelled(signal);
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          } catch {
            throw new ProviderError("unsupported", "Plain text documents must use UTF-8 encoding.");
          }
          return [
            CollectedItem.parse({
              ...base(fileId),
              recordId: `${fileId}:text`,
              recordType: "passage",
              text,
              locator: "UTF-8 document",
              metadata: artifact(fileId),
              limitations: [],
            }),
          ];
        }
        if (extension === ".xlsx") {
          if (info.size > XLSX_LIMITS.compressedBytes) throw xlsxError("zip");
          return await xlsx(fileId, source.path, source.name, signal, options.xlsxWorkerPath);
        }
        if (!COMPLEX_FORMATS.has(extension))
          throw new ProviderError(
            "unsupported",
            "Local document format unsupported; supported formats: TXT, XLSX, PDF, DOCX, PPTX. No cloud fallback.",
          );
        const parser = await getRuntime();
        cancelled(signal);
        if (!parser.available || !parser.artifactsPath)
          throw new ProviderError("unsupported", UNSUPPORTED);
        temp = await mkdtemp(path.join(tmpdir(), "reqflow-docling-"));
        await chmod(temp, 0o700);
        const input = path.join(temp, `input${extension}`);
        await copyFile(source.path, input);
        await chmod(input, 0o600);
        cancelled(signal);
        await execute(
          command,
          [
            ...parser.prefix,
            "--to",
            "json",
            "--output",
            temp,
            "--page-range",
            `1-${maxPages}`,
            "--document-timeout",
            String(TIMEOUT_MS / 1000),
            "--artifacts-path",
            parser.artifactsPath,
            "--no-enable-remote-services",
            "--no-allow-external-plugins",
            "--no-ocr",
            "--image-export-mode",
            "placeholder",
            "--abort-on-error",
            input,
          ],
          signal,
          TIMEOUT_MS,
          temp,
        );
        cancelled(signal);
        const output = path.join(temp, "input.json"),
          outputInfo = await lstat(output);
        if (!outputInfo.isFile() || outputInfo.isSymbolicLink() || outputInfo.size > MAX_BYTES)
          throw new ProviderError(
            "unsupported",
            "Docling export is not a bounded regular JSON file.",
          );
        const parsed: unknown = JSON.parse(await readFile(output, { encoding: "utf8", signal }));
        cancelled(signal);
        return doclingRecords(fileId, parsed, maxPages);
      } catch (error) {
        if (signal.aborted) throw new ProviderError("cancelled", "Local document read cancelled.");
        if (error instanceof ProviderError) throw error;
        // Filesystem/parser errors can include confidential paths/content. Never expose them.
        throw new ProviderError(
          "unsupported",
          "Local document read or parser export failed; no cloud fallback.",
        );
      } finally {
        if (temp) {
          try {
            await rm(temp, { recursive: true, force: true });
          } catch {
            throw new ProviderError(
              "unsupported",
              "Local parser temporary artifact cleanup failed.",
            );
          }
        }
      }
    },
  };
}
