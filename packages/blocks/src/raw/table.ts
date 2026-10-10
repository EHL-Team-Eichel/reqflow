import { parseNumber } from "./columns";

/** A spreadsheet or CSV after cleanup: one header row and the data rows below it. */

export type Cell = string | number | boolean | Date | null;

export interface TableRow {
  line: number; // row number as the user sees it in Excel / the CSV (1-based)
  cells: Cell[]; // one per header column
}

export interface Table {
  header: string[];
  rows: TableRow[];
  /** Things the user should know, e.g. skipped empty rows or renamed columns. Never silent. */
  notes: string[];
}

const isEmpty = (c: Cell | undefined) =>
  c === null || c === undefined || (typeof c === "string" && c.trim() === "");

/** "rows 3, 4, 9" or "rows 3, 4, 9 and 12 more". */
export function listRows(lines: number[]): string {
  const shown = lines.slice(0, 8).join(", ");
  return lines.length > 8
    ? `rows ${shown} and ${lines.length - 8} more`
    : `row${lines.length === 1 ? "" : "s"} ${shown}`;
}

/** How many filled rows from the top are compared to find the header. */
const HEADER_SCAN_ROWS = 30;

const filledCount = (r: readonly Cell[]) => r.filter((c) => !isEmpty(c)).length;
const isNumeric = (c: Cell | undefined) =>
  typeof c === "number" || (typeof c === "string" && parseNumber(c) !== null);
const clean = (c: Cell | undefined): Cell =>
  isEmpty(c) ? null : typeof c === "string" ? c.trim() : (c ?? null);

/**
 * Finds the header and the data rows below it, including what report-style Excel sheets do:
 * - The header is the first row of labels at least half as full as the fullest of the top rows, so
 *   title rows above the table ("Customer study 2025") are skipped and noted.
 * - A row of group labels right above the header ("China" over two columns, "EU" over the next
 *   three, as merged cells leave them) is added to the column names: "Car B (China)".
 * - Rows with only a title in the first column between blocks of figures are section titles. They
 *   become a "Section" column on the rows below them instead of records of their own.
 * Blank header cells become `column_<n>`, duplicates get a suffix, empty rows are skipped and listed
 * in `notes`. A row with values beyond the last header column is an error naming that row: guessing
 * which column they belong to would corrupt the data.
 */
export function toTable(raw: readonly (readonly Cell[])[]): Table {
  const notes: string[] = [];
  const firstFilled = raw.findIndex((r) => filledCount(r) > 0);
  if (firstFilled === -1) throw new Error("The table is empty: no header row found");
  const widest = Math.max(
    ...raw.slice(firstFilled, firstFilled + HEADER_SCAN_ROWS).map(filledCount),
  );
  const minFilled = widest >= 2 ? Math.max(2, Math.ceil(widest / 2)) : 1;
  // A header is mostly labels. If no row qualifies, the first filled row is the header, so a stray
  // value in a narrow table still fails with its row named instead of being taken for the header.
  const isLabels = (r: readonly Cell[]) => {
    const filled = r.filter((c) => !isEmpty(c));
    return filled.filter((c) => !isNumeric(c)).length * 2 > filled.length;
  };
  // Group labels over the columns ("China", "EU"): no first cell, only text, a fuller label row below.
  const isGroupLabels = (i: number) => {
    const r = raw[i]!;
    const below = raw[i + 1];
    return (
      isEmpty(r[0]) &&
      filledCount(r) >= 2 &&
      r.every((c) => isEmpty(c) || typeof c === "string") &&
      below !== undefined &&
      filledCount(below) > filledCount(r) &&
      isLabels(below)
    );
  };
  const found = raw.findIndex(
    (r, i) => filledCount(r) >= minFilled && isLabels(r) && !isGroupLabels(i),
  );
  const headerIndex = found === -1 ? firstFilled : found;

  const rawHeader = [...raw[headerIndex]!];
  while (rawHeader.length > 0 && isEmpty(rawHeader.at(-1))) rawHeader.pop();
  const width = rawHeader.length;
  let names = rawHeader.map((c) => (isEmpty(c) ? "" : String(c).trim()));

  // Above the header: empty rows, title rows and maybe one row of column-group labels.
  const above = raw.slice(0, headerIndex);
  const emptyAbove = above.filter((r) => filledCount(r) === 0).length;
  if (emptyAbove) notes.push(`Skipped ${emptyAbove} empty row(s) above the header.`);
  const groupRow = above.at(-1);
  const isGroupRow = groupRow !== undefined && isGroupLabels(headerIndex - 1);
  const titleLines = above
    .map((r, i) => ({ line: i + 1, filled: filledCount(r) > 0 }))
    .filter((r, i) => r.filled && !(isGroupRow && i === headerIndex - 1))
    .map((r) => r.line);
  if (titleLines.length) {
    notes.push(`Skipped ${listRows(titleLines)} above the header: titles, not data.`);
  }
  if (isGroupRow) {
    let label = "";
    names = names.map((name, j) => {
      const cell = groupRow[j];
      if (!isEmpty(cell)) label = String(cell).trim();
      return label ? `${name || `column_${j + 1}`} (${label})` : name;
    });
    notes.push(
      `Row ${headerIndex} labels groups of columns; added each label to the column names below it, e.g. "${names.find((n) => n.endsWith(")"))}".`,
    );
  }
  names = names.map((name, i) => {
    if (name) return name;
    notes.push(`Column ${i + 1} has no name; called it "column_${i + 1}".`);
    return `column_${i + 1}`;
  });

  // Section titles: a non-numeric first cell and nothing else, in a sheet of figures whose first
  // column repeats labels ("Mean", "Total", …). A feedback table with a missing comment has unique
  // IDs in its first column, so it never qualifies.
  const body = raw.slice(headerIndex + 1).map((cells, i) => ({ line: headerIndex + i + 2, cells }));
  const isTitleOnly = (cells: readonly Cell[]) =>
    typeof cells[0] === "string" &&
    !isEmpty(cells[0]) &&
    !isNumeric(cells[0]) &&
    filledCount(cells) === 1;
  const titleRows = width >= 3 ? body.filter((r) => isTitleOnly(r.cells)) : [];
  const dataRows = body.filter((r) => filledCount(r.cells) > 0 && !isTitleOnly(r.cells));
  const sectioned =
    titleRows.length >= 2 &&
    dataRows.filter((r) => r.cells.slice(1, width).some(isNumeric)).length * 2 >= dataRows.length &&
    new Set(dataRows.map((r) => String(r.cells[0] ?? ""))).size < dataRows.length;

  let section: string | null = null;
  if (sectioned) {
    const firstTitleLine = titleRows[0]!.line;
    if (!isEmpty(rawHeader[0]) && dataRows.some((r) => r.line < firstTitleLine)) {
      section = names[0]!;
      notes.push(
        `The first column's header "${section}" is the title of the first section (the rows above row ${firstTitleLine}); the column is called "Label".`,
      );
      names[0] = "Label";
    }
    names = ["Section", ...names];
    notes.push(
      `${titleRows.length} rows hold only a title in the first column (${listRows(titleRows.map((r) => r.line))}): they are section titles, so each record carries its section in the "Section" column.`,
    );
  }

  const seen = new Map<string, number>();
  const header = names.map((name) => {
    const n = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), n);
    if (n === 1) return name;
    notes.push(`Column "${name}" appears ${n} times; renamed the copy to "${name}_${n}".`);
    return `${name}_${n}`;
  });

  const rows: TableRow[] = [];
  const empty: number[] = [];
  for (const { line, cells } of body) {
    if (filledCount(cells) === 0) {
      empty.push(line);
      continue;
    }
    if (sectioned && isTitleOnly(cells)) {
      section = String(cells[0]).trim();
      continue;
    }
    const extra = cells.slice(width).findIndex((c) => !isEmpty(c));
    if (extra !== -1) {
      throw new Error(
        `Row ${line} has a value in column ${width + extra + 1}, but the header only has ${width} columns`,
      );
    }
    const values = Array.from({ length: width }, (_, j) => clean(cells[j]));
    rows.push({ line, cells: sectioned ? [section, ...values] : values });
  }
  if (empty.length) notes.push(`Skipped ${empty.length} empty ${listRows(empty)}.`);
  return { header, rows, notes };
}

/** Human-readable cell value: dates as YYYY-MM-DD, booleans as yes/no. */
export function cellText(c: Cell): string {
  if (c === null) return "";
  if (c instanceof Date) return Number.isNaN(c.getTime()) ? "" : c.toISOString().slice(0, 10);
  if (typeof c === "boolean") return c ? "yes" : "no";
  return String(c);
}
