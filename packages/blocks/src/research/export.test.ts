import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, describe, expect, it } from "vitest";
import { CollectedItem, ResearchDataset, type ResearchRecord } from "@reqflow/core";
import { createLocalDocumentReader } from "./documents/local";
import {
  exportResearchCsv,
  exportResearchJson,
  exportResearchXlsx,
  FEEDBACK_COLUMNS,
  safeSpreadsheetText,
} from "./export";
import { normalizeItem } from "./raw";

const at = "2026-10-10T12:00:00.000Z";
const directories: string[] = [];
const syntheticFeedback = "Synthetic opinion: seat adjustment is clear.\n舒适 — unverändert.";
const baseSheets = [
  "Feedback_Explorer",
  "Sources",
  "Research Records",
  "Metrics Tables",
  "Research Runs",
];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function collected(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return CollectedItem.parse({
    provider: "local_documents",
    sourceId: "file_synthetic",
    sourceUrl: "reqflow-file:///file_synthetic",
    sourceTitle: "Synthetic original",
    recordId: "synthetic-feedback",
    recordType: "feedback",
    text: syntheticFeedback,
    sourceKind: "customer_feedback",
    ...overrides,
  });
}

function dataset(items = [collected()]): ResearchDataset {
  const normalized = items.map((item) => normalizeItem(item, "bmw_sales", "run_synthetic", at));
  return ResearchDataset.parse({
    schemaVersion: 1,
    runId: "run_synthetic",
    retrievedAt: at,
    synthetic: true,
    sources: [...new Map(normalized.map(({ source }) => [source.id, source])).values()],
    records: normalized.map(({ record }) => record),
    results: [
      {
        agentId: "bmw_sales",
        status: "success",
        recordIds: normalized.map(({ record }) => record.id),
        requests: 0,
        limitations: [],
      },
    ],
  });
}

async function workbook(input: ResearchDataset): Promise<ExcelJS.Workbook> {
  const output = new ExcelJS.Workbook();
  // Read the actual ZIP/XLSX bytes, not the writer's in-memory model.
  // ExcelJS declares its own ArrayBuffer-like Buffer, incompatible with current @types/node.
  const bytes = Buffer.from(await exportResearchXlsx(input));
  await output.xlsx.load(bytes as unknown as Parameters<typeof output.xlsx.load>[0]);
  return output;
}

function sheetRows(sheet: ExcelJS.Worksheet): Record<string, ExcelJS.CellValue>[] {
  const headers = Array.from({ length: sheet.columnCount }, (_, i) =>
    String(sheet.getRow(1).getCell(i + 1).value),
  );
  return Array.from({ length: Math.max(0, sheet.rowCount - 1) }, (_, i) =>
    Object.fromEntries(
      headers.map((header, column) => [header, sheet.getRow(i + 2).getCell(column + 1).value]),
    ),
  );
}

/** Small RFC-4180 reader so quoted commas, quotes, CRLF and embedded newlines are tested as data. */
function csvRows(csv: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = "",
    quoted = false;
  const text = csv.replace(/^\ufeff/, "");
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (character === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && character === ",") {
      row.push(value);
      value = "";
    } else if (!quoted && (character === "\r" || character === "\n")) {
      if (character === "\r" && text[i + 1] === "\n") i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  if (quoted) throw new Error("Unterminated CSV quote in export");
  const [headers = [], ...body] = rows;
  return body.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

async function localFeedbackFixture(includeFeedbackType = true): Promise<ResearchDataset> {
  const source = new ExcelJS.Workbook();
  const headers = [
    "ID",
    "Source",
    "Brand",
    "Sales Description",
    "Country",
    "Derivate (e-code)",
    "Engine Type",
    "Customer Feedback",
    "Vfc level2 3 Name",
    "Vfc level2 Name",
    "Vfc level3 Name",
    "Sentiment",
    ...(includeFeedbackType ? ["Feedback Type"] : []),
  ];
  const shared = [
    "SYN-001",
    "Synthetic supplied survey",
    "Synthetic Brand",
    "Synthetic wagon",
    "DE",
    "SYN-E",
    "Synthetic electric",
    syntheticFeedback,
  ];
  source
    .addWorksheet("Feedback_Explorer")
    .addRows([
      headers,
      [
        ...shared,
        "Cabin / Seat",
        "Cabin",
        "Seat",
        "mixed",
        ...(includeFeedbackType ? ["Source-supplied praise"] : []),
      ],
      [
        ...shared,
        "Interaction / Controls",
        "Interaction",
        "Controls",
        "mixed",
        ...(includeFeedbackType ? ["Source-supplied praise"] : []),
      ],
    ]);
  source.addWorksheet("Synthetic study").addRows([
    ["Period", "Energy [kWh]", "Status"],
    [2025, 0, "ep"],
    [2026, null, ":"],
  ]);
  source.getWorksheet("Synthetic study")!.getCell("B2").note = "Synthetic original footnote.";
  const dir = await mkdtemp(path.join(tmpdir(), "reqflow-export-synthetic-"));
  directories.push(dir);
  const file = path.join(dir, "synthetic.xlsx");
  await source.xlsx.writeFile(file);
  const reader = createLocalDocumentReader({
    resolveFile: async () => ({ path: file, name: "synthetic.xlsx" }),
    doclingCommand: "reqflow-synthetic-no-docling",
  });
  return dataset(await reader.read("file_synthetic", 20, new AbortController().signal));
}

describe("research export round trips", () => {
  it("JSON preserves the complete raw dataset, including provenance and unknowns", () => {
    const input = dataset([
      collected({
        parentId: "synthetic-parent",
        threadId: "synthetic-thread",
        context: {
          text: "Synthetic original parent.\n原文",
          url: "https://sources.example.org/parent",
        },
        metadata: {
          sourceRows: [2, 3],
          classifications: [{ column: "Sentiment", value: "mixed", origin: "source_explicit" }],
        },
      }),
    ]);

    expect(JSON.parse(exportResearchJson(input))).toEqual(input);
  });

  it("writes all required XLSX sheets and retains JSON record/source IDs", async () => {
    const input = dataset([
      collected(),
      collected({
        recordId: "synthetic-study",
        recordType: "passage",
        sourceKind: "customer_study",
        text: "Synthetic study original.",
      }),
    ]);
    const json = JSON.parse(exportResearchJson(input)) as ResearchDataset;

    const book = await workbook(input);

    expect(book.worksheets.map((sheet) => sheet.name)).toEqual(expect.arrayContaining(baseSheets));
    expect(sheetRows(book.getWorksheet("Research Records")!).map((row) => row.ID)).toEqual(
      json.records.map((record) => record.id),
    );
    expect(sheetRows(book.getWorksheet("Sources")!).map((row) => row["Source ID"])).toEqual(
      json.sources.map((source) => source.id),
    );
    expect(sheetRows(book.getWorksheet("Feedback_Explorer")!).map((row) => row.ID)).toEqual([
      json.records[0]!.id,
    ]);
    expect(sheetRows(book.getWorksheet("Research Runs")!)[0]).toMatchObject({
      "Run ID": input.runId,
      Agent: "bmw_sales",
      Status: "success",
      Requests: "0",
      Synthetic: "true",
    });
  });

  it("does not count a study, forecast, table or product description as customer feedback", async () => {
    const input = dataset([
      collected(),
      ...(
        [
          "passage",
          "forecast",
          "table",
          "product_description",
          "strategy_statement",
          "metadata",
          "transcript",
        ] as const
      ).map((recordType) =>
        collected({
          recordId: `synthetic-${recordType}`,
          recordType,
          text: `Synthetic original ${recordType}.`,
        }),
      ),
    ]);

    const book = await workbook(input);

    expect(sheetRows(book.getWorksheet("Feedback_Explorer")!)).toHaveLength(1);
    expect(csvRows(exportResearchCsv(input))).toHaveLength(1);
    expect(sheetRows(book.getWorksheet("Research Records")!)).toHaveLength(input.records.length);
  });

  it("keeps unknown date, language and market cells empty instead of filling from retrieval or scope", async () => {
    const input = dataset();
    const book = await workbook(input);
    const row = sheetRows(book.getWorksheet("Feedback_Explorer")!)[0]!;

    expect(row).toMatchObject({
      "Published At": "",
      "Published Precision": "unknown",
      Language: "",
      Country: "",
      "Retrieved At": at,
    });
  });

  it("preserves table headers, row values, flags, units, footnotes and dimensions", async () => {
    const table = {
      headers: ["Year", "Energy [kWh]", "Flag"],
      rows: [
        [2025, 0, "ep"],
        [2026, null, ":"],
      ],
      units: ["kWh"],
      footnotes: ["Synthetic footnote.\nOriginal note."],
      dimensions: { geo: "DE", period: [2025, 2026] },
    };
    const input = dataset([collected({ recordType: "table", recordId: "synthetic-table", table })]);
    const book = await workbook(input);
    const rows = sheetRows(book.getWorksheet("Metrics Tables")!);

    expect(rows).toHaveLength(2);
    rows.forEach((row, index) => {
      expect(row["Record ID"]).toBe(input.records[0]!.id);
      expect(JSON.parse(String(row["Original Headers"]))).toEqual(table.headers);
      expect(JSON.parse(String(row["Original Row Values"]))).toEqual(table.rows[index]);
      expect(JSON.parse(String(row.Units))).toEqual(table.units);
      expect(JSON.parse(String(row.Footnotes))).toEqual(table.footnotes);
      expect(JSON.parse(String(row.Dimensions))).toEqual(table.dimensions);
    });
  });

  it("retains original parent/thread/context text in the written XLSX", async () => {
    const input = dataset([
      collected({
        locator: "Synthetic thread / reply 2",
        parentId: "synthetic-parent",
        threadId: "synthetic-thread",
        context: {
          id: "synthetic-parent",
          url: "https://sources.example.org/parent",
          text: "Original parent.\n请勿改写。",
        },
      }),
    ]);

    const book = await workbook(input);
    const row = sheetRows(book.getWorksheet("Research Records")!)[0]!;

    expect(row).toMatchObject({
      Locator: input.records[0]!.locator,
      "Parent ID": "synthetic-parent",
      "Thread ID": "synthetic-thread",
    });
    expect(JSON.parse(String(row.Context))).toEqual(input.records[0]!.context);
  });

  it("retains empty table headers and metadata even when no metric rows exist", async () => {
    const table = {
      headers: ["Synthetic original header"],
      rows: [],
      units: ["kWh"],
      footnotes: ["Synthetic empty source table"],
      dimensions: { original: "empty" },
    };
    const input = dataset([collected({ recordType: "table", table })]);
    const book = await workbook(input);

    expect(sheetRows(book.getWorksheet("Metrics Tables")!)).toEqual([]);
    expect(JSON.parse(String(sheetRows(book.getWorksheet("Research Records")!)[0]!.Table))).toEqual(
      table,
    );
  });

  it("does not mutate source datasets during any export", async () => {
    const input = await localFeedbackFixture();
    const before = structuredClone(input);

    exportResearchJson(input);
    exportResearchCsv(input);
    await workbook(input);

    expect(input).toEqual(before);
  });
});

describe("exports of the real local-reader metadata contract", () => {
  it("keeps the original first twelve Feedback_Explorer columns in their expected order", () => {
    expect(FEEDBACK_COLUMNS.slice(0, 12)).toEqual([
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
    ]);
  });

  it("starts with one feedback opinion carrying the exact source-supplied associations", async () => {
    const input = await localFeedbackFixture();
    const feedback = input.records.filter((record) => record.recordType === "feedback");

    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.metadata).toMatchObject({
      independentOpinionCount: 1,
      sourceRows: [2, 3],
      vfcAssociations: [
        "Cabin / Seat",
        "Cabin",
        "Seat",
        "Interaction / Controls",
        "Interaction",
        "Controls",
      ],
      classifications: [
        {
          column: "Sentiment",
          value: "mixed",
          origin: "source_explicit",
          locator: "Feedback_Explorer!L2",
        },
        {
          column: "Feedback Type",
          value: "Source-supplied praise",
          origin: "source_explicit",
          locator: "Feedback_Explorer!M2",
        },
        {
          column: "Sentiment",
          value: "mixed",
          origin: "source_explicit",
          locator: "Feedback_Explorer!L3",
        },
        {
          column: "Feedback Type",
          value: "Source-supplied praise",
          origin: "source_explicit",
          locator: "Feedback_Explorer!M3",
        },
      ],
      sourceAssociations: [
        expect.objectContaining({ sheet: "Feedback_Explorer", row: 2 }),
        expect.objectContaining({ sheet: "Feedback_Explorer", row: 3 }),
      ],
    });
  });

  it.each(["csv", "xlsx"] as const)(
    "exports both original VFC associations in %s without inventing a second opinion",
    async (format) => {
      const input = await localFeedbackFixture();
      const feedback = input.records.find((record) => record.recordType === "feedback")!;

      const rows =
        format === "csv"
          ? csvRows(exportResearchCsv(input))
          : sheetRows((await workbook(input)).getWorksheet("Feedback_Explorer")!);

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.ID)).toEqual([feedback.id, feedback.id]);
      expect(
        rows.map((row) => [
          row["Vfc level2 3 Name"],
          row["Vfc level2 Name"],
          row["Vfc level3 Name"],
        ]),
      ).toEqual([
        ["Cabin / Seat", "Cabin", "Seat"],
        ["Interaction / Controls", "Interaction", "Controls"],
      ]);
      expect(
        (JSON.parse(exportResearchJson(input)) as ResearchDataset).records.filter(
          (record) => record.recordType === "feedback",
        ),
      ).toHaveLength(1);
    },
  );

  it.each(["csv", "xlsx"] as const)(
    "maps supplied local-reader source columns into %s without fabricated Feedback Type",
    async (format) => {
      const input = await localFeedbackFixture();

      const rows =
        format === "csv"
          ? csvRows(exportResearchCsv(input))
          : sheetRows((await workbook(input)).getWorksheet("Feedback_Explorer")!);

      expect(rows[0]).toMatchObject({
        Source: "Synthetic supplied survey",
        Brand: "Synthetic Brand",
        "Sales Description": "Synthetic wagon",
        Country: "DE",
        "Derivate (e-code)": "SYN-E",
        "Engine Type": "Synthetic electric",
        "Feedback Type": "Source-supplied praise",
        "Customer Feedback": syntheticFeedback,
      });
    },
  );

  it.each(["csv", "xlsx"] as const)(
    "leaves Feedback Type blank in %s when only source sentiment exists",
    async (format) => {
      const input = await localFeedbackFixture(false);

      const rows =
        format === "csv"
          ? csvRows(exportResearchCsv(input))
          : sheetRows((await workbook(input)).getWorksheet("Feedback_Explorer")!);

      expect(rows.every((row) => row["Feedback Type"] === "")).toBe(true);
      expect(input.records.find((record) => record.recordType === "feedback")).not.toHaveProperty(
        "sentiment",
      );
    },
  );

  it.each(["csv", "xlsx"] as const)(
    "retains each association's own supplied fields and source locator in %s",
    async (format) => {
      const input = dataset([
        collected({
          metadata: {
            sourceAssociations: [
              {
                sheet: "Original feedback",
                row: 2,
                headers: ["Source", "Brand", "Country", "Feedback Type", "Vfc level3 Name"],
                values: ["Survey A", "Brand A", "DE", "Type A", "Seat"],
              },
              {
                sheet: "Original feedback",
                row: 9,
                headers: ["Country", "Brand", "Source", "Vfc level3 Name", "Sentiment"],
                values: ["FR", "Brand B", "Survey B", "Controls", "mixed"],
              },
            ],
            originalFields: {
              "Feedback Type": "Do not borrow a missing association field",
              Brand: "Do not override a source row",
            },
          },
          market: { value: "Synthetic region", origin: "provider_metadata" },
        }),
      ]);
      const rows =
        format === "csv"
          ? csvRows(exportResearchCsv(input))
          : sheetRows((await workbook(input)).getWorksheet("Feedback_Explorer")!);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        ID: input.records[0]!.id,
        Source: "Survey A",
        Brand: "Brand A",
        Country: "DE",
        "Feedback Type": "Type A",
        "Vfc level3 Name": "Seat",
        "Source Sheet": "Original feedback",
        "Source Row": "2",
      });
      expect(rows[1]).toMatchObject({
        ID: input.records[0]!.id,
        Source: "Survey B",
        Brand: "Brand B",
        Country: "FR",
        "Feedback Type": "",
        "Vfc level3 Name": "Controls",
        "Source Sheet": "Original feedback",
        "Source Row": "9",
      });
    },
  );

  it.each(["csv", "xlsx"] as const)(
    "does not turn market attribution, lowercase aliases or source sentiment into original fields in %s",
    async (format) => {
      const input = dataset([
        collected({
          provider: "reddit",
          sourceUrl: "https://sources.example.org/comment",
          publisher: "Synthetic forum",
          market: { value: "Synthetic region", origin: "author_claim" },
          vehicle: { value: "Synthetic car", origin: "provider_metadata" },
          metadata: {
            brand: "Wrong alias",
            country: "Wrong alias",
            sentiment: "mixed",
            classifications: [{ column: "Sentiment", value: "mixed", origin: "source_explicit" }],
          },
        }),
      ]);
      const rows =
        format === "csv"
          ? csvRows(exportResearchCsv(input))
          : sheetRows((await workbook(input)).getWorksheet("Feedback_Explorer")!);

      expect(rows[0]).toMatchObject({
        Brand: "",
        Country: "",
        "Sales Description": "",
        "Feedback Type": "",
      });
      expect(JSON.parse(exportResearchJson(input))).toEqual(input);
      if (format === "xlsx") {
        const records = sheetRows((await workbook(input)).getWorksheet("Research Records")!);
        expect(JSON.parse(String(records[0]!.Metadata))).toEqual(input.records[0]!.metadata);
      }
    },
  );

  it.each(["csv", "xlsx"] as const)(
    "uses only explicitly named original fields for generic providers in %s",
    async (format) => {
      const input = dataset([
        collected({
          provider: "reddit",
          sourceUrl: "https://sources.example.org/comment",
          metadata: {
            originalFields: {
              Source: "Explicit source",
              Brand: "Explicit brand",
              Country: "Explicit country",
              "Feedback Type": "Explicit type",
              "Sales Description": 0,
              "Engine Type": false,
            },
          },
        }),
      ]);
      const rows =
        format === "csv"
          ? csvRows(exportResearchCsv(input))
          : sheetRows((await workbook(input)).getWorksheet("Feedback_Explorer")!);

      expect(rows[0]).toMatchObject({
        Source: "Explicit source",
        Brand: "Explicit brand",
        Country: "Explicit country",
        "Feedback Type": "Explicit type",
        "Sales Description": "0",
        "Engine Type": "false",
      });
    },
  );

  it("rejects malformed source associations instead of silently dropping supplied rows", () => {
    const input = dataset([
      collected({
        metadata: {
          sourceAssociations: [
            {
              sheet: "Original",
              row: 2,
              headers: ["Brand", "Country"],
              values: ["Synthetic brand"],
            },
          ],
        },
      }),
    ]);

    expect(() => exportResearchCsv(input)).toThrow(/source association/i);
  });

  it("does not replace null or empty supplied association fields with provider metadata", async () => {
    const input = dataset([
      collected({
        publisher: "Do not borrow publisher",
        metadata: {
          sourceAssociations: [
            {
              sheet: "Original",
              row: 2,
              headers: ["Source", "Brand", "Country", "Feedback Type"],
              values: [null, "", null, ""],
            },
          ],
        },
      }),
    ]);

    for (const rows of [
      csvRows(exportResearchCsv(input)),
      sheetRows((await workbook(input)).getWorksheet("Feedback_Explorer")!),
    ]) {
      expect(rows[0]).toMatchObject({ Source: "", Brand: "", Country: "", "Feedback Type": "" });
    }
  });
});

describe("spreadsheet-safe original text", () => {
  const dangerous = [
    "=1+1",
    "+SUM(1,2)",
    "-1+1",
    "@SUM(1,2)",
    "  =1+1",
    "\t=1+1",
    "\r\n+1",
    "\u0000=1+1",
    "\u000b-1",
    "\u000c@SUM(1,2)",
    "\u001f =1",
    "\u00a0=1",
    "\u2003@SUM(1,2)",
    "\ufeff=1",
    '\t \r\n="舒适"',
  ];

  it.each(dangerous)("neutralizes a formula after whitespace/control prefix: %j", (text) => {
    expect(safeSpreadsheetText(text)).toBe(`'${text}`);
  });

  it.each([
    "Synthetic = literal in prose",
    '"quoted", café — 舒适\nsecond line\r\nthird',
    "'already text",
    "",
    "123",
  ])("preserves nonformula Unicode and multiline originals: %j", (text) => {
    expect(safeSpreadsheetText(text)).toBe(text);
  });

  it("represents null, scalars and structured metadata without evaluating them", () => {
    expect(
      [null, undefined, 0, false, { original: "舒适\nexact" }].map(safeSpreadsheetText),
    ).toEqual(["", "", "0", "false", '{"original":"舒适\\nexact"}']);
  });

  it("guards every dangerous CSV original, including controls, without changing JSON", () => {
    const input = dataset(
      dangerous.map((text, index) => collected({ text, recordId: `synthetic-${index}` })),
    );

    const rows = csvRows(exportResearchCsv(input));

    expect(rows.map((row) => row["Customer Feedback"])).toEqual(
      dangerous.map((text) => `'${text}`),
    );
    expect(
      (JSON.parse(exportResearchJson(input)) as ResearchDataset).records.map(
        (record) => record.text,
      ),
    ).toEqual(dangerous);
  });

  it("writes dangerous XLSX originals as text, never formulas, across whitespace and control prefixes", async () => {
    const input = dataset(
      dangerous.map((text, index) => collected({ text, recordId: `synthetic-${index}` })),
    );
    const book = await workbook(input);

    for (const [sheetName, header] of [
      ["Feedback_Explorer", "Customer Feedback"],
      ["Research Records", "Original Text"],
    ]) {
      const sheet = book.getWorksheet(sheetName!)!;
      const column =
        Array.from(
          { length: sheet.columnCount },
          (_, i) => sheet.getRow(1).getCell(i + 1).value,
        ).indexOf(header!) + 1;
      expect(column).toBeGreaterThan(0);
      dangerous.forEach((_text, index) => {
        const cell = sheet.getRow(index + 2).getCell(column);
        expect(cell.type).toBe(ExcelJS.ValueType.String);
        expect(cell.formula).toBeUndefined();
        expect(String(cell.value)).toMatch(/^'/);
      });
    }
  });

  it("round-trips Unicode, commas, quotes and original newlines through both spreadsheets", async () => {
    const text = 'Synthetic, "original": café — 舒适\n第二行\r\nthird line 😀';
    const input = dataset([collected({ text })]);
    const book = await workbook(input);

    expect(csvRows(exportResearchCsv(input))[0]?.["Customer Feedback"]).toBe(text);
    expect(sheetRows(book.getWorksheet("Feedback_Explorer")!)[0]?.["Customer Feedback"]).toBe(text);
    expect(sheetRows(book.getWorksheet("Research Records")!)[0]?.["Original Text"]).toBe(text);
  });

  it("preserves standalone CR and CRLF, including literal XML entities, in every string view", async () => {
    const text = "Synthetic\rstandalone\r\npaired\nLF &#13; literal 😀";
    const input = dataset([collected({ text, sourceTitle: text, publisher: text })]);
    const book = await workbook(input);

    expect(sheetRows(book.getWorksheet("Sources")!)[0]).toMatchObject({
      Title: text,
      Publisher: text,
    });
    expect(sheetRows(book.getWorksheet("Feedback_Explorer")!)[0]!["Customer Feedback"]).toBe(text);
    expect(sheetRows(book.getWorksheet("Research Records")!)[0]!["Original Text"]).toBe(text);
  });

  it("does not confuse literal source text with XLSX transport tokens or XML markup", async () => {
    const text = "reqflow-string-0 <t>reqflow-string-1</t> &amp; &#13; 😀\r\n";
    const book = await workbook(dataset([collected({ text })]));

    expect(sheetRows(book.getWorksheet("Feedback_Explorer")!)[0]!["Customer Feedback"]).toBe(text);
  });

  it("neutralizes formula-bearing source titles and publishers in written XLSX", async () => {
    const input = dataset([collected({ sourceTitle: "\t=1+1", publisher: " @SUM(1,2)" })]);
    const book = await workbook(input);

    expect(sheetRows(book.getWorksheet("Sources")!)[0]).toMatchObject({
      Title: "'\t=1+1",
      Publisher: "' @SUM(1,2)",
    });
    expect(sheetRows(book.getWorksheet("Feedback_Explorer")!)[0]?.Source).toBe("' @SUM(1,2)");
  });
});

describe("Excel cell limits without loss of raw evidence", () => {
  function overflowOriginal(
    book: ExcelJS.Workbook,
    sheet: string,
    row: number,
    column: string,
  ): string {
    const segments = sheetRows(book.getWorksheet("Cell Overflow")!).filter(
      (segment) =>
        segment.Sheet === sheet && segment.Row === String(row) && segment["Column Name"] === column,
    );
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.map((segment) => segment["Segment Order"])).toEqual(
      segments.map((_, index) => String(index + 1)),
    );
    return segments
      .map((segment) => JSON.parse(String(segment["Original Segment JSON"])) as string)
      .join("");
  }

  function expectBoundedCells(book: ExcelJS.Workbook) {
    for (const sheet of book.worksheets)
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          if (typeof cell.value === "string")
            expect(cell.value.length, `${sheet.name}!${cell.address}`).toBeLessThanOrEqual(32767);
          expect(cell.formula).toBeUndefined();
        }),
      );
  }

  function longDataset(): ResearchDataset {
    const text = Array.from(
      { length: 1600 },
      (_, index) => `Synthetic segment ${String(index).padStart(4, "0")}: 舒适 — original.\n`,
    ).join("");
    return dataset([collected({ text })]);
  }

  it("preserves an original exactly at the 32767-character boundary", async () => {
    const text = "S".repeat(32767);
    const book = await workbook(dataset([collected({ text })]));

    expect(sheetRows(book.getWorksheet("Research Records")!)[0]?.["Original Text"]).toBe(text);
  });

  it("never writes a string cell beyond Excel's 32767-character limit", async () => {
    const input = longDataset();
    const book = await workbook(input);

    const oversized: { sheet: string; address: string; length: number }[] = [];
    for (const sheet of book.worksheets)
      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          if (typeof cell.value === "string" && cell.value.length > 32767)
            oversized.push({ sheet: sheet.name, address: cell.address, length: cell.value.length });
        }),
      );
    expect(oversized).toEqual([]);
  });

  it("retains the complete original in ordered overflow segments associated with its record ID", async () => {
    const input = longDataset();
    const record: ResearchRecord = input.records[0]!;
    const book = await workbook(input);

    // Do not prescribe an overflow sheet name/header spelling. Require separate, record-linked
    // bounded segments in sheet order that can reconstruct the verbatim original.
    const segmentGroups = book.worksheets
      .filter((sheet) => !baseSheets.includes(sheet.name))
      .map((sheet) => {
        const segments: string[] = [];
        sheet.eachRow((row) => {
          const values: ExcelJS.CellValue[] = [];
          row.eachCell((cell) => values.push(cell.value));
          if (!values.includes(record.id)) return;
          for (const value of values)
            if (
              typeof value === "string" &&
              value.length > 20 &&
              value.length <= 32767 &&
              record.text.includes(value)
            )
              segments.push(value);
        });
        return segments;
      });

    expect(
      segmentGroups.some((segments) => {
        // A workbook may repeat overflow for multiple views of the same field. Accept an ordered
        // reconstruction from record-linked segments without requiring a particular storage layout.
        let reconstructed = "",
          used = 0;
        for (const segment of segments) {
          if (record.text.startsWith(segment, reconstructed.length)) {
            reconstructed += segment;
            used++;
          }
        }
        return used > 1 && reconstructed === record.text;
      }),
    ).toBe(true);
    expect((JSON.parse(exportResearchJson(input)) as ResearchDataset).records[0]?.text).toBe(
      record.text,
    );
  });

  it("preserves long source fields, table metadata, context and run limitations with cell-level lineage", async () => {
    const text = 'Synthetic \\"😀\r\n舒适\r\n'.repeat(4000);
    const table = {
      headers: [text],
      rows: [[text, 0, false, null]],
      units: [text],
      footnotes: [text],
      dimensions: { original: text },
    };
    const input = dataset([
      collected({
        sourceTitle: text,
        publisher: text,
        text,
        metadata: { original: text },
        context: { text },
        table,
      }),
    ]);
    input.results[0]!.limitations = [text];
    const before = structuredClone(input);
    const book = await workbook(input);

    expectBoundedCells(book);
    expect(overflowOriginal(book, "Sources", 2, "Title")).toBe(text);
    expect(overflowOriginal(book, "Sources", 2, "Publisher")).toBe(text);
    expect(overflowOriginal(book, "Research Records", 2, "Original Text")).toBe(text);
    expect(JSON.parse(overflowOriginal(book, "Research Records", 2, "Metadata"))).toEqual(
      input.records[0]!.metadata,
    );
    expect(JSON.parse(overflowOriginal(book, "Research Records", 2, "Context"))).toEqual(
      input.records[0]!.context,
    );
    for (const [column, original] of [
      ["Original Headers", table.headers],
      ["Original Row Values", table.rows[0]],
      ["Units", table.units],
      ["Footnotes", table.footnotes],
      ["Dimensions", table.dimensions],
    ] as const) {
      expect(JSON.parse(overflowOriginal(book, "Metrics Tables", 2, column))).toEqual(original);
    }
    expect(JSON.parse(overflowOriginal(book, "Research Runs", 2, "Limitations"))).toEqual([text]);
    const segments = sheetRows(book.getWorksheet("Cell Overflow")!).filter(
      (segment) =>
        segment.Sheet === "Research Records" && segment["Column Name"] === "Original Text",
    );
    expect(
      segments.every(
        (segment) =>
          segment["Record ID"] === input.records[0]!.id &&
          segment["Source ID"] === input.records[0]!.sourceId &&
          segment.Column === "4" &&
          segment.Serialization === "string",
      ),
    ).toBe(true);
    expect(input).toEqual(before);
    expect(JSON.parse(exportResearchJson(input))).toEqual(input);
  });

  it("reconstructs formula-bearing overflow segments without confusing guards with original apostrophes", async () => {
    const text = '\t="Synthetic 😀"\r\n' + "'original\\\"\n".repeat(5000);
    const input = dataset([collected({ text })]);
    const book = await workbook(input);

    expectBoundedCells(book);
    expect(overflowOriginal(book, "Feedback_Explorer", 2, "Customer Feedback")).toBe(text);
    expect(overflowOriginal(book, "Research Records", 2, "Original Text")).toBe(text);
    expect(JSON.parse(exportResearchJson(input))).toEqual(input);
  });

  it("allows formula guards at the limit without emitting a 32768-character cell", async () => {
    const text = "=" + "S".repeat(32766);
    const book = await workbook(dataset([collected({ text })]));

    expectBoundedCells(book);
    expect(overflowOriginal(book, "Research Records", 2, "Original Text")).toBe(text);
  });

  it("guards formula prefixes introduced by overflow boundaries without changing the original", async () => {
    const text = "S".repeat(32765) + "=Synthetic continuation";
    const input = dataset([collected({ text })]);
    const book = await workbook(input);
    const segments = sheetRows(book.getWorksheet("Cell Overflow")!).filter(
      (segment) =>
        segment.Sheet === "Research Records" && segment["Column Name"] === "Original Text",
    );

    expectBoundedCells(book);
    expect(segments[1]!["Original Segment"]).toBe("'=Synthetic continuation");
    expect(overflowOriginal(book, "Research Records", 2, "Original Text")).toBe(text);
  });

  it("retains XML-unrepresentable original controls in serialized overflow segments", async () => {
    const text = "\u0000\u000b\u000c\u001f =Synthetic original\u007f\r\n😀";
    const book = await workbook(dataset([collected({ text })]));

    expectBoundedCells(book);
    expect(overflowOriginal(book, "Research Records", 2, "Original Text")).toBe(text);
  });
});
