import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { setImmediate } from "node:timers/promises";
import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import ExcelJS from "exceljs";

/** Shared preflight/output bounds. This module is also a standalone bundled Worker entry. */
export const XLSX_LIMITS = {
  compressedBytes: 16 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  entries: 2048,
  rows: 100_000,
  columns: 512,
  cells: 1_000_000,
  outputBytes: 16 * 1024 * 1024,
} as const;

export class XlsxLimitError extends Error {
  constructor(readonly reason: "zip" | "expanded" | "zip64" | "dimensions" | "output") {
    super(reason);
  }
}
export interface XlsxCell {
  column: number;
  address: string;
  value: ExcelJS.CellValue;
  note?: ExcelJS.Comment | string;
  numFmt?: string;
}
export interface XlsxSheet {
  id: number;
  name: string;
  rowCount: number;
  columnCount: number;
  rows: { number: number; cells: XlsxCell[] }[];
}
export interface XlsxWorkbook {
  sheets: XlsxSheet[];
}
interface ZipEntry {
  name: string;
  start: number;
  compressed: number;
  expanded: number;
  method: number;
}
function reject(reason: XlsxLimitError["reason"]): never {
  throw new XlsxLimitError(reason);
}
function checkExtra(bytes: Buffer, start: number, length: number) {
  const end = start + length;
  for (let offset = start; offset < end;) {
    if (offset + 4 > end) reject("zip");
    const tag = bytes.readUInt16LE(offset),
      size = bytes.readUInt16LE(offset + 2);
    if (tag === 1) reject("zip64");
    if (offset + 4 + size > end) reject("zip");
    offset += 4 + size;
  }
}
/** Inspect central/local headers before any decompression or ExcelJS allocation. */
export function validateXlsxZip(bytes: Buffer): ZipEntry[] {
  if (bytes.length < 22 || bytes.length > XLSX_LIMITS.compressedBytes) reject("zip");
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) reject("zip");
  const count = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12),
    start = bytes.readUInt32LE(end + 16);
  if (
    count === 0xffff ||
    size === 0xffffffff ||
    start === 0xffffffff ||
    (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50)
  )
    reject("zip64");
  if (
    !count ||
    count > XLSX_LIMITS.entries ||
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== count ||
    start + size !== end
  )
    reject("zip");
  const entries: ZipEntry[] = [],
    names = new Set<string>(),
    ranges: [number, number][] = [];
  let offset = start,
    expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) reject("zip");
    const flags = bytes.readUInt16LE(offset + 8),
      method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20),
      uncompressed = bytes.readUInt32LE(offset + 24),
      local = bytes.readUInt32LE(offset + 42);
    const nameLength = bytes.readUInt16LE(offset + 28),
      extraLength = bytes.readUInt16LE(offset + 30),
      commentLength = bytes.readUInt16LE(offset + 32);
    if (
      [compressed, uncompressed, local].includes(0xffffffff) ||
      bytes.readUInt16LE(offset + 34) === 0xffff
    )
      reject("zip64");
    expanded += uncompressed;
    if (expanded > XLSX_LIMITS.expandedBytes) reject("expanded");
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34))
      reject("zip");
    checkExtra(bytes, offset + 46 + nameLength, extraLength);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength),
      name = nameBytes.toString("utf8");
    if (!name || names.has(name) || local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50)
      reject("zip");
    names.add(name);
    const localNameLength = bytes.readUInt16LE(local + 26),
      localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength,
      dataEnd = dataStart + compressed;
    if (
      dataEnd > start ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)
    )
      reject("zip");
    checkExtra(bytes, local + 30 + localNameLength, localExtraLength);
    if (
      !(flags & 8) &&
      (bytes.readUInt32LE(local + 18) !== compressed ||
        bytes.readUInt32LE(local + 22) !== uncompressed)
    )
      reject("zip");
    if (method === 0 && compressed !== uncompressed) reject("zip");
    ranges.push([local, dataEnd]);
    entries.push({ name, start: dataStart, compressed, expanded: uncompressed, method });
    offset = next;
  }
  if (offset !== end) reject("zip");
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1]![1])) reject("zip");
  return entries;
}

const unzip = promisify(inflateRaw);
function columnNumber(code: string): number {
  let column = 0;
  for (const char of code) {
    column = column * 26 + char.charCodeAt(0) - 64;
    if (column > XLSX_LIMITS.columns) reject("dimensions");
  }
  return column;
}
/** Detect sparse-address dimensions before ExcelJS creates its own row/cell objects. */
function worksheetCells(xml: string): number {
  let rows = 0,
    columns = 0;
  const pattern = /<(row|c|dimension)\b([^>]*)>/g;
  for (const match of xml.matchAll(pattern)) {
    const attribute = /\b(?:r|ref)\s*=\s*["']([^"']+)["']/.exec(match[2]!);
    if (!attribute) continue;
    if (match[1] === "row") {
      const row = Number(attribute[1]);
      if (!Number.isSafeInteger(row) || row < 1 || row > XLSX_LIMITS.rows) reject("dimensions");
      rows = Math.max(rows, row);
    } else {
      for (const coordinate of attribute[1]!.split(":")) {
        const cell = /^([A-Z]+)([1-9]\d*)$/.exec(coordinate);
        if (!cell) reject("dimensions");
        const row = Number(cell[2]);
        if (!Number.isSafeInteger(row) || row > XLSX_LIMITS.rows) reject("dimensions");
        rows = Math.max(rows, row);
        columns = Math.max(columns, columnNumber(cell[1]!));
      }
    }
    if (rows * columns > XLSX_LIMITS.cells) reject("dimensions");
  }
  return rows * columns;
}
async function preflightContent(bytes: Buffer, entries: ZipEntry[], checkpoint: () => void) {
  let cells = 0;
  for (const entry of entries) {
    checkpoint();
    const compressed = bytes.subarray(entry.start, entry.start + entry.compressed);
    let content: Buffer;
    try {
      content =
        entry.method === 0
          ? compressed
          : await unzip(compressed, { maxOutputLength: Math.max(1, entry.expanded) });
    } catch {
      reject("expanded");
    }
    if (content.length !== entry.expanded) reject("expanded");
    // Never trust declared dimensions alone; inspect row and cell addresses as well.
    if (/\.xml$/i.test(entry.name) && content.includes(Buffer.from("<worksheet"))) {
      cells += worksheetCells(content.toString("utf8"));
      if (cells > XLSX_LIMITS.cells) reject("dimensions");
    }
    await setImmediate();
    checkpoint();
  }
}

export async function parseXlsx(
  bytes: Buffer,
  checkpoint: () => void = () => {},
): Promise<XlsxWorkbook> {
  const entries = validateXlsxZip(bytes);
  await preflightContent(bytes, entries, checkpoint);
  checkpoint();
  const workbook = new ExcelJS.Workbook();
  // ExcelJS's declared Buffer interface extends ArrayBuffer; its runtime accepts Node Buffer.
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  checkpoint();
  let cells = 0;
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > XLSX_LIMITS.rows || sheet.columnCount > XLSX_LIMITS.columns)
      reject("dimensions");
    cells += sheet.rowCount * sheet.columnCount;
    if (!Number.isSafeInteger(cells) || cells > XLSX_LIMITS.cells) reject("dimensions");
  }
  const sheets: XlsxSheet[] = [];
  let outputBytes = 0;
  for (const sheet of workbook.worksheets) {
    const result: XlsxSheet = {
      id: sheet.id,
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      rows: [],
    };
    for (let number = 1; number <= result.rowCount; number++) {
      if (number % 128 === 0) {
        await setImmediate();
        checkpoint();
      }
      const row = sheet.findRow(number);
      if (!row) continue;
      const existing: XlsxCell[] = [];
      for (let column = 1; column <= result.columnCount; column++) {
        const cell = row.findCell(column);
        if (!cell) continue;
        const value: XlsxCell = {
          column,
          address: cell.address,
          value: cell.value,
          note: cell.note,
          numFmt: cell.numFmt,
        };
        outputBytes += Buffer.byteLength(JSON.stringify(value), "utf8");
        if (outputBytes > XLSX_LIMITS.outputBytes) reject("output");
        existing.push(value);
      }
      result.rows.push({ number, cells: existing });
    }
    sheets.push(result);
  }
  return { sheets };
}

// Workers receive bytes only, never paths, credentials, document instructions or network config.
if (!isMainThread && parentPort && workerData?.reqflowXlsxWorker === true) {
  parentPort.once("message", async (input: unknown) => {
    try {
      if (!(input instanceof Uint8Array)) reject("zip");
      const workbook = await parseXlsx(
        Buffer.from(input.buffer, input.byteOffset, input.byteLength),
      );
      parentPort!.postMessage({ ok: true, workbook });
    } catch (error) {
      parentPort!.postMessage({
        ok: false,
        reason: error instanceof XlsxLimitError ? error.reason : "parse",
      });
    }
  });
}
