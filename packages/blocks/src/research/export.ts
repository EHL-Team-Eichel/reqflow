import ExcelJS from "exceljs";
import { assertJsonByteBudget, PERSISTED_JSON_MAX_BYTES } from "./data-budget";
import JSZip from "jszip";
import { z } from "zod";
import { ResearchDataset, type ResearchRecord } from "@reqflow/core";
import { BMW_FEEDBACK_HEADERS, researchTableRows, SourceAssociation } from "./tabular";
import { ASSESSMENT_FIELD, assessedSelection, sourceAssessments } from "./assessment";

export const FEEDBACK_COLUMNS = [
  ...BMW_FEEDBACK_HEADERS,
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
  fields?: Record<string, unknown>;
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
          fields: association
            ? Object.fromEntries(
                association.headers.map((header, column) => [header, association.values[column]]),
              )
            : (record.metadata.originalFields as Record<string, unknown> | undefined),
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
  const table = tabularExport(data);
  const quote = (value: unknown) => `"${safeSpreadsheetText(value).replaceAll('"', '""')}"`;
  return (
    "\ufeff" +
    [table.headers, ...table.rows.map((row) => row.values)]
      .map((row) => row.map(quote).join(","))
      .join("\r\n")
  );
}

function tabularExport(data: ResearchDataset): { headers: string[]; rows: ExportRow[] } {
  const records = researchTableRows(data);
  const suppliedFeedback = feedbackRows(data);
  const headers = [...FEEDBACK_COLUMNS, "Record Type", "Original Research Record ID"];
  if (data.records.some((record) => Object.hasOwn(record.fields ?? {}, ASSESSMENT_FIELD)))
    headers.push("AI Source Assessment");
  const reserved = new Set(headers.slice(BMW_FEEDBACK_HEADERS.length));
  const suppliedHeaders = new Set(records.flatMap((record) => Object.keys(record.fields ?? {})));
  const columnNames = new Map<string, string>();
  for (const header of suppliedHeaders) {
    let name = header;
    while (reserved.has(name) || (name !== header && suppliedHeaders.has(name)))
      name = `Source Column: ${name}`;
    columnNames.set(header, name);
  }
  const originalColumns = new Map([...columnNames].map(([original, name]) => [name, original]));
  for (const record of records)
    for (const header of Object.keys(record.fields ?? {}))
      if (!headers.includes(columnNames.get(header)!)) headers.push(columnNames.get(header)!);
  return {
    headers,
    rows: records.flatMap((record) => {
      if (record.recordType === "feedback")
        return suppliedFeedback
          .filter((row) => row.recordId === record.id)
          .map((row) => ({
            ...row,
            values: headers.map((header) => {
              const column = FEEDBACK_COLUMNS.indexOf(header);
              if (column !== -1) return row.values[column];
              if (header === "Record Type") return record.recordType;
              if (header === "Original Research Record ID") return record.id;
              if (header === "AI Source Assessment") return record.sourceAssessments;
              const supplied = originalColumns.get(header);
              return supplied === undefined ? undefined : row.fields?.[supplied];
            }),
          }));
      const fields = record.fields ?? {};
      const values: Record<string, unknown> = {
        ...Object.fromEntries(
          Object.entries(fields).map(([header, value]) => [columnNames.get(header)!, value]),
        ),
        ID: record.id,
        "Source URL": record.originalUrl,
        "Published At": record.publishedAt,
        "Published Precision": record.datePrecision,
        "Retrieved At": record.retrievedAt,
        Language: record.language,
        "Research Agent": record.collectingAgents.join(", "),
        "Original Source ID": record.originalSourceId,
        "Original Record ID": record.originalRecordId,
        "Fundstelle / Kontextbezug": record.locator,
        "Source ID": record.sourceId,
        "Run IDs": record.runIds.join(", "),
        Limitations: record.limitations.join("\n"),
        "Original Feedback ID": fields.ID ?? record.metadata.feedbackId,
        "Record Type": record.recordType,
        "Original Research Record ID": record.collectedRecordId,
        "AI Source Assessment": record.sourceAssessments,
      };
      return [
        {
          recordId: record.id,
          sourceId: record.sourceId,
          values: headers.map((header) => values[header]),
        },
      ];
    }),
  };
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
  const add = (name: string, headers: string[], rows: ExportRow[], nativeCells = false) => {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(headers);
    for (const [index, row] of rows.entries()) {
      const rowNumber = index + 2;
      sheet.addRow(
        row.values.map((value, column) => {
          if (nativeCells && (typeof value === "number" || typeof value === "boolean"))
            return value;
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
  const tabular = tabularExport(data);
  add("Research_Explorer", tabular.headers, tabular.rows, true);
  const usableFeedback = new Set(
    researchTableRows(data)
      .filter((record) => record.recordType === "feedback")
      .map((record) => record.collectedRecordId),
  );
  add(
    "Feedback_Explorer",
    FEEDBACK_COLUMNS,
    feedbackRows(data).filter((row) => usableFeedback.has(row.recordId!)),
  );
  if (data.records.some((record) => Object.hasOwn(record.fields ?? {}, ASSESSMENT_FIELD)))
    add(
      "Source Assessments",
      [
        "Record ID",
        "Source ID",
        "Agent",
        "AI Verdict",
        "Reasons",
        "Uncertainties",
        "Model",
        "Content Hash",
        "Verbatim Excerpt Ranges",
        "Native Row Indexes",
        "Scope",
        "Run ID",
      ],
      data.records.flatMap((record) =>
        sourceAssessments(record).map((assessment) => ({
          recordId: record.id,
          sourceId: record.sourceId,
          values: [
            record.id,
            record.sourceId,
            assessment.agentId,
            assessment.verdict,
            assessment.reasons,
            assessment.uncertainties,
            assessment.model,
            assessment.contentHash,
            assessment.excerpts,
            assessment.tableRows,
            assessment.scope,
            assessment.runId,
          ],
        })),
      ),
    );
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
  // Native columns, not JSON-packed cells: these sheets can be selected directly in Raw.
  let tableNumber = 0;
  for (const record of data.records) {
    if (record.recordType !== "table" || !record.table) continue;
    const selection = assessedSelection(record);
    if (selection.reviewed && !selection.tableRows.size) continue;
    add(
      `Table_${++tableNumber}`,
      record.table.headers,
      record.table.rows.flatMap((values, index) =>
        selection.reviewed && !selection.tableRows.has(index)
          ? []
          : [
              {
                recordId: record.id,
                sourceId: record.sourceId,
                values,
              },
            ],
      ),
      true,
    );
  }
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
