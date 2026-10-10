import ExcelJS from "exceljs";
import { assertJsonByteBudget, PERSISTED_JSON_MAX_BYTES } from "./data-budget";
import JSZip from "jszip";
import { z } from "zod";
import { ResearchDataset, type ResearchRecord } from "@reqflow/core";

export const FEEDBACK_COLUMNS = [
  "ID",
  "Source",
  "Brand",
  "Sales Description",
  "Country",
  "Derivate (e-code)",
  "Engine Type",
  "Feedback Type",
  "Customer Feedback",
  "Vfc level2 3 Name",
  "Vfc level2 Name",
  "Vfc level3 Name",
  "Source URL",
  "Published At",
  "Published Precision",
  "Retrieved At",
  "Language",
  "Research Agent",
  "Original Source ID",
  "Original Record ID",
  "Fundstelle / Kontextbezug",
  "Source ID",
  "Run IDs",
  "Limitations",
  "Original Feedback ID",
  "Source Sheet",
  "Source Row",
];

const SourceAssociation = z
  .object({
    headers: z.array(z.string()),
    values: z.array(z.unknown()),
    sheet: z.string(),
    row: z.number().int().positive(),
  })
  .refine(
    (association) => association.headers.length === association.values.length,
    "Source association headers and values must have equal length",
  );

function original(record: ResearchRecord, key: string): unknown {
  const supplied = record.metadata.originalFields;
  if (supplied && typeof supplied === "object" && Object.hasOwn(supplied, key))
    return (supplied as Record<string, unknown>)[key];
  return Object.hasOwn(record.metadata, key) ? record.metadata[key] : undefined;
}

function serializedText(value: unknown): string {
  return value == null
    ? ""
    : typeof value === "string"
      ? value
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
}

export function safeSpreadsheetText(value: unknown): string {
  const text = serializedText(value);
  return /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text;
}

interface ExportRow {
  values: unknown[];
  recordId?: string;
  sourceId?: string;
}

function feedbackRows(dataset: ResearchDataset): ExportRow[] {
  const sources = new Map(dataset.sources.map((source) => [source.id, source]));
  return dataset.records
    .filter((record) => record.recordType === "feedback")
    .flatMap((record) => {
      const parsed = z
        .array(SourceAssociation)
        .safeParse(
          record.metadata.sourceAssociations === undefined
            ? []
            : record.metadata.sourceAssociations,
        );
      if (!parsed.success)
        throw new Error(
          `Invalid source association for record ${record.id}: ${parsed.error.message}`,
        );
      const associations = parsed.data.length ? parsed.data : [undefined];
      return associations.map((association) => {
        // Missing columns in one supplied row must not borrow values from another row or attribution.
        const field = (key: string): unknown =>
          association
            ? association.values[association.headers.indexOf(key)]
            : original(record, key);
        return {
          recordId: record.id,
          sourceId: record.sourceId,
          values: [
            record.id,
            association
              ? field("Source")
              : (field("Source") ?? sources.get(record.sourceId)?.publisher ?? record.provider),
            field("Brand"),
            field("Sales Description"),
            field("Country"),
            field("Derivate (e-code)"),
            field("Engine Type"),
            field("Feedback Type"),
            field("Customer Feedback") ?? record.text,
            field("Vfc level2 3 Name"),
            field("Vfc level2 Name"),
            field("Vfc level3 Name"),
            record.originalUrl,
            record.publishedAt,
            record.datePrecision,
            record.retrievedAt,
            record.language,
            record.collectingAgents.join(", "),
            record.originalSourceId,
            record.originalRecordId,
            association
              ? `${association.sheet}!row ${association.row}`
              : (record.locator ?? record.parentId ?? record.threadId),
            record.sourceId,
            record.runIds.join(", "),
            record.limitations.join("\n"),
            association ? field("ID") : (record.metadata.feedbackId ?? original(record, "ID")),
            association?.sheet,
            association?.row,
          ],
        };
      });
    });
}

export function exportResearchJson(input: ResearchDataset): string {
  const dataset = ResearchDataset.parse(input);
  assertJsonByteBudget(dataset, PERSISTED_JSON_MAX_BYTES);
  return JSON.stringify(dataset);
}

export function exportResearchCsv(input: ResearchDataset): string {
  const data = ResearchDataset.parse(input);
  const quote = (value: unknown) => `"${safeSpreadsheetText(value).replaceAll('"', '""')}"`;
  return (
    "\ufeff" +
    [FEEDBACK_COLUMNS, ...feedbackRows(data).map((row) => row.values)]
      .map((row) => row.map(quote).join(","))
      .join("\r\n")
  );
}

const CELL_LIMIT = 32767;
// ExcelJS removes these controls; XML 1.0 cannot carry most of them verbatim.
const UNSAFE_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff\ufffe\uffff]/u;
const OVERFLOW_COLUMNS = [
  "Record ID",
  "Source ID",
  "Sheet",
  "Row",
  "Column",
  "Column Name",
  "Segment Order",
  "Segment Count",
  "Original Segment",
  "Original Segment JSON",
  "Serialization",
];

function segmentJson(text: string): string {
  // JSON.stringify leaves DEL and noncharacters literal, but ExcelJS/XML cannot retain them.
  return JSON.stringify(text).replace(
    /[\u007f\ufffe\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function serializedSegments(text: string): string[] {
  const segments: string[] = [];
  let segment = "",
    jsonLength = 2;
  // Iterate code points so a surrogate pair is never split. Bound both the guarded display
  // and the JSON string (quotes, backslashes and controls can expand during serialization).
  for (const character of text) {
    const encodedLength = segmentJson(character).length - 2;
    if (
      segment.length + character.length > CELL_LIMIT - 1 ||
      jsonLength + encodedLength > CELL_LIMIT
    ) {
      segments.push(segment);
      segment = "";
      jsonLength = 2;
    }
    segment += character;
    jsonLength += encodedLength;
  }
  if (segment) segments.push(segment);
  return segments;
}

function styleSheet(sheet: ExcelJS.Worksheet, columnCount: number) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columnCount } };
  for (const column of sheet.columns) column.width = 24;
  sheet.getRow(1).font = { bold: true };
  sheet.eachRow((row) => (row.alignment = { vertical: "top", wrapText: true }));
}

export async function exportResearchXlsx(input: ResearchDataset): Promise<Uint8Array> {
  const data = ResearchDataset.parse(input);
  const workbook = new ExcelJS.Workbook();
  const overflow: string[][] = [];
  const recordCells = new Map(
    data.records.map((record, index) => [record.id, `Research Records!A${index + 2}`]),
  );
  const sourceCells = new Map(
    data.sources.map((source, index) => [source.id, `Sources!A${index + 2}`]),
  );
  const lineage = (id: string | undefined, cells: Map<string, string>): string => {
    const text = safeSpreadsheetText(id);
    return text.length > CELL_LIMIT || UNSAFE_XML.test(text)
      ? `See ${cells.get(id!) ?? "the owning sheet's ID column"}`
      : text;
  };
  const add = (name: string, headers: string[], rows: ExportRow[]) => {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(headers);
    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      sheet.addRow(
        row.values.map((value, column) => {
          const text = serializedText(value);
          const guarded = safeSpreadsheetText(text);
          if (guarded.length <= CELL_LIMIT && !UNSAFE_XML.test(text)) return guarded;
          const segments = serializedSegments(text);
          for (const [order, segment] of segments.entries()) {
            overflow.push([
              lineage(row.recordId, recordCells),
              lineage(row.sourceId, sourceCells),
              name,
              String(rowNumber),
              String(column + 1),
              headers[column]!,
              String(order + 1),
              String(segments.length),
              UNSAFE_XML.test(segment) ? segmentJson(segment) : safeSpreadsheetText(segment),
              segmentJson(segment),
              typeof value === "object" ? "json" : typeof value,
            ]);
          }
          // This is a storage pointer, not an invented summary or an unmarked truncation.
          return `${guarded === text ? "" : "'"}See Cell Overflow: ${name}, row ${rowNumber}, column ${column + 1}`;
        }),
      );
    }
    styleSheet(sheet, headers.length);
  };
  add("Feedback_Explorer", FEEDBACK_COLUMNS, feedbackRows(data));
  add(
    "Sources",
    [
      "Source ID",
      "Kind",
      "Title",
      "URL",
      "Publisher",
      "Published At",
      "Retrieved At",
      "Origin",
      "Reliability",
      "Market",
      "Vehicle Line",
    ],
    data.sources.map((source) => ({
      sourceId: source.id,
      values: [
        source.id,
        source.kind,
        source.title,
        source.uri,
        source.publisher,
        source.publishedAt,
        source.retrievedAt,
        source.origin,
        source.reliability,
        source.market,
        source.vehicleLine,
      ],
    })),
  );
  add(
    "Research Records",
    [
      "ID",
      "Source ID",
      "Record Type",
      "Original Text",
      "Original Source ID",
      "Original Record ID",
      "URL",
      "Published At",
      "Precision",
      "Retrieved At",
      "Language",
      "Research Agents",
      "Run IDs",
      "Locator",
      "Parent ID",
      "Thread ID",
      "Context",
      "Metadata",
      "Limitations",
      "Provider",
      "Fields",
      "Market Attribution",
      "Vehicle Attribution",
      "Content Hash",
      "Table",
    ],
    data.records.map((record) => ({
      recordId: record.id,
      sourceId: record.sourceId,
      values: [
        record.id,
        record.sourceId,
        record.recordType,
        record.text,
        record.originalSourceId,
        record.originalRecordId,
        record.originalUrl,
        record.publishedAt,
        record.datePrecision,
        record.retrievedAt,
        record.language,
        record.collectingAgents,
        record.runIds,
        record.locator,
        record.parentId,
        record.threadId,
        record.context,
        record.metadata,
        record.limitations,
        record.provider,
        record.fields,
        record.marketAttribution,
        record.vehicleAttribution,
        record.contentHash,
        record.table,
      ],
    })),
  );
  add(
    "Metrics Tables",
    [
      "Record ID",
      "Source ID",
      "Original Headers",
      "Original Row Values",
      "Units",
      "Footnotes",
      "Dimensions",
    ],
    data.records
      .filter((record) => record.table)
      .flatMap((record) =>
        record.table!.rows.map((row) => ({
          recordId: record.id,
          sourceId: record.sourceId,
          values: [
            record.id,
            record.sourceId,
            record.table!.headers,
            row,
            record.table!.units,
            record.table!.footnotes,
            record.table!.dimensions,
          ],
        })),
      ),
  );
  add(
    "Research Runs",
    ["Run ID", "Agent", "Status", "Record IDs", "Requests", "Limitations", "Synthetic"],
    data.results.map((result) => ({
      values: [
        data.runId,
        result.agentId,
        result.status,
        result.recordIds,
        result.requests,
        result.limitations,
        data.synthetic,
      ],
    })),
  );
  if (overflow.length) {
    const sheet = workbook.addWorksheet("Cell Overflow");
    sheet.addRow(OVERFLOW_COLUMNS);
    for (const row of overflow) sheet.addRow(row);
    styleSheet(sheet, OVERFLOW_COLUMNS.length);
  }

  // ExcelJS's ZIP writer chunks JavaScript strings before UTF-8 encoding and can split a
  // surrogate pair. Give it ASCII transport tokens, then restore each original XML string.
  // Tokenize every cell, including headers, so source text cannot collide with a token.
  const originals: string[] = [];
  const tokens = new Map<string, string>();
  for (const sheet of workbook.worksheets)
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (typeof cell.value !== "string") return;
        const text = cell.value;
        let token = tokens.get(text);
        if (!token) {
          token = `reqflow-string-${originals.length}`;
          originals.push(text);
          tokens.set(text, token);
        }
        cell.value = token;
      }),
    );
  const archive = await JSZip.loadAsync(
    new Uint8Array(await workbook.xlsx.writeBuffer({ useSharedStrings: true })),
  );
  const strings = archive.file("xl/sharedStrings.xml");
  if (!strings) throw new Error("XLSX export is missing shared strings");
  // XML readers normalize literal CR/CRLF. Character references preserve the original CR,
  // while leaving LF and already escaped source text such as a literal '&#13;' untouched.
  // References also avoid ExcelJS readers splitting UTF-8 characters across ZIP chunks.
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  };
  const encode = (text: string) =>
    text.replace(
      /[&<>"'\r]|[^\x00-\x7f]/gu,
      (character) => entities[character] ?? `&#${character.codePointAt(0)};`,
    );
  archive.file(
    "xl/sharedStrings.xml",
    (await strings.async("string")).replace(
      /<t>reqflow-string-(\d+)<\/t>/g,
      (_match, index: string) => `<t xml:space="preserve">${encode(originals[Number(index)]!)}</t>`,
    ),
  );
  return archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
