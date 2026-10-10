import readXlsxFile from "read-excel-file/node";
import { decodeText, parseCsv } from "./csv";
import type { Cell } from "./table";

export interface ReadResult {
  rows: Cell[][];
  sheet?: string; // the sheet that was read (Excel only)
  notes: string[];
}

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const isOle = (b: Uint8Array) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

/**
 * Reads an uploaded file into raw rows. The format is decided by its content, not its name:
 * `.xlsx` (zip) via read-excel-file, legacy `.xls` and PDFs are refused with a fix, anything else is
 * CSV text.
 */
export async function readSpreadsheet(
  name: string,
  bytes: Uint8Array,
  sheet: string,
): Promise<ReadResult> {
  if (isOle(bytes) || /\.xls$/i.test(name)) {
    throw new Error(
      `"${name}" is an old .xls file. Open it in Excel and save it as .xlsx or .csv.`,
    );
  }
  if (isPdf(bytes) || /\.pdf$/i.test(name)) {
    throw new Error(
      `"${name}" is a PDF. The Raw block reads tables from Excel (.xlsx) or CSV files; PDFs aren't supported yet.`,
    );
  }
  if (isZip(bytes)) {
    let sheets: { sheet: string; data: unknown[][] }[];
    try {
      sheets = await readXlsxFile(Buffer.from(bytes));
    } catch (err) {
      throw new Error(
        `"${name}" couldn't be read as an Excel file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (sheets.length === 0) throw new Error(`"${name}" has no sheets`);
    const wanted = sheet.trim();
    const picked = wanted
      ? sheets.find((s) => s.sheet.toLowerCase() === wanted.toLowerCase())
      : sheets[0];
    if (!picked) {
      throw new Error(
        `"${name}" has no sheet "${wanted}". Sheets: ${sheets.map((s) => `"${s.sheet}"`).join(", ")}`,
      );
    }
    const notes =
      !wanted && sheets.length > 1
        ? [`Read the first of ${sheets.length} sheets ("${picked.sheet}").`]
        : [];
    return { rows: picked.data as Cell[][], sheet: picked.sheet, notes };
  }
  const notes = sheet.trim()
    ? [`"${name}" is a CSV file, so the sheet name "${sheet}" was ignored.`]
    : [];
  return { rows: parseCsv(decodeText(bytes)), notes };
}
