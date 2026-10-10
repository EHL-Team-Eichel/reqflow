import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import { ResearchDataset, type ResearchRecord } from "@reqflow/core";
import { FEEDBACK_COLUMNS } from "@reqflow/blocks";

export type SmokeAssertion = (condition: unknown, name: string) => asserts condition;

export const SYNTHETIC_FEEDBACK =
  "Synthetic feedback: <script>synthetic</script><script>window.__reqflowSmokeExecuted = true</script> Seat feels too firm.";
export const SYNTHETIC_FEEDBACK_ID = "SYNTHETIC-OPINION-001";
export const SYNTHETIC_MARKER = "Generated smoke fixture. Synthetic only; no BMW or customer data.";
export const SYNTHETIC_VFC = ["Synthetic seat comfort", "Synthetic seat adjustment"] as const;
const SYNTHETIC_VFC_PARENT = "Synthetic seats";

/** Generated at runtime only. These two original rows describe one opinion, not two customers. */
export async function writeSmokeResearchFixture(outDir: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ReqFlow synthetic smoke fixture";
  workbook.created = new Date("2026-01-01T00:00:00.000Z");
  const feedback = workbook.addWorksheet("Feedback_Explorer");
  feedback.addRow(FEEDBACK_COLUMNS.slice(0, 12));
  for (const vfc of SYNTHETIC_VFC) {
    feedback.addRow([
      SYNTHETIC_FEEDBACK_ID,
      "Synthetic local original",
      "Synthetic brand",
      "Synthetic sedan",
      null, // Unknown market must stay unknown, rather than inheriting the workflow scope.
      "SYN",
      "Synthetic propulsion",
      "Synthetic source-supplied classification",
      SYNTHETIC_FEEDBACK,
      vfc,
      SYNTHETIC_VFC_PARENT,
      vfc,
    ]);
  }
  workbook.addWorksheet("Smoke metadata").addRows([
    ["synthetic", "data_origin"],
    [true, SYNTHETIC_MARKER],
  ]);
  const path = join(outDir, "original.synthetic.xlsx");
  await writeFile(path, new Uint8Array(await workbook.xlsx.writeBuffer()), { mode: 0o600 });
  return path;
}

export function verifySmokeResearchDataset(
  dataset: ResearchDataset,
  ensure: SmokeAssertion,
): ResearchRecord {
  ensure(
    dataset.sources.length === 1 && dataset.records.length === 2,
    "one source, two raw records",
  );
  ensure(
    dataset.sources.every(
      (source) =>
        source.uri?.startsWith("reqflow-file:///") &&
        source.reliability === undefined &&
        source.market === undefined &&
        source.vehicleLine === undefined,
    ),
    "local source identity; no inferred reliability, market or vehicle",
  );
  ensure(
    dataset.records.every(
      (record) =>
        record.provider === "local_documents" &&
        record.originalUrl.startsWith("reqflow-file:///") &&
        record.collectingAgents.length === 2 &&
        record.collectingAgents.includes("bmw_sales") &&
        record.collectingAgents.includes("bmw_strategy") &&
        record.runIds.length === 1 &&
        record.runIds[0] === dataset.runId &&
        record.marketAttribution === undefined &&
        record.vehicleAttribution === undefined,
    ),
    "both collecting agents merged; no inferred record attribution",
  );
  const opinions = dataset.records.filter((record) => record.recordType === "feedback");
  ensure(opinions.length === 1, "repeated feedback rows remain one independent opinion");
  const opinion = opinions[0]!;
  ensure(
    opinion.text === SYNTHETIC_FEEDBACK &&
      opinion.metadata.feedbackId === SYNTHETIC_FEEDBACK_ID &&
      opinion.metadata.independentOpinionCount === 1 &&
      JSON.stringify(opinion.metadata.sourceRows) === "[2,3]" &&
      JSON.stringify(opinion.table?.headers) === JSON.stringify(FEEDBACK_COLUMNS.slice(0, 12)) &&
      opinion.table?.rows.length === 2,
    "verbatim feedback, original ID, 12 columns and both source rows preserved",
  );
  const originalFields = opinion.fields?.original as Record<string, unknown> | undefined;
  ensure(
    JSON.stringify(originalFields) === JSON.stringify(opinion.metadata) &&
      JSON.stringify(opinion.fields?.table) === JSON.stringify(opinion.table) &&
      JSON.stringify(originalFields?.sourceRows) === "[2,3]" &&
      JSON.stringify(originalFields?.vfcAssociations) ===
        JSON.stringify([SYNTHETIC_VFC[0], SYNTHETIC_VFC_PARENT, SYNTHETIC_VFC[1]]),
    "SourceRecord.fields retains the original structured data and source-row provenance",
  );
  const associations = opinion.metadata.sourceAssociations;
  ensure(
    Array.isArray(associations) && associations.length === 2,
    "two original VFC association rows",
  );
  ensure(
    SYNTHETIC_VFC.every((vfc) => (opinion.metadata.vfcAssociations as unknown[])?.includes(vfc)),
    "both source-supplied VFC values preserved",
  );
  ensure(
    dataset.records.some(
      (record) =>
        record.metadata.sheet === "Smoke metadata" &&
        record.table?.rows[0]?.[0] === true &&
        record.table.rows[0]?.[1] === SYNTHETIC_MARKER,
    ),
    "explicit synthetic metadata preserved",
  );
  return opinion;
}

/** Read real main-process persistence and native-dialog exports, not renderer response fixtures. */
export async function verifySmokeResearchFiles(
  outDir: string,
  dataDir: string,
  dataset: ResearchDataset,
  blockId: string,
  ensure: SmokeAssertion,
): Promise<string[]> {
  const exported = ResearchDataset.parse(
    JSON.parse(await readFile(join(outDir, "research-export.json"), "utf8")),
  );
  const db = new DatabaseSync(join(dataDir, "reqflow.db"));
  let saved: ResearchDataset | null = null;
  let output: { out?: { records?: unknown[] } } | null = null;
  let actions: string[] = [];
  try {
    const savedRow = db
      .prepare("SELECT json FROM research_datasets WHERE run_id = ? AND block_id = ''")
      .get(dataset.runId) as { json: string } | undefined;
    saved = savedRow ? ResearchDataset.parse(JSON.parse(savedRow.json)) : null;
    const outputRow = db
      .prepare("SELECT outputs FROM block_outputs WHERE run_id = ? AND block_id = ?")
      .get(dataset.runId, blockId) as { outputs: string } | undefined;
    output = outputRow ? JSON.parse(outputRow.outputs) : null;
    actions = (
      db
        .prepare("SELECT action FROM audit_events WHERE run_id = ? ORDER BY at, id")
        .all(dataset.runId) as { action: string }[]
    ).map((row) => row.action);
  } finally {
    db.close();
  }
  ensure(
    !!saved && JSON.stringify(saved) === JSON.stringify(dataset),
    "SQLite-persisted Research dataset validates and matches renderer IPC dataset",
  );
  ensure(
    JSON.stringify(exported) === JSON.stringify(dataset),
    "exported JSON validates and matches renderer IPC dataset",
  );
  ensure(
    !!output && JSON.stringify(output.out?.records) === JSON.stringify(dataset.records),
    "SQLite-persisted block output retains every Research record and its fields provenance",
  );
  ensure(
    actions.includes("run.started") &&
      actions.includes("run.completed") &&
      actions.filter((action) => action === "export.created").length === 3,
    "SQLite audit records run start, completion and all three exports",
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(join(outDir, "research-export.xlsx"));
  const feedback = workbook.getWorksheet("Feedback_Explorer");
  const records = workbook.getWorksheet("Research Records");
  const sources = workbook.getWorksheet("Sources");
  const runs = workbook.getWorksheet("Research Runs");
  ensure(
    feedback && records && sources && runs,
    "XLSX contains feedback, records, sources and runs",
  );
  const rowText = (row: ExcelJS.Row, width: number) =>
    Array.from({ length: width }, (_, index) => row.getCell(index + 1).text);
  ensure(
    JSON.stringify(rowText(feedback.getRow(1), FEEDBACK_COLUMNS.length)) ===
      JSON.stringify(FEEDBACK_COLUMNS),
    "XLSX feedback headers match export contract",
  );
  const opinion = dataset.records.find((record) => record.recordType === "feedback")!;
  ensure(
    feedback.rowCount === 3 &&
      SYNTHETIC_VFC.every(
        (vfc, index) =>
          feedback.getCell(index + 2, 1).text === opinion.id &&
          feedback.getCell(index + 2, 9).text === SYNTHETIC_FEEDBACK &&
          feedback.getCell(index + 2, 10).text === vfc &&
          feedback.getCell(index + 2, 25).text === SYNTHETIC_FEEDBACK_ID &&
          feedback.getCell(index + 2, 26).text === "Feedback_Explorer" &&
          feedback.getCell(index + 2, 27).text === String(index + 2),
      ),
    "XLSX re-expands two associations with matching raw record IDs and original locators",
  );
  ensure(
    records.rowCount === dataset.records.length + 1 &&
      dataset.records.every(
        (record, index) =>
          records.getCell(index + 2, 1).text === record.id &&
          records.getCell(index + 2, 2).text === record.sourceId &&
          records.getCell(index + 2, 4).text === record.text,
      ) &&
      sources.getCell(2, 1).text === dataset.sources[0]!.id &&
      sources.getCell(2, 4).text === dataset.sources[0]!.uri &&
      sources.getCell(2, 9).text === "" &&
      runs.rowCount === dataset.results.length + 1 &&
      dataset.results.every(
        (result, index) =>
          runs.getCell(index + 2, 1).text === dataset.runId &&
          runs.getCell(index + 2, 2).text === result.agentId &&
          runs.getCell(index + 2, 3).text === result.status,
      ),
    "XLSX preserves record/source/run IDs, original text, statuses and unknown reliability",
  );
  const csv = await new ExcelJS.Workbook().csv.readFile(join(outDir, "research-export.csv"));
  ensure(
    csv.rowCount === feedback.rowCount &&
      Array.from({ length: feedback.rowCount }, (_, index) => index + 1).every(
        (row) =>
          JSON.stringify(rowText(csv.getRow(row), FEEDBACK_COLUMNS.length)) ===
          JSON.stringify(rowText(feedback.getRow(row), FEEDBACK_COLUMNS.length)),
      ),
    "CSV matches every XLSX feedback cell, including IDs, verbatim text and VFC associations",
  );
  return ["research-export.json", "research-export.xlsx", "research-export.csv"];
}
