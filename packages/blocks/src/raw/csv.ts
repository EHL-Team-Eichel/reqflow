/**
 * RFC 4180 CSV reading for BMW exports: quoted fields with "" escapes and line breaks, a UTF-8 BOM,
 * CRLF/LF/CR line ends, and `,` `;` or tab as delimiter (German Excel exports use `;`).
 */

const DELIMITERS = [",", ";", "\t"] as const;

/** Decodes UTF-8; falls back to Windows-1252 (Excel's "CSV" on German Windows) when it isn't valid UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** The delimiter that occurs most often in the first line, outside quotes. */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best: string = ",";
  for (const [d, n] of counts) if (n > counts.get(best)!) best = d;
  return best;
}

/** Rows of raw cell strings. Throws with the line number on an unclosed quote. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let quoteStartLine = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      quoteStartLine = line;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      line++;
    } else cell += ch;
  }
  if (quoted) throw new Error(`Line ${quoteStartLine}: a quoted value is never closed`);
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
