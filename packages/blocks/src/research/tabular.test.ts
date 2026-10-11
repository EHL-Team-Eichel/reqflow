import ExcelJS from "exceljs";
import type { z } from "zod";
import { describe, expect, it } from "vitest";
import { CollectedItem, DEFAULT_SETTINGS, ResearchDataset } from "@reqflow/core";
import { readSpreadsheet } from "../raw/read";
import { toTable } from "../raw/table";
import { tableToRecords } from "../raw/records";
import { exportResearchCsv, exportResearchXlsx } from "./export";
import { normalizeItem } from "./raw";
import { BMW_FEEDBACK_HEADERS, researchTableRows } from "./tabular";
import { jsonByteSize, PERSISTED_JSON_MAX_BYTES } from "./data-budget";

const at = "2026-10-11T12:00:00.000Z";
function dataset(input: Partial<z.input<typeof CollectedItem>>): ResearchDataset {
  const item = CollectedItem.parse({
    provider: "firecrawl",
    sourceId: "synthetic",
    sourceUrl: "https://example.invalid/review",
    sourceTitle: "Synthetic review",
    recordId: "review",
    recordType: "passage",
    text: "Synthetic text.",
    ...input,
  });
  const { source, record } = normalizeItem(item, "editorial_reviews", "run_synthetic", at);
  return ResearchDataset.parse({
    schemaVersion: 1,
    runId: "run_synthetic",
    sources: [source],
    records: [record],
    results: [],
    retrievedAt: at,
    synthetic: true,
  });
}

async function workbook(data: ResearchDataset) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    Buffer.from(await exportResearchXlsx(data)) as unknown as Parameters<typeof book.xlsx.load>[0],
  );
  return book;
}

describe("Raw-compatible research tables", () => {
  it("puts feedback in the same flat columns as Raw, preserving only source-supplied classifications", () => {
    const originalFields: Record<string, string | null> = Object.fromEntries(
      BMW_FEEDBACK_HEADERS.map((header) => [header, null]),
    );
    Object.assign(originalFields, {
      ID: "SYN-1",
      Source: "Synthetic survey",
      Brand: "Synthetic brand",
      "Customer Feedback": "Synthetic opinion.",
      "Feedback Type": "Supplied type",
      "Vfc level2 Name": "Supplied category",
    });
    const input = dataset({
      recordType: "feedback",
      text: "Synthetic opinion.",
      metadata: { originalFields },
    });
    const before = structuredClone(input);
    const [row] = researchTableRows(input);
    const raw = tableToRecords(
      toTable([
        BMW_FEEDBACK_HEADERS,
        BMW_FEEDBACK_HEADERS.map((header) => originalFields[header] ?? null),
      ]),
      {
        key: "synthetic",
        title: "Synthetic",
        dataset: "customer_feedback",
        scope: DEFAULT_SETTINGS.defaultScope,
        retrievedAt: at,
      },
    );
    for (const header of BMW_FEEDBACK_HEADERS)
      expect(row!.fields![header]).toEqual(raw.records[0]!.fields![header]);
    expect(row!.text).toBe(raw.records[0]!.text);
    expect(input).toEqual(before);
  });

  it("keeps one multi-paragraph comment as one opinion and leaves unknown attributes empty", () => {
    const input = dataset({
      recordType: "feedback",
      text: "Synthetic comment.\n\nStill the same opinion.",
    });
    const rows = researchTableRows(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields).toMatchObject({
      Brand: null,
      Country: null,
      "Derivate (e-code)": null,
      "Feedback Type": null,
      "Vfc level2 Name": null,
    });
    expect(rows[0]!.text).toBe(input.records[0]!.text);
  });

  it("turns review paragraphs into stable verbatim rows with exact locators", () => {
    const text =
      "Synthetic first paragraph.\r\nContinuation.\r\n\r\nSynthetic second paragraph — 舒适.";
    const input = dataset({ text, locator: "article" });
    const first = researchTableRows(input);
    expect(first).toHaveLength(2);
    expect(first.map((row) => row.text)).toEqual([
      "Synthetic first paragraph.\r\nContinuation.",
      "Synthetic second paragraph — 舒适.",
    ]);
    expect(researchTableRows(input).map((row) => row.id)).toEqual(first.map((row) => row.id));
    for (const row of first) {
      expect(text).toContain(row.text);
      expect(row.locator).toMatch(/^article, chars \d+–\d+$/);
      expect(row.collectedRecordId).toBe(input.records[0]!.id);
      expect(row.sourceId).toBe(input.records[0]!.sourceId);
      expect(row.originalUrl).toBe(input.records[0]!.originalUrl);
    }
    expect(first[0]!.contentHash).not.toBe(input.records[0]!.contentHash);
  });

  it("keeps bulk page metadata in the archive instead of repeating it in hundreds of paragraph rows", () => {
    const paragraphs = Array.from({ length: 400 }, (_, index) => `Synthetic paragraph ${index}.`);
    const rawHtml = "Synthetic original HTML ".padEnd(256 * 1024, "H");
    const pages = [{ markdown: "Synthetic PDF page ".padEnd(32 * 1024, "P") }];
    const input = dataset({
      text: paragraphs.join("\n\n"),
      metadata: { rawHtml, pages, description: "Synthetic page description", statusCode: 200 },
    });
    const before = structuredClone(input);
    const rows = researchTableRows(input);
    expect(rows.map((row) => row.text)).toEqual(paragraphs);
    expect(jsonByteSize(rows)).toBeLessThan(2 * 1024 * 1024);
    expect(jsonByteSize(rows)).toBeLessThan(PERSISTED_JSON_MAX_BYTES);
    for (const row of rows) {
      expect(row.collectedRecordId).toBe(input.records[0]!.id);
      expect(row.sourceId).toBe(input.records[0]!.sourceId);
      expect(row.originalUrl).toBe(input.records[0]!.originalUrl);
      expect(row.metadata).toEqual({ description: "Synthetic page description", statusCode: 200 });
      expect(row).toHaveProperty("archivedMetadataKeys", ["rawHtml", "pages"]);
    }
    expect(input).toEqual(before);
    expect(input.records[0]!.metadata.rawHtml).toBe(rawHtml);
    expect(input.records[0]!.metadata.pages).toEqual(pages);
  });

  it("also archive-backs arbitrary bulk metadata on native table rows, retaining every supplied cell", () => {
    const values = Array.from({ length: 400 }, (_, index) => [index, index % 2 === 0]);
    const input = dataset({
      recordType: "table",
      table: { headers: ["Metric", "Enabled"], rows: values },
      metadata: {
        providerPayload: "Synthetic provider response ".padEnd(256 * 1024, "S"),
        originalArtifact: { fileId: "file_synthetic" },
      },
    });
    const before = structuredClone(input);
    const rows = researchTableRows(input);
    expect(rows.map((row) => [row.fields!.Metric, row.fields!.Enabled])).toEqual(values);
    expect(jsonByteSize(rows)).toBeLessThan(2 * 1024 * 1024);
    for (const row of rows) {
      expect(row.metadata).toEqual({ originalArtifact: { fileId: "file_synthetic" } });
      expect(row.archivedMetadataKeys).toEqual(["providerPayload"]);
      expect(row.collectedRecordId).toBe(input.records[0]!.id);
    }
    expect(input).toEqual(before);
  });

  it("bounds the total retained metadata, with every archive-backed value resolvable from lineage", () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [`synthetic_${index}`, "S".repeat(512)]),
    );
    const input = dataset({ text: "First synthetic paragraph.\n\nSecond paragraph.", metadata });
    for (const row of researchTableRows(input)) {
      expect(jsonByteSize(row.metadata)).toBeLessThanOrEqual(8 * 1024);
      const collected = input.records.find((record) => record.id === row.collectedRecordId)!;
      const restored = {
        ...row.metadata,
        ...Object.fromEntries(
          row.archivedMetadataKeys!.map((key) => [key, collected.metadata[key]]),
        ),
      };
      expect(restored).toEqual(metadata);
    }
  });

  it("keeps repeated supplied VFC rows as one opinion with list-valued fields, like Raw", () => {
    const input = dataset({
      recordType: "feedback",
      text: "Synthetic opinion.",
      metadata: {
        sourceAssociations: [
          {
            headers: ["ID", "Customer Feedback", "Vfc level2 Name"],
            values: ["SYN-1", "Synthetic opinion.", "Synthetic comfort"],
            sheet: "Feedback_Explorer",
            row: 2,
          },
          {
            headers: ["ID", "Customer Feedback", "Vfc level2 Name"],
            values: ["SYN-1", "Synthetic opinion.", "Synthetic seating"],
            sheet: "Feedback_Explorer",
            row: 3,
          },
        ],
      },
    });
    const rows = researchTableRows(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fields).toMatchObject({
      ID: "SYN-1",
      Country: null,
      "Vfc level2 Name": ["Synthetic comfort", "Synthetic seating"],
    });
  });

  it("keeps native metric columns and numeric values, and reimports the actual Excel sheet through Raw", async () => {
    const headers = ["market", "market_code", "volume_2024", "volume_2025", "volume_2030"];
    const values = [
      ["Synthetic market", "ZZ", 10, 12, 15],
      ["Other synthetic market", "YY", 20, 23, null],
    ];
    const input = dataset({
      recordType: "table",
      table: { headers, rows: values },
      text: "Synthetic table.",
    });
    const rows = researchTableRows(input);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.fields).toMatchObject({ market_code: "ZZ", volume_2024: 10, volume_2030: 15 });
    expect(rows[1]!.fields!.volume_2030).toBeNull();
    const bytes = await exportResearchXlsx(input);
    const parsed = await readSpreadsheet("synthetic.xlsx", bytes, "Table_1");
    const table = toTable(parsed.rows);
    expect(table.header).toEqual(headers);
    expect(table.rows.map((row) => row.cells)).toEqual(
      values.map((row) => row.map((cell) => cell ?? null)),
    );
    const raw = tableToRecords(table, {
      key: "synthetic",
      title: "Synthetic",
      dataset: "sales_volume",
      scope: DEFAULT_SETTINGS.defaultScope,
      retrievedAt: at,
    });
    for (let index = 0; index < rows.length; index++)
      for (const header of headers)
        expect(rows[index]!.fields![header]).toEqual(raw.records[index]!.fields![header]);
    const book = await workbook(input);
    expect(book.worksheets[0]!.name).toBe("Research_Explorer");
    expect(book.getWorksheet("Research_Explorer")!.rowCount).toBe(3);
    const explorer = book.getWorksheet("Research_Explorer")!;
    const volumeColumn = explorer.getRow(1).values as string[];
    expect(explorer.getCell(2, volumeColumn.indexOf("volume_2024")).value).toBe(10);
    expect(exportResearchCsv(input)).toContain("volume_2030");
  });

  it("preserves supplied columns that share provenance names without overwriting lineage", async () => {
    const input = dataset({
      recordType: "table",
      table: {
        headers: ["Source ID", "Source Column: Source ID", "Record Type"],
        rows: [["Supplied source value", "Supplied prefixed value", "Supplied type"]],
      },
    });
    const book = await workbook(input);
    const sheet = book.getWorksheet("Research_Explorer")!;
    const columns = sheet.getRow(1).values as string[];
    const cell = (header: string) => sheet.getCell(2, columns.indexOf(header)).value;
    expect(cell("Source ID")).toBe(input.records[0]!.sourceId);
    expect(cell("Record Type")).toBe("table");
    expect(cell("Source Column: Source Column: Source ID")).toBe("Supplied source value");
    expect(cell("Source Column: Source ID")).toBe("Supplied prefixed value");
    expect(cell("Source Column: Record Type")).toBe("Supplied type");
    expect(exportResearchCsv(input)).toContain("Supplied source value");
  });

  it("exports a web-review-only run as an actual Raw-readable table, including all paragraphs", async () => {
    const input = dataset({ text: "Synthetic review paragraph.\n\nSecond synthetic paragraph." });
    const parsed = await readSpreadsheet(
      "synthetic.xlsx",
      await exportResearchXlsx(input),
      "Research_Explorer",
    );
    const table = toTable(parsed.rows);
    expect(table.header.slice(0, 12)).toEqual(BMW_FEEDBACK_HEADERS);
    const raw = tableToRecords(table, {
      key: "synthetic",
      title: "Synthetic",
      dataset: "customer_feedback",
      scope: DEFAULT_SETTINGS.defaultScope,
      retrievedAt: at,
    });
    expect(raw.records.map((row) => row.text)).toEqual(
      researchTableRows(input).map((row) => row.text),
    );
    expect(exportResearchCsv(input)).toContain("Second synthetic paragraph.");
    expect(input.records).toHaveLength(1);
  });

  it.each([
    { headers: ["duplicate", "duplicate"], rows: [[1, 2]] },
    { headers: ["one"], rows: [[1, 2]] },
  ])("rejects ambiguous table columns instead of silently discarding cells", (table) => {
    expect(() => researchTableRows(dataset({ recordType: "table", table }))).toThrow(/header/);
  });
});
