import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defaultBlockParams,
  DEFAULT_SETTINGS,
  PipelineData,
  type AuditEventInput,
  type StoredFile,
} from "@reqflow/core";
import type { BlockContext } from "@reqflow/engine";
import readXlsxFile from "read-excel-file/node";
import { afterAll, describe, expect, it } from "vitest";
import { findColumn, parseNumber } from "./columns";
import { decodeText, detectDelimiter, parseCsv } from "./csv";
import { assertReadOnlyQuery } from "./database";
import { categoryFor } from "./findings";
import { guessLanguage, normalizeLanguage } from "./language";
import { rawBlock } from "./raw";
import { toTable } from "./table";

const SAMPLES = join(import.meta.dirname, "../../../../data/samples");
const sample = (name: string): StoredFile => ({
  id: `file_${name.replace(/\W/g, "")}`,
  name,
  mimeType: "application/octet-stream",
  bytes: new Uint8Array(readFileSync(join(SAMPLES, name))),
});

function context(files: StoredFile[] = []) {
  const logs: string[] = [];
  const audit: AuditEventInput[] = [];
  const ctx = {
    runId: "run_test0001",
    blockId: "raw-1",
    scope: DEFAULT_SETTINGS.defaultScope,
    files: {
      get: async (id: string) => {
        const f = files.find((x) => x.id === id);
        if (!f) throw new Error(`no file ${id}`);
        return f;
      },
    },
    audit: {
      record: async (e: AuditEventInput) => (
        audit.push(e),
        { ...e, id: "aud_x", at: "", changes: [] }
      ),
    },
    log: (m: string) => logs.push(m),
    signal: new AbortController().signal,
  } as unknown as BlockContext;
  return { ctx, logs, audit };
}

const params = (patch: Record<string, unknown>) => ({ ...defaultBlockParams("raw"), ...patch });
async function ingest(file: StoredFile, patch: Record<string, unknown>) {
  const c = context([file]);
  const result = await rawBlock.run(
    {},
    params({ file: { fileId: file.id, name: file.name }, ...patch }),
    c.ctx,
  );
  if (result.status !== "ok") throw new Error("expected ok");
  return { data: PipelineData.parse(result.outputs.out), ...c };
}

describe("CSV reading", () => {
  it("handles quotes, escaped quotes, line breaks in quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n"multi\nline",2\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["multi\nline", "2"],
    ]);
    expect(() => parseCsv('a,b\n"open,2\n')).toThrow(/Line 2: a quoted value is never closed/);
  });

  it("detects the delimiter and decodes German Excel exports", () => {
    expect(detectDelimiter("a;b;c\n1,5;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
    expect(decodeText(Buffer.from("Größe", "latin1"))).toBe("Größe");
  });
});

describe("table and columns", () => {
  it("names blank headers, renames duplicates, reports empty rows, refuses stray values", () => {
    const t = toTable([[], ["a", "", "a"], [1, 2, 3], [null, "", null], [4, 5, 6]]);
    expect(t.header).toEqual(["a", "column_2", "a_2"]);
    expect(t.rows.map((r) => r.line)).toEqual([3, 5]);
    expect(t.notes.join(" ")).toMatch(
      /empty row\(s\) above the header.*column_2.*a_2.*Skipped 1 empty row 4/,
    );
    expect(() => toTable([["a"], [1, "extra"]])).toThrow(/Row 2 has a value in column 2/);
    expect(() => toTable([[null], [""]])).toThrow(/empty/);
  });

  it("finds columns by English and German names", () => {
    expect(findColumn(["Markt", "Ausstattung", "Einbaurate %"], "takeRate")).toBe(2);
    expect(findColumn(["Markt", "Ausstattung"], "option")).toBe(1);
    expect(findColumn(["Model", "Modelljahr"], "model")).toBe(0);
    expect(findColumn(["foo"], "text")).toBe(-1);
  });

  it("parses numbers the way exports write them", () => {
    expect(parseNumber("84,5")).toBe(84.5);
    expect(parseNumber("84 %")).toBe(84);
    expect(parseNumber("1.234")).toBe(1234);
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("0,845")).toBe(0.845);
    expect(parseNumber("n/a")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });

  it("guesses and normalises languages", () => {
    expect(guessLanguage("Im Fond ist die Beinfreiheit für Erwachsene zu knapp")).toBe("de");
    expect(guessLanguage("Rear legroom is too tight for adults and the boot is small")).toBe("en");
    expect(guessLanguage("后排空间太小")).toBe("zh");
    expect(guessLanguage("ok")).toBeUndefined();
    expect(normalizeLanguage("DE")).toBe("de");
    expect(normalizeLanguage("en_gb")).toBe("en-GB");
    expect(normalizeLanguage("Deutsch")).toBe("de");
  });

  it("maps equipment to customer-facing categories", () => {
    expect(categoryFor("", "Sitzheizung vorn")).toBe("comfort");
    expect(categoryFor("", "M Sportpaket")).toBe("variants_packages");
    expect(categoryFor("", "Head-up-Display")).toBe("driver_assistance");
    expect(categoryFor("comfort", "anything")).toBe("comfort");
    expect(categoryFor("", "something unknown")).toBe("variants_packages");
  });
});

describe("Raw block on the synthetic samples", () => {
  it("customer feedback: one record per comment, language and market per row, empty comment reported", async () => {
    const { data, logs, audit } = await ingest(sample("customer_feedback.csv"), {
      dataset: "customer_feedback",
    });
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0]).toMatchObject({
      kind: "customer_feedback",
      origin: "bmw_internal",
      reliability: "high",
    });
    expect(data.records).toHaveLength(35);
    const first = data.records[0]!;
    expect(first).toMatchObject({ language: "de", market: "DE", locator: "row 2" });
    expect(first.text).toMatch(/^Im Fond ist die Beinfreiheit/);
    expect(first.fields).toMatchObject({ feedback_id: "FB-0001", rating: "2" });
    expect(data.records.some((r) => r.text.includes("\n"))).toBe(true); // quoted line break kept
    expect(data.findings).toHaveLength(0); // free text: findings come from the AI Filter
    expect(logs.join("\n")).toMatch(/Skipped 1 row 36 without comment text/);
    expect(audit.map((a) => a.action)).toEqual(["source.ingested"]);
  });

  it("equipment take rates: German CSV, findings for very high and very low rates, bad rows reported", async () => {
    const { data, logs } = await ingest(sample("equipment_take_rates.csv"), {
      dataset: "equipment_data",
    });
    expect(data.records).toHaveLength(17);
    expect(data.records[0]!.text).toMatch(
      /^Markt: EU; Modell: 5 Series; .*Ausstattung: Sitzheizung vorn/,
    );
    const statements = data.findings.map((f) => f.statement);
    expect(statements).toContain(
      'Take rate of "Sitzheizung vorn" is 86.4% (EU 5 Series Sedan): most buyers choose it, so customers expect it as standard.',
    );
    expect(statements.some((s) => s.includes('"Rear Seat Entertainment" is only 4.9%'))).toBe(true);
    expect(statements.some((s) => s.includes("Head-up-Display"))).toBe(false); // 41 %: no signal
    // high: 86.4, 72.9, 91.3, 79.8 · low: 12.6, 4.9, 9.7, 15.0
    expect(data.findings).toHaveLength(8);
    for (const f of data.findings) {
      expect(f.kind).toBe("usage_pattern");
      const record = data.records.find((r) => r.id === f.evidence[0]!.recordId)!;
      expect(record.text).toContain(f.evidence[0]!.excerpt); // verbatim evidence
    }
    expect(data.findings.find((f) => f.statement.includes("Sitzheizung vorn"))!.category).toBe(
      "comfort",
    );
    expect(logs.join("\n")).toMatch(/Take rate missing or not a percentage in row 18/);
  });

  it("sales volumes: growth and decline per derivative, launches without a base year noted", async () => {
    const { data, logs } = await ingest(sample("sales_volumes.csv"), { dataset: "sales_volume" });
    expect(data.records).toHaveLength(12);
    const statements = data.findings.map((f) => f.statement);
    expect(statements).toContain(
      "Sales of EU 5 Series Touring rose 21.8% from 2023 to 2025 (28,900 → 35,200 units).",
    );
    expect(statements).toContain(
      "Sales of EU 5 Series i5 Sedan rose 139.3% from 2023 to 2025 (6,100 → 14,600 units).",
    );
    // Sedan: 41,200 → 37,100 is −9.95 %, just under the 10 % threshold, so no finding.
    expect(statements.some((s) => s.startsWith("Sales of EU 5 Series Sedan "))).toBe(false);
    expect(data.findings).toHaveLength(2);
    expect(data.findings.every((f) => f.evidence.length === 2)).toBe(true);
    expect(logs.join("\n")).toMatch(/i5 Touring: no sales in 2023/);
  });

  it("customer study workbook: first sheet by default, a named sheet on request", async () => {
    const file = sample("customer_study.xlsx");
    const results = await ingest(file, { dataset: "customer_study" });
    expect(results.data.records).toHaveLength(7);
    expect(results.data.records[0]!.locator).toBe("Results, row 2");
    expect(results.logs.join("\n")).toMatch(/first of 2 sheets \("Results"\)/);
    expect(results.logs.join("\n")).toMatch(/No comment column found/);

    const verbatims = await ingest(file, { dataset: "customer_study", sheet: "verbatims" });
    expect(verbatims.data.records).toHaveLength(6);
    expect(verbatims.data.records[1]).toMatchObject({ language: "de" });
    expect(verbatims.data.sources[0]!.title).toBe("customer_study.xlsx · Verbatims");
    expect(verbatims.data.sources[0]!.id).not.toBe(results.data.sources[0]!.id);

    await expect(ingest(file, { dataset: "customer_study", sheet: "Nope" })).rejects.toThrow(
      /no sheet "Nope". Sheets: "Results", "Verbatims"/,
    );
  });

  it("is deterministic: the same file gives the same ids", async () => {
    const a = await ingest(sample("sales_volumes.csv"), { dataset: "sales_volume" });
    const b = await ingest(sample("sales_volumes.csv"), { dataset: "sales_volume" });
    expect(b.data.records.map((r) => r.id)).toEqual(a.data.records.map((r) => r.id));
    expect(b.data.findings.map((f) => f.id)).toEqual(a.data.findings.map((f) => f.id));
  });

  it("explains what's wrong instead of failing silently", async () => {
    const { ctx } = context();
    await expect(rawBlock.run({}, params({}), ctx)).rejects.toThrow(/Choose an Excel or CSV file/);
    const xls: StoredFile = {
      id: "file_old",
      name: "old.xls",
      mimeType: "",
      bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]),
    };
    await expect(ingest(xls, {})).rejects.toThrow(/old \.xls file/);
    const broken: StoredFile = {
      id: "file_broken",
      name: "broken.xlsx",
      mimeType: "",
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]),
    };
    await expect(ingest(broken, {})).rejects.toThrow(/couldn't be read as an Excel file/);
  });
});

const csvFile = (name: string, text: string): StoredFile => ({
  id: `file_${name.replace(/\W/g, "")}`,
  name,
  mimeType: "text/csv",
  bytes: new TextEncoder().encode(text),
});

describe("Raw block on the shapes of BMW's exports (synthetic stand-ins)", () => {
  it("report sheets: title row, column groups, section titles", () => {
    const t = toTable([
      [null, "Study 2030"],
      [null, "North", null, "South"],
      ["Comfort", "Car A", "Car B", "Car A"],
      ["Mean", 7.1, 7.4, 6.9],
      ["Quietness", null, null, null],
      ["Mean", 6.2, 6.8, 7],
      ["Space"],
      ["Mean", 5, 6, 7],
    ]);
    expect(t.header).toEqual([
      "Section",
      "Label",
      "Car A (North)",
      "Car B (North)",
      "Car A (South)",
    ]);
    expect(t.rows.map((r) => r.cells)).toEqual([
      ["Comfort", "Mean", 7.1, 7.4, 6.9],
      ["Quietness", "Mean", 6.2, 6.8, 7],
      ["Space", "Mean", 5, 6, 7],
    ]);
    expect(t.rows.map((r) => r.line)).toEqual([4, 6, 8]);
    const notes = t.notes.join("\n");
    expect(notes).toMatch(/Skipped row 1 above the header: titles/);
    expect(notes).toMatch(/Row 2 labels groups of columns.*"Car A \(North\)"/);
    expect(notes).toMatch(/header "Comfort" is the title of the first section/);
    expect(notes).toMatch(/2 rows hold only a title .*rows 5, 7/);
  });

  it("a feedback table with missing comments is not mistaken for a report", () => {
    const t = toTable([
      ["id", "comment", "rating"],
      ["F1", "Seats are firm", 2],
      ["F2", null, null],
      ["F3", null, null],
      ["F4", "Great sound", 5],
    ]);
    expect(t.header).toEqual(["id", "comment", "rating"]);
    expect(t.rows).toHaveLength(4);
  });

  it("feedback repeated once per classification: one record per ID and comment", async () => {
    const file = csvFile(
      "feedback.csv",
      [
        "ID,Country,Customer Feedback,Feedback Type,Topic",
        "A1,GB,The seats are too firm on long trips,Wants,Seats",
        "A1,GB,The seats are too firm on long trips,Defect,Comfort",
        "A1,GB,The seats are too firm on long trips,Wants,Comfort",
        "A2,JP,The display is too small for the map,Wants,Display",
        "A2,JP,And the voice control never understands me,Difficult to Use,Voice",
      ].join("\n"),
    );
    const { data, logs } = await ingest(file, { dataset: "customer_feedback" });
    expect(data.records.map((r) => r.text)).toEqual([
      "The seats are too firm on long trips",
      "The display is too small for the map",
      "And the voice control never understands me",
    ]);
    expect(data.records[0]).toMatchObject({
      market: "GB",
      language: "en",
      locator: "rows 2–4",
      fields: { ID: "A1", "Feedback Type": ["Wants", "Defect"], Topic: ["Seats", "Comfort"] },
    });
    expect(data.records[1]!.locator).toBe("row 5");
    const log = logs.join("\n");
    expect(log).toMatch(
      /Merged 5 rows into 3 records: rows with the same ID and comment .*\(Feedback Type, Topic\)/,
    );
    expect(log).toMatch(/1 ID value\(s\) have more than one different comment/);
  });

  it("wide sales sheet: one column per year, market codes, plan years worded as plans", async () => {
    const file = csvFile(
      "sales.csv",
      [
        "market,market_code,volume_2024,volume_2025,volume_2030",
        "Europe,EU,80000,85000,96000",
        "China,CN,0,0,0",
        "United States,US,25000,28000,26000",
        "Rest of World,RoW,10000,9000,8000",
      ].join("\n"),
    );
    const { data, logs } = await ingest(file, { dataset: "sales_volume" });
    expect(data.records.map((r) => r.market)).toEqual(["EU", "CN", "US", "RoW"]);
    const planYear = Number(new Date().toISOString().slice(0, 4)) < 2030;
    expect(data.findings.map((f) => f.statement)).toEqual(
      planYear
        ? [
            "Sales of Europe are planned to rise 20% from 2024 to 2030 (80,000 → 96,000 units; 2030 is a plan figure).",
            "Sales of Rest of World are planned to fall 20% from 2024 to 2030 (10,000 → 8,000 units; 2030 is a plan figure).",
          ]
        : [
            "Sales of Europe rose 20% from 2024 to 2030 (80,000 → 96,000 units).",
            "Sales of Rest of World fell 20% from 2024 to 2030 (10,000 → 8,000 units).",
          ],
    );
    expect(data.findings[0]!.markets).toEqual(["EU"]);
    expect(data.findings[0]!.evidence).toHaveLength(1); // the whole series is one row
    const log = logs.join("\n");
    expect(log).toMatch(/one column per period \(volume_2024, volume_2025, volume_2030\)/);
    expect(log).toMatch(/China: no sales in any period/);
  });

  it("refuses PDFs with a clear message", async () => {
    const pdf: StoredFile = {
      id: "file_pdf",
      name: "options.PDF",
      mimeType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.7 ..."),
    };
    await expect(ingest(pdf, {})).rejects.toThrow(/is a PDF.*PDFs aren't supported yet/);
  });
});

describe("Raw block on a SQLite database", () => {
  const dir = mkdtempSync(join(tmpdir(), "reqflow-raw-"));
  const path = join(dir, "feedback.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE feedback (id INTEGER, market TEXT, comment TEXT)");
  db.exec(
    "INSERT INTO feedback VALUES (1, 'DE', 'Die Rückbank ist zu schmal für drei Kindersitze'), (2, 'FR', NULL)",
  );
  db.close();
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const dbParams = (patch: Record<string, unknown>) =>
    params({
      source: "database",
      dbType: "sqlite",
      connection: path,
      query: "SELECT * FROM feedback",
      dataset: "customer_feedback",
      ...patch,
    });

  it("reads a read-only SELECT into records", async () => {
    const { ctx, logs } = context();
    const result = await rawBlock.run({}, dbParams({}), ctx);
    expect(result.status).toBe("ok");
    const data = result.status === "ok" ? result.outputs.out! : null;
    expect(data!.records).toHaveLength(1);
    expect(data!.records[0]!.text).toMatch(/Rückbank/);
    expect(data!.sources[0]!.title).toBe("feedback.sqlite · query");
    expect(logs.join("\n")).toMatch(/Skipped 1 row 3 without comment text/);
  });

  it("refuses writes, several statements and unsupported databases", async () => {
    const { ctx } = context();
    expect(() => assertReadOnlyQuery("DELETE FROM feedback")).toThrow(/Only SELECT/);
    expect(() => assertReadOnlyQuery("SELECT 1; DROP TABLE feedback")).toThrow(/one statement/);
    expect(assertReadOnlyQuery("select 1;")).toBe("select 1");
    await expect(rawBlock.run({}, dbParams({ dbType: "postgres" }), ctx)).rejects.toThrow(
      /postgres isn't supported yet/,
    );
    await expect(
      rawBlock.run({}, dbParams({ connection: join(dir, "missing.sqlite") }), ctx),
    ).rejects.toThrow(/Couldn't open/);
    await expect(rawBlock.run({}, dbParams({ query: "SELECT * FROM nope" }), ctx)).rejects.toThrow(
      /The query failed/,
    );
  });
});

/**
 * BMW's real files, when they are in data/raw/ (gitignored, local only); skipped everywhere else.
 * The checks look at structure, never content, and a failure prints the check's name and a boolean:
 * the files are confidential and test output can end up in public logs and transcripts.
 */
const BMW_DIR = join(import.meta.dirname, "../../../../data/raw");
const BMW = {
  feedback: "F70_feedback_hackathon.xlsx",
  studies: "F70_G60_G68_G70_customer_studies.xlsx",
  sales: "sales_volumes.xlsx",
  options: "F70_OptionList.PDF",
};
const hasBmw = (name: string) => existsSync(join(BMW_DIR, name));
const bmwFile = (name: string): StoredFile => ({
  id: `file_bmw${name.replace(/\W/g, "").toLowerCase()}`,
  name,
  mimeType: "application/octet-stream",
  bytes: new Uint8Array(readFileSync(join(BMW_DIR, name))),
});
const sheetsOf = async (file: StoredFile) =>
  (await readXlsxFile(Buffer.from(file.bytes))).map((s) => s.sheet);
const check = (ok: boolean, what: string) => expect(ok, what).toBe(true);

describe.skipIf(!hasBmw(BMW.feedback))("BMW feedback export (data/raw)", () => {
  it("one record per feedback ID, the comment as text, a market code on each", async () => {
    const { data, logs } = await ingest(bmwFile(BMW.feedback), { dataset: "customer_feedback" });
    const log = logs.join("\n");
    const merged = /Merged (\d+) rows into (\d+) records/.exec(log);
    check(merged !== null, "rows repeated per classification were merged");
    check(Number(merged![2]) === data.records.length, "merge note matches the record count");
    check(Number(merged![1]) > data.records.length, "fewer records than rows");
    const ids = new Set(data.records.map((r) => String(r.fields?.["ID"])));
    check(ids.size === data.records.length, "exactly one record per ID");
    check(!log.includes("No comment column"), "a comment column was found");
    const meanLength = data.records.reduce((n, r) => n + r.text.length, 0) / data.records.length;
    check(meanLength > 40, "record text is the long comment, not a short label");
    check(
      data.records.every((r) => /^[A-Z]{2}$/.test(r.market ?? "")),
      "markets are codes",
    );
    check(new Set(data.records.map((r) => r.id)).size === data.records.length, "unique ids");
  });
});

describe.skipIf(!hasBmw(BMW.studies))("BMW customer studies (data/raw)", () => {
  it("every sheet reads as sections of figures with unambiguous columns", async () => {
    const file = bmwFile(BMW.studies);
    const sheets = await sheetsOf(file);
    check(sheets.length > 0, "the workbook has sheets");
    let grouped = false;
    for (const sheet of sheets) {
      const { data, logs } = await ingest(file, { dataset: "customer_study", sheet });
      const log = logs.join("\n");
      grouped ||= log.includes("labels groups of columns");
      check(data.records.length > 0, `${sheet}: has records`);
      const keys = Object.keys(data.records[0]!.fields ?? {});
      check(keys[0] === "Section", `${sheet}: first column is the section`);
      check(!/appears \d+ times/.test(log), `${sheet}: no duplicate column names`);
      check(
        data.records.every((r) => typeof r.fields?.["Section"] === "string"),
        `${sheet}: every record has a section`,
      );
      check(
        data.records.every((r) => /\d/.test(r.text)),
        `${sheet}: every record has figures`,
      );
    }
    check(grouped, "the market group row above the vehicles was used");
  });
});

describe.skipIf(!hasBmw(BMW.sales))("BMW sales volumes (data/raw)", () => {
  it("every sheet reads one column per year and cites its rows", async () => {
    const file = bmwFile(BMW.sales);
    for (const sheet of await sheetsOf(file)) {
      const { data, logs } = await ingest(file, { dataset: "sales_volume", sheet });
      const log = logs.join("\n");
      check(data.records.length > 0, `${sheet}: has records`);
      check(log.includes("one column per period"), `${sheet}: periods found in the columns`);
      check(!/No (units|period) column/.test(log), `${sheet}: no missing-column note`);
      check(
        data.records.every((r) => /^[A-Za-z]{2,3}$/.test(r.market ?? "")),
        `${sheet}: codes`,
      );
      for (const f of data.findings) {
        check(/from \d{4} to \d{4}/.test(f.statement), `${sheet}: finding names its years`);
        const record = data.records.find((r) => r.id === f.evidence[0]?.recordId);
        check(
          record?.text.includes(f.evidence[0]!.excerpt) === true,
          `${sheet}: verbatim evidence`,
        );
      }
    }
  });
});

describe.skipIf(!hasBmw(BMW.options))("BMW option list (data/raw)", () => {
  it("is refused with a clear message: PDFs aren't read yet", async () => {
    await expect(ingest(bmwFile(BMW.options), {})).rejects.toThrow(/is a PDF/);
  });
});
