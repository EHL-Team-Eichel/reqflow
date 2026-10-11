import { createHash } from "node:crypto";
import type { ProductScope, Source, SourceKind, SourceRecord } from "@reqflow/core";
import { COLUMN_SYNONYMS, findColumns } from "./columns";
import { guessLanguage, normalizeLanguage } from "./language";
import { cellText, listRows, type Cell, type Table, type TableRow } from "./table";

export type RawDataset =
  "customer_feedback" | "equipment_data" | "sales_volume" | "customer_study" | "other";

export const DATASET_KIND: Record<RawDataset, SourceKind> = {
  customer_feedback: "customer_feedback",
  equipment_data: "equipment_data",
  sales_volume: "sales_volume",
  customer_study: "customer_study",
  other: "other_internal",
};

/** Datasets whose rows are people's words: the comment column is the record text. */
const TEXT_DATASETS: ReadonlySet<RawDataset> = new Set(["customer_feedback", "customer_study"]);

export const shortHash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

export interface IngestOptions {
  key: string; // stable identity of the data (file id + sheet, or database + query): same data → same ids
  title: string;
  uri?: string;
  sheet?: string;
  dataset: RawDataset;
  scope: ProductScope;
  retrievedAt: string; // ISO datetime
}

export interface Ingested {
  source: Source;
  records: SourceRecord[];
  /** The record each table row ended up in (`undefined` when the row was skipped). */
  recordOfRow: (SourceRecord | undefined)[];
  notes: string[];
}

const textLength = (table: Table, col: number) => {
  const texts = table.rows.map((r) => cellText(r.cells[col] ?? null)).filter(Boolean);
  return texts.length ? texts.reduce((sum, t) => sum + t.length, 0) / texts.length : 0;
};

/**
 * The comment column: of the columns named like one, the one with the longest texts, so that
 * "Feedback Type" next to "Customer Feedback" isn't mistaken for the comment. -1 if none.
 */
export function textColumn(table: Table): number {
  const candidates = findColumns(table.header, "text");
  if (candidates.length <= 1) return candidates[0] ?? -1;
  return candidates.reduce((best, c) =>
    textLength(table, c) > textLength(table, best) ? c : best,
  );
}

/** The market column, preferring codes ("EU", "GB") over names ("Europe") when both are there. */
export function marketColumn(table: Table): number {
  const candidates = findColumns(table.header, "market");
  const isCodes = (col: number) =>
    table.rows.every((r) => {
      const v = cellText(r.cells[col] ?? null);
      return !v || /^[A-Za-z]{2,3}$/.test(v);
    });
  return candidates.find(isCodes) ?? candidates[0] ?? -1;
}

/** Numbers in record text: at most 4 decimals ("0.8123" instead of "0.81234567891234"). */
const textOf = (c: Cell) =>
  typeof c === "number" && !Number.isInteger(c) ? String(Number(c.toFixed(4))) : cellText(c);

/** "rows 3–5" for a run of rows, otherwise "rows 3, 7, 9". */
function rowRange(lines: number[]): string {
  if (lines.length === 1) return `row ${lines[0]}`;
  const contiguous = lines.every((l, i) => i === 0 || l === lines[i - 1]! + 1);
  return contiguous ? `rows ${lines[0]}–${lines.at(-1)}` : listRows(lines);
}

/** A column's value across merged rows: the value when they agree, else the distinct values. */
function mergedValue(rows: TableRow[], col: number): unknown {
  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const c = row.cells[col] ?? null;
    if (c === null) continue;
    const v = c instanceof Date ? cellText(c) : c;
    if (!seen.has(String(v))) {
      seen.add(String(v));
      values.push(v);
    }
  }
  return values.length === 0 ? null : values.length === 1 ? values[0] : values;
}

/**
 * One record per row: the comment for feedback-like data, otherwise "column: value; …".
 * Exports that repeat a comment on several rows, once per classification, are merged back into
 * one record when the ID and the comment are the same; the columns that differ become lists.
 */
export function tableToRecords(table: Table, o: IngestOptions): Ingested {
  const notes: string[] = [];
  const sourceId = `src_${shortHash(o.key)}`;
  const isText = TEXT_DATASETS.has(o.dataset);
  const textCol = isText ? textColumn(table) : -1;
  const idCol = textCol !== -1 ? (findColumns(table.header, "id")[0] ?? -1) : -1;
  const marketCol = marketColumn(table);
  const languageCol = findColumns(table.header, "language")[0] ?? -1;

  if (isText && textCol === -1) {
    notes.push(
      `No comment column found (looked for ${COLUMN_SYNONYMS.text.slice(0, 5).join(", ")}, …); each row is kept as "column: value" text.`,
    );
  }

  const textOfRow = (row: TableRow) =>
    textCol !== -1
      ? cellText(row.cells[textCol] ?? null)
      : table.header
          .map((h, j) => (row.cells[j] === null ? null : `${h}: ${textOf(row.cells[j]!)}`))
          .filter((part): part is string => part !== null)
          .join("; ");

  // Group the rows that become one record, in order of first appearance.
  const groups: { text: string; rows: TableRow[]; indexes: number[] }[] = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  const noText: number[] = [];
  table.rows.forEach((row, i) => {
    const text = textOfRow(row);
    if (!text.trim()) {
      noText.push(row.line);
      return;
    }
    const id = idCol !== -1 ? cellText(row.cells[idCol] ?? null) : "";
    const key = id ? `${id}\u0000${text}` : null;
    const existing = key ? byKey.get(key) : undefined;
    if (existing) {
      existing.rows.push(row);
      existing.indexes.push(i);
      return;
    }
    const group = { text, rows: [row], indexes: [i] };
    groups.push(group);
    if (key) byKey.set(key, group);
  });
  if (noText.length)
    notes.push(`Skipped ${noText.length} ${listRows(noText)} without comment text.`);

  const merged = groups.filter((g) => g.rows.length > 1);
  if (merged.length) {
    const varying = table.header.filter((_, j) =>
      merged.some((g) => Array.isArray(mergedValue(g.rows, j))),
    );
    notes.push(
      `Merged ${table.rows.length - noText.length} rows into ${groups.length} records: rows with the same ${table.header[idCol]} and comment are one piece of feedback` +
        (varying.length
          ? `; the columns that differ between them (${varying.join(", ")}) are kept as lists.`
          : "."),
    );
  }
  if (idCol !== -1) {
    const textsPerId = new Map<string, number>();
    for (const g of groups) {
      const id = cellText(g.rows[0]!.cells[idCol] ?? null);
      if (id) textsPerId.set(id, (textsPerId.get(id) ?? 0) + 1);
    }
    const shared = [...textsPerId.values()].filter((n) => n > 1).length;
    if (shared) {
      notes.push(
        `${shared} ${table.header[idCol]} value(s) have more than one different comment; each comment is its own record.`,
      );
    }
  }

  const recordOfRow: (SourceRecord | undefined)[] = table.rows.map(() => undefined);
  const records = groups.map((g) => {
    const first = g.rows[0]!;
    const market = marketCol !== -1 ? cellText(first.cells[marketCol] ?? null) : "";
    const languageCell = languageCol !== -1 ? cellText(first.cells[languageCol] ?? null) : "";
    const language = languageCell
      ? normalizeLanguage(languageCell)
      : textCol !== -1
        ? guessLanguage(g.text)
        : undefined;
    const lines = g.rows.map((r) => r.line);
    const record: SourceRecord = {
      id: `rec_${shortHash(o.key)}_${first.line}`,
      sourceId,
      text: g.text,
      fields: Object.fromEntries(table.header.map((h, j) => [h, mergedValue(g.rows, j)])),
      locator: o.sheet ? `${o.sheet}, ${rowRange(lines)}` : rowRange(lines),
      market: market || o.scope.market,
      ...(language ? { language } : {}),
    };
    for (const i of g.indexes) recordOfRow[i] = record;
    return record;
  });

  const markets = new Set(records.map((r) => r.market));
  const source: Source = {
    id: sourceId,
    kind: DATASET_KIND[o.dataset],
    origin: "bmw_internal",
    title: o.title,
    ...(o.uri ? { uri: o.uri } : {}),
    publisher: "BMW",
    retrievedAt: o.retrievedAt,
    reliability: "high", // BMW's own data
    ...(markets.size === 1 ? { market: [...markets][0]! } : {}),
    vehicleLine: o.scope.vehicleLine,
  };
  return { source, records, recordOfRow, notes };
}
