import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import { ResearchDataset, type ResearchRecord, type LlmClient } from "@reqflow/core";
import { FEEDBACK_COLUMNS } from "@reqflow/blocks";

export type SmokeAssertion = (condition: unknown, name: string) => asserts condition;

/** Explicit synthetic seam, never a live model or a production fallback. */
export const syntheticSourceReviewLlm: LlmClient = {
  async generateObject(request) {
    request.signal?.throwIfAborted();
    const { content } = JSON.parse(request.prompt) as {
      content: { text?: string; rows?: { index: number }[] };
    };
    const text = content.text ?? "";
    const hasRows = (content.rows?.length ?? 0) > 0;
    const isRelevant = Boolean(text || hasRows);
    const summary = isRelevant
      ? text
        ? `Synthetic source summary: ${text}`.slice(0, 3000)
        : `Synthetic table summary of ${content.rows!.length} rows`
      : "";
    return {
      model: "synthetic:source-assessment",
      object: request.schema.parse({
        verdict: isRelevant ? "relevant" : "uncertain",
        reason: "Synthetic plumbing fixture; no semantic quality claim.",
        uncertainty: "Synthetic only.",
        summary,
        excerpts: text ? [{ start: 0, end: text.length, quote: text }] : [],
        tableRows: content.rows?.map((row) => row.index) ?? [],
      }),
    };
  },
  async generateText() {
    throw new Error("Synthetic source assessment does not generate prose.");
  },
};

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
  ensure(
    dataset.records.every((record) => {
      const assessments = record.fields?.researchAssessments;
      return (
        Array.isArray(assessments) &&
        assessments.length === 2 &&
        assessments.every(
          (assessment) =>
            assessment.contentHash === record.contentHash &&
            assessment.verdict === "relevant" &&
            assessment.model === "synthetic:source-assessment",
        )
      );
    }),
    "each collecting agent assessed every synthetic original against its archived content revision",
  );
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
  let output: {
    out?: { records?: (ResearchRecord & { collectedRecordId: string })[] };
  } | null = null;
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
  const outputRecords = output?.out?.records ?? [];
  const originalOpinion = dataset.records.find((record) => record.recordType === "feedback")!;
  const originalTable = dataset.records.find((record) => record.recordType === "table")!;
  ensure(
    outputRecords.length === 2 &&
      dataset.records.every((record) =>
        outputRecords.some((row) => row.collectedRecordId === record.id),
      ) &&
      outputRecords.every((row) => {
        const original = dataset.records.find((record) => record.id === row.collectedRecordId);
        return (
          original &&
          row.sourceId === original.sourceId &&
          row.originalRecordId === original.originalRecordId &&
          row.recordType === "passage" &&
          row.metadata.textOrigin === "ai_summary"
        );
      }),
    "SQLite-persisted tabular output retains every original record's identity and provenance",
  );
  const outputOpinion = outputRecords.find(
    (record) => record.collectedRecordId === originalOpinion.id,
  )!;
  const outputTable = outputRecords.find(
    (record) => record.collectedRecordId === originalTable.id,
  )!;
  ensure(
    outputOpinion &&
      outputOpinion.text.startsWith("Synthetic source summary: ") &&
      outputOpinion.text.includes(SYNTHETIC_FEEDBACK) &&
      outputOpinion.fields?.ID === SYNTHETIC_FEEDBACK_ID &&
      outputOpinion.fields?.["Customer Feedback"] === outputOpinion.text &&
      outputOpinion.fields?.["Original Evidence"] === SYNTHETIC_FEEDBACK &&
      outputOpinion.fields?.Country === null &&
      JSON.stringify(outputOpinion.fields?.["Vfc level3 Name"]) === JSON.stringify(SYNTHETIC_VFC) &&
      (outputOpinion as unknown as { summaryEvidence?: { excerpts?: { text: string }[] } })
        .summaryEvidence?.excerpts?.[0]?.text === SYNTHETIC_FEEDBACK,
    "SQLite output contains flat Raw-compatible feedback and native typed table columns",
  );
  ensure(
    outputTable &&
      outputTable.text.startsWith("Synthetic table summary of ") &&
      outputTable.table?.rows[0]?.[0] === true &&
      outputTable.table.rows[0]?.[1] === SYNTHETIC_MARKER &&
      (
        outputTable as unknown as {
          summaryEvidence?: { tableEvidence?: { rows: unknown[][] } };
        }
      ).summaryEvidence?.tableEvidence?.rows[0]?.[0] === true &&
      (
        outputTable as unknown as {
          summaryEvidence?: { tableEvidence?: { rows: unknown[][] } };
        }
      ).summaryEvidence?.tableEvidence?.rows[0]?.[1] === SYNTHETIC_MARKER &&
      typeof outputTable.fields?.["Original Evidence"] === "string" &&
      outputTable.fields["Original Evidence"].includes(SYNTHETIC_MARKER),
    "SQLite output preserves native table rows in table and summaryEvidence with exact evidence",
  );
  ensure(
    actions.includes("run.started") &&
      actions.includes("run.completed") &&
      actions.filter((action) => action === "export.created").length === 3,
    "SQLite audit records run start, completion and all three exports",
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(join(outDir, "research-export.xlsx"));
  const tabular = workbook.getWorksheet("Research_Explorer");
  const feedback = workbook.getWorksheet("Feedback_Explorer");
  const records = workbook.getWorksheet("Research Records");
  const sources = workbook.getWorksheet("Sources");
  const runs = workbook.getWorksheet("Research Runs");
  ensure(
    workbook.getWorksheet("Source Assessments")?.rowCount === 5,
    "four agent-specific synthetic source assessments are exported with reasons and provenance",
  );
  ensure(
    tabular && feedback && records && sources && runs,
    "XLSX contains tabular output, feedback, originals, sources and runs",
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
    tabular.rowCount === 4 &&
      csv.rowCount === tabular.rowCount &&
      Array.from({ length: tabular.rowCount }, (_, index) => index + 1).every(
        (row) =>
          JSON.stringify(rowText(csv.getRow(row), tabular.columnCount)) ===
          JSON.stringify(rowText(tabular.getRow(row), tabular.columnCount)),
      ),
    "CSV matches every tabular XLSX cell, including all record types and original associations",
  );
  return ["research-export.json", "research-export.xlsx", "research-export.csv"];
}
