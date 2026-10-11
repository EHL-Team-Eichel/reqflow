import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type ProductScope,
  type ResearchDataset,
  type ResearchRecord,
  type Source,
  type LlmClient,
} from "@reqflow/core";
import {
  BMW_FEEDBACK_HEADERS,
  assessedSelection,
  researchTableRows,
  type ResearchTableRow,
} from "./tabular";
import {
  ASSESSMENT_FIELD,
  sourceAssessments,
  type SourceAssessment,
  type SourceAssessmentSummary,
} from "./assessment";
import { assertJsonByteBudget, jsonByteSize, PERSISTED_JSON_MAX_BYTES } from "./data-budget";

export { BMW_FEEDBACK_HEADERS, SourceAssessment, sourceAssessments };
export type AssessmentSummaryItem = SourceAssessmentSummary;

export type SummaryEvidence = {
  sourceId: string;
  collectedRecordId: string;
  locator?: string;
  excerpts: { start: number; end: number; text: string }[];
  tableEvidence?: {
    headers: string[];
    rows: unknown[][];
    rowIndices: number[];
  };
};

// --- Utility schemas and functions preserved for external compatibility ---

export const SummarizedFeedbackItem = z
  .object({
    brand: z.string().trim().min(1).default("[BMW]"),
    salesDescription: z.string().trim().min(1).default("[BMW 1 Series]"),
    country: z.string().trim().min(1).default("EU"),
    derivate: z.string().trim().min(1).default("F70"),
    engineType: z.enum(["ICE", "BEV", "PHEV", "unknown"]).default("ICE"),
    feedbackType: z.enum(["Likes", "Wants", "Defect", "Difficult to Use"]).default("Likes"),
    summary: z.string().trim().min(1),
    vfcLevel2Name: z.string().trim().min(1),
    vfcLevel3Name: z.string().trim().min(1),
  })
  .strict();

export type SummarizedFeedbackItem = z.infer<typeof SummarizedFeedbackItem>;

export const SourceSummariesResult = z
  .object({
    items: z.array(SummarizedFeedbackItem).min(1).max(5),
  })
  .strict();

export type SourceSummariesResult = z.infer<typeof SourceSummariesResult>;

export function defaultDerivate(model: string): string {
  if (/1\s*series|1er|f70/i.test(model)) return "F70";
  if (/5\s*series|5er|g60/i.test(model)) return "G60";
  if (/7\s*series|7er|g70/i.test(model)) return "G70";
  return "F70";
}

export function defaultSalesDescription(model: string): string {
  if (/1\s*series|1er|f70/i.test(model)) return "[BMW 1 Series]";
  if (/5\s*series|5er|g60/i.test(model)) return "[BMW 5 Series]";
  if (/7\s*series|7er|g70/i.test(model)) return "[BMW 7 Series]";
  return `[BMW ${model || "1 Series"}]`;
}

export const SUMMARIZER_SYSTEM = [
  "You are the BMW Research Summarizer and Feedback Analyst for product decision making.",
  "Your task is to analyze external research content (road tests, owner reviews, equipment lists, competitor benchmarks, forum discussions) and convert it into structured BMW-compatible feedback entries.",
].join("\n");

/** Legacy rule-based offline fallback preserved for external utility usage; active path never invokes this. */
export function offlineSummarizeRecord(
  record: ResearchRecord,
  source: Source | undefined,
  scope: ProductScope,
  overrideText?: string,
): SummarizedFeedbackItem {
  let text = overrideText;
  if (text === undefined) {
    const selection = assessedSelection(record);
    if (selection.excerpts.length > 0) {
      text = selection.excerpts.map(({ start, end }) => record.text.slice(start, end)).join("\n\n");
    } else {
      text = record.text;
    }
  }
  const cleanText = text.replace(/[\r\n]+/g, " ").trim();
  const lower = cleanText.toLowerCase();
  const vehicle = scope.vehicleLine || scope.vehicleCode || "1 Series";
  const derivate = defaultDerivate(vehicle);
  const salesDesc = defaultSalesDescription(vehicle);
  const country =
    typeof record.fields?.Country === "string"
      ? record.fields.Country
      : (record.marketAttribution?.value ?? scope.market ?? "EU");

  let feedbackType: SummarizedFeedbackItem["feedbackType"] = "Likes";
  if (/\b(defect|broken|fault|error|malfunction|damage|squeak|rattle)\b/i.test(lower)) {
    feedbackType = "Defect";
  } else if (
    /\b(difficult|awkward|distract|hard|complicated|annoy|confusing|frustrat|nightmare)\b/i.test(
      lower,
    )
  ) {
    feedbackType = "Difficult to Use";
  } else if (/\b(wish|want|need|missing|lack|should have|wants|request)\b/i.test(lower)) {
    feedbackType = "Wants";
  }

  let vfcLevel2 = "General enquiry: customer feedback";
  let vfcLevel3 = "Like: function";

  if (
    /\b(touchscreen|touch|display|screen|idrive|software|navi|app|os9|os8|infotainment|bluetooth)\b/i.test(
      lower,
    )
  ) {
    vfcLevel2 = "ConnectedDrive and Infotainment, overall technology";
    vfcLevel3 =
      feedbackType === "Difficult to Use"
        ? "Not user-friendly"
        : feedbackType === "Defect"
          ? "Malfunction"
          : feedbackType === "Wants"
            ? "Customer request: usability"
            : "Like: function";
  } else if (/\b(seat|seating|chair|lumbar|sitz)\b/i.test(lower)) {
    vfcLevel2 = "Seats";
    vfcLevel3 =
      feedbackType === "Difficult to Use"
        ? "Not user-friendly"
        : feedbackType === "Likes"
          ? "Likes comfort"
          : "Customer request: function";
  } else if (
    /\b(steer|suspension|corner|ride|chassis|fahrwerk|handling|nimble|stability)\b/i.test(lower)
  ) {
    vfcLevel2 = "Handling / Riding";
    vfcLevel3 = "Like: performance";
  } else if (
    /\b(engine|motor|hybrid|power|drivetrain|gearbox|transmission|mild hybrid|consumption|efficiency)\b/i.test(
      lower,
    )
  ) {
    vfcLevel2 = "Drivetrain";
    vfcLevel3 = "Like: performance";
  } else if (/\b(brake|braking|bremse)\b/i.test(lower)) {
    vfcLevel2 = "Braking";
    vfcLevel3 = feedbackType === "Defect" ? "Malfunction" : "Like: function";
  } else if (/\b(assist|speed limit|parking|lane|kamera|sensor)\b/i.test(lower)) {
    vfcLevel2 = "Driver Assistance Systems";
    vfcLevel3 = feedbackType === "Defect" ? "Malfunction" : "Like: function";
  } else if (/\b(interior|cabin|materials|plastic|quality|verarbeitung)\b/i.test(lower)) {
    vfcLevel2 = "Interior design";
    vfcLevel3 = "Look / design appeals";
  } else if (/\b(exterior|styling|front|rear|grille|look)\b/i.test(lower)) {
    vfcLevel2 = "Exterior design";
    vfcLevel3 = "Look / design appeals";
  }

  const summaryPrefix =
    source?.publisher || source?.title ? `${source?.publisher || source?.title}: ` : "";
  const excerpt = cleanText.slice(0, 350) + (cleanText.length > 350 ? "…" : "");
  const summary = `[Summary] ${summaryPrefix}${excerpt}`;

  let engineType: SummarizedFeedbackItem["engineType"] = "ICE";
  if (/\b(bev|electric|vollelektrisch|i5|i7|battery|laden|charging)\b/i.test(lower)) {
    engineType = "BEV";
  } else if (/\b(phev|plug-in|hybrid)\b/i.test(lower)) {
    engineType = "PHEV";
  }

  return {
    brand: "[BMW]",
    salesDescription: salesDesc,
    country,
    derivate,
    engineType,
    feedbackType,
    summary,
    vfcLevel2Name: vfcLevel2,
    vfcLevel3Name: vfcLevel3,
  };
}

/** Runs work across items with a concurrency cap. Preserved for external utility tests. */
export async function parallelMap<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      if (signal.aborted) throw new Error("Operation cancelled.");
      const current = next++;
      results[current] = await fn(items[current]!, current);
    }
  }
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

export interface SummarizeOptions {
  llm?: LlmClient;
  scope?: ProductScope;
  signal?: AbortSignal;
  log?: (message: string) => void;
  concurrency?: number;
}

// --- Row Metadata Compact Packaging (strict <= 8192 bytes total) ---

const ROW_METADATA_MAX_BYTES = 8 * 1024;

function rowMetadata(metadata: ResearchRecord["metadata"]): {
  metadata: ResearchRecord["metadata"];
  archivedMetadataKeys?: string[];
} {
  const entries: [string, unknown][] = [];
  const archivedMetadataKeys: string[] = [];
  let bytes = 2; // braces
  for (const [key, value] of Object.entries(metadata)) {
    if (key === ASSESSMENT_FIELD || key === "researchAssessments") continue;
    const propertyBytes = jsonByteSize({ [key]: value }) - 2 + (entries.length ? 1 : 0);
    if (propertyBytes > ROW_METADATA_MAX_BYTES - bytes) {
      archivedMetadataKeys.push(key);
    } else {
      entries.push([key, value]);
      bytes += propertyBytes;
    }
  }
  return {
    metadata: Object.fromEntries(entries),
    ...(archivedMetadataKeys.length ? { archivedMetadataKeys } : {}),
  };
}

// --- Active Deterministic Summarizer ---

/**
 * Synchronously summarizes research records into BMW feedback rows.
 * Reuses flat base columns from researchTableRows for source-only attributed columns
 * and sourceAssociations, avoiding arbitrary raw HTML / document / table amplification.
 * Assessed records:
 *   - Canonical assessments imported and validated via sourceAssessments(record).
 *   - Throws on malformed assessments or partially invalid summary citations.
 *   - Summary citations must be strictly within positively assessed spans/tableRows of the same assessment.
 *   - Citing unapproved tail (spans or row indices) fails clearly with an error.
 *   - Older canonical assessments with summaries: [] yield no usable summary (record omitted).
 *   - Deduplicates identical summary text + evidence across agents.
 *   - Produces ONE Raw-like summary row per collected record (recordType='passage',
 *     metadata.textOrigin='ai_summary', Customer Feedback = AI summary).
 *   - Preserves compact metadata <= 8192 total (no huge originalFields or summaryEvidence in metadata).
 * Legacy unassessed datasets:
 *   - Returns researchTableRows(dataset) directly so historical datasets/tests do not pay.
 */
export function summarizeResearchRows(dataset: ResearchDataset): ResearchTableRow[] {
  // Check whether any record has the assessment field.
  const hasAssessments = dataset.records.some((record) =>
    Object.hasOwn(record.fields ?? {}, ASSESSMENT_FIELD),
  );

  // Keep legacy unassessed datasets returning researchTableRows(dataset)
  if (!hasAssessments) {
    return researchTableRows(dataset);
  }

  const rows: ResearchTableRow[] = [];

  for (const record of dataset.records) {
    // Unreviewed records in an assessed dataset are omitted
    if (!Object.hasOwn(record.fields ?? {}, ASSESSMENT_FIELD)) {
      continue;
    }

    // Canonical assessments from assessment.ts.
    // Validates against SourceAssessment schema (agentId enum, scope, runId, etc.) and
    // filters by assessment.contentHash === record.contentHash (hash mismatch omitted).
    // Fails clearly on malformed live assessments.
    const assessments = sourceAssessments(record);
    if (assessments.length === 0) {
      continue;
    }

    const relevantAssessments = assessments.filter((a) => a.verdict === "relevant");
    if (relevantAssessments.length === 0) {
      continue;
    }

    // Extract and strictly validate positively assessed summary citations
    type ValidSummary = {
      text: string;
      excerpts: { start: number; end: number }[];
      tableRows: number[];
    };
    const validSummaries: ValidSummary[] = [];
    const seenKeys = new Set<string>();

    for (const assessment of relevantAssessments) {
      const summaries = assessment.summaries ?? [];
      for (const summary of summaries) {
        const text = summary.text.trim();
        if (!text) {
          throw new Error(`Assessment summary text cannot be empty for record ${record.id}.`);
        }

        // Validate correct original record type and strict positive evidence linkage
        if (record.recordType === "table") {
          if (summary.excerpts && summary.excerpts.length > 0) {
            throw new Error(`Table summary for record ${record.id} cannot cite text excerpts.`);
          }
          if (!summary.tableRows || summary.tableRows.length === 0) {
            throw new Error(
              `Table summary for record ${record.id} must cite at least one table row.`,
            );
          }
          for (const rowIndex of summary.tableRows) {
            if (!assessment.tableRows.includes(rowIndex)) {
              throw new Error(
                `Summary cites unapproved table row ${rowIndex} not in assessment table rows for record ${record.id}.`,
              );
            }
            if (!record.table || rowIndex < 0 || rowIndex >= record.table.rows.length) {
              throw new Error(
                `Summary table row index ${rowIndex} is outside table bounds for record ${record.id}.`,
              );
            }
          }
        } else {
          if (summary.tableRows && summary.tableRows.length > 0) {
            throw new Error(`Text summary for record ${record.id} cannot cite table rows.`);
          }
          if (!summary.excerpts || summary.excerpts.length === 0) {
            throw new Error(
              `Text summary for record ${record.id} must cite at least one verbatim excerpt.`,
            );
          }
          for (const excerpt of summary.excerpts) {
            if (
              excerpt.start < 0 ||
              excerpt.start >= excerpt.end ||
              excerpt.end > record.text.length
            ) {
              throw new Error(
                `Summary excerpt [${excerpt.start}, ${excerpt.end}] has invalid bounds for record ${record.id}.`,
              );
            }
            // Strict check: excerpt must be entirely within positively assessed spans of SAME assessment
            const isWithinApprovedSpan = assessment.excerpts.some(
              (span) => span.start <= excerpt.start && excerpt.end <= span.end,
            );
            if (!isWithinApprovedSpan) {
              throw new Error(
                `Summary excerpt [${excerpt.start}, ${excerpt.end}] is not entirely within positively assessed excerpts for record ${record.id}.`,
              );
            }
          }
        }

        // Dedupe exact same summary text + evidence across agents
        const sortedExcKey = [...summary.excerpts]
          .sort((a, b) => a.start - b.start || a.end - b.end)
          .map((e) => `${e.start}-${e.end}`)
          .join(",");
        const sortedTblKey = [...summary.tableRows].sort((a, b) => a - b).join(",");
        const dedupKey = `${text}::[${sortedExcKey}]::[${sortedTblKey}]`;

        if (seenKeys.has(dedupKey)) continue;
        seenKeys.add(dedupKey);

        validSummaries.push({
          text,
          excerpts: summary.excerpts,
          tableRows: summary.tableRows,
        });
      }
    }

    // Older canonical assessment with summaries: [] or no valid summaries -> omit record
    if (validSummaries.length === 0) {
      continue;
    }

    // Produce ONE Raw-like summary row per collected record by joining unit/agent summaries
    const joinedSummaryText = validSummaries.map((s) => s.text).join("\n\n");

    // Collect and merge verbatim spans
    const allExcerpts = validSummaries.flatMap((s) => s.excerpts);
    const sortedSpans = allExcerpts.sort((a, b) => a.start - b.start || a.end - b.end);
    const mergedExcerpts: { start: number; end: number }[] = [];
    for (const span of sortedSpans) {
      const prev = mergedExcerpts.at(-1);
      if (prev && span.start <= prev.end) {
        prev.end = Math.max(prev.end, span.end);
      } else {
        mergedExcerpts.push({ start: span.start, end: span.end });
      }
    }

    const allTableRows = validSummaries.flatMap((s) => s.tableRows);
    const selectedTableIndices = [...new Set(allTableRows)].sort((a, b) => a - b);

    // Exact verbatim evidence text
    const textEvidence = mergedExcerpts
      .map((e) => record.text.slice(e.start, e.end))
      .filter(Boolean);
    const tableEvidence =
      record.table && selectedTableIndices.length > 0
        ? selectedTableIndices.map((idx) => {
            const rowValues = record.table!.rows[idx]!;
            return record.table!.headers.map((h, i) => `${h}: ${rowValues[i] ?? ""}`).join("; ");
          })
        : [];
    const originalEvidence = [...textEvidence, ...tableEvidence].join("\n\n");

    // Locators
    const charLocators =
      mergedExcerpts.length > 0
        ? `chars ${mergedExcerpts.map((e) => `${e.start + 1}–${e.end}`).join(", ")}`
        : undefined;
    const tableLocators =
      selectedTableIndices.length > 0
        ? selectedTableIndices.map((idx) => `table row ${idx + 1}`).join(", ")
        : undefined;
    const locParts = [record.locator, charLocators, tableLocators].filter(Boolean);
    const locator = locParts.length > 0 ? locParts.join(", ") : undefined;

    // Preserve exact verbatim evidence accessible in flat fields and top summaryEvidence
    const summaryEvidence: SummaryEvidence = {
      sourceId: record.sourceId,
      collectedRecordId: record.id,
      locator,
      excerpts: mergedExcerpts.map((e) => ({
        start: e.start,
        end: e.end,
        text: record.text.slice(e.start, e.end),
      })),
      ...(record.table && selectedTableIndices.length > 0
        ? {
            tableEvidence: {
              headers: record.table.headers,
              rows: selectedTableIndices.map((idx) => record.table!.rows[idx]!),
              rowIndices: selectedTableIndices,
            },
          }
        : {}),
    };

    // Table data restricted to selected indices only
    const table =
      record.table && selectedTableIndices.length > 0
        ? {
            ...record.table,
            rows: selectedTableIndices.map((idx) => record.table!.rows[idx]!),
          }
        : undefined;

    // REUSE flat base from researchTableRows for source-only attributed columns + sourceAssociations.
    // Never copy arbitrary record.fields.original (multi-MB rawHtml), table, or internal fields.
    const baseRows = researchTableRows({ ...dataset, records: [record] });
    const baseRow = baseRows[0];
    const baseFields = baseRow
      ? { ...baseRow.fields }
      : Object.fromEntries(BMW_FEEDBACK_HEADERS.map((k) => [k, null]));

    const fields: Record<string, unknown> = {};
    if (record.recordType === "table") {
      // Strip non-BMW fields when summarizing native table; selected native cells are in exact evidence/table
      for (const header of BMW_FEEDBACK_HEADERS) {
        fields[header] = baseFields[header] ?? null;
      }
    } else {
      // Retain BMW columns and exact source association columns from researchTableRows
      for (const [k, v] of Object.entries(baseFields)) {
        if (k !== "Customer Feedback" && k !== "Original Evidence") {
          fields[k] = v;
        }
      }
    }

    fields.ID = baseFields.ID ?? record.id;
    fields["Customer Feedback"] = joinedSummaryText;
    fields["Original Evidence"] = originalEvidence;

    // Don't synthesize VFC full when source already values arrays
    if (
      fields["Vfc level2 3 Name"] == null &&
      typeof fields["Vfc level2 Name"] === "string" &&
      typeof fields["Vfc level3 Name"] === "string"
    ) {
      fields["Vfc level2 3 Name"] = `${fields["Vfc level2 Name"]} : ${fields["Vfc level3 Name"]}`;
    }

    // Compact metadata MUST stay <= 8192 total. Put textOrigin in metadata BEFORE compaction.
    // Do NOT add huge originalFields or summaryEvidence to metadata after compaction.
    const rawMeta = {
      ...record.metadata,
      textOrigin: "ai_summary",
    };
    const { metadata: compactMeta, archivedMetadataKeys } = rowMetadata(rawMeta);

    const row: ResearchTableRow = {
      ...record,
      id: record.id,
      collectedRecordId: record.id,
      sourceId: record.sourceId,
      recordType: "passage",
      text: joinedSummaryText,
      locator,
      fields,
      market: typeof fields.Country === "string" ? fields.Country : record.marketAttribution?.value,
      metadata: compactMeta,
      ...(table ? { table } : {}),
      ...(archivedMetadataKeys?.length ? { archivedMetadataKeys } : {}),
      sourceAssessments: relevantAssessments.map(({ agentId, verdict, model }) => ({
        agentId,
        verdict,
        model,
      })),
      contentHash: createHash("sha256")
        .update(
          JSON.stringify({
            text: joinedSummaryText,
            table,
            metadata: compactMeta,
          }),
        )
        .digest("hex"),
    };
    if (!table) {
      delete (row as Partial<ResearchRecord>).table;
    }
    (row as Record<string, unknown>).summaryEvidence = summaryEvidence;

    rows.push(row);
  }

  assertJsonByteBudget(rows, PERSISTED_JSON_MAX_BYTES);
  return rows;
}

/**
 * Async wrapper compatible with existing research block index call sites.
 * Accepts options (scope, llm, signal, log, concurrency) but never calls LLM.
 */
export async function summarizeResearchDataset(
  dataset: ResearchDataset,
  options?: SummarizeOptions,
): Promise<ResearchTableRow[]> {
  if (options?.signal?.aborted) {
    throw new Error("Operation cancelled.");
  }
  return summarizeResearchRows(dataset);
}
