import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import readXlsxFile from "read-excel-file/node";
import { Source, SourceRecord, type SourceKind, type ResearchAgentId } from "@reqflow/core";

export interface IngestedAgentResult {
  agentId: string;
  sources: Source[];
  records: SourceRecord[];
}

const shortHash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/**
 * Maps a Research Agent ID to the most appropriate standard SourceKind.
 */
export function agentToSourceKind(agentId: string): SourceKind {
  switch (agentId) {
    case "competitor_models":
      return "competitor";
    case "editorial_reviews":
    case "youtube":
      return "review";
    case "technology":
    case "market_studies":
    case "regional_context":
    case "bmw_sales":
    case "bmw_strategy":
      return "market_trend";
    case "reddit":
    case "owner_forums":
    case "instagram":
    case "tiktok":
    case "x":
    default:
      return "customer_feedback";
  }
}

/**
 * Finds columns matching known synonyms.
 */
function findColumnIndex(headers: string[], synonyms: string[]): number {
  const normalized = headers.map((h) =>
    h
      .toLowerCase()
      .trim()
      .replace(/[\s_-]+/g, " "),
  );
  for (const syn of synonyms) {
    const idx = normalized.indexOf(syn.toLowerCase().trim());
    if (idx !== -1) return idx;
  }
  for (const syn of synonyms) {
    const idx = normalized.findIndex((h) => h.includes(syn.toLowerCase().trim()));
    if (idx !== -1) return idx;
  }
  return -1;
}

function toIsoDatetime(val: unknown): string | undefined {
  if (!val) return undefined;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return `${trimmed}T00:00:00.000Z`;
    }
    const ms = Date.parse(trimmed);
    if (!Number.isNaN(ms)) {
      return new Date(ms).toISOString();
    }
  }
  return undefined;
}

/**
 * Parses a single Excel file produced by an OpenCode agent into sources and records.
 */
export async function parseOpenCodeExcelFile(
  filePath: string,
  agentId: string,
): Promise<IngestedAgentResult> {
  const bytes = await readFile(filePath);
  const result = await readXlsxFile(Buffer.from(bytes));
  if (!result || !Array.isArray(result) || result.length === 0) {
    return { agentId, sources: [], records: [] };
  }

  // read-excel-file in Node returns [{ sheet: string, data: unknown[][] }]
  const rawRows: unknown[][] =
    result[0] && typeof result[0] === "object" && "data" in (result[0] as Record<string, unknown>)
      ? ((result[0] as { data: unknown[][] }).data ?? [])
      : (result as unknown as unknown[][]);

  if (rawRows.length < 2) {
    return { agentId, sources: [], records: [] };
  }

  const headerRow = (rawRows[0] ?? []).map((c) => String(c ?? "").trim());
  const dataRows = rawRows.slice(1);

  const colId = findColumnIndex(headerRow, ["id", "record id", "feedback id"]);
  const colSource = findColumnIndex(headerRow, ["source", "publisher", "platform"]);
  const colBrand = findColumnIndex(headerRow, ["brand", "make"]);
  const colSalesDesc = findColumnIndex(headerRow, [
    "sales description",
    "model",
    "trim",
    "vehicle",
  ]);
  const colCountry = findColumnIndex(headerRow, ["country", "market", "region"]);
  const colDerivate = findColumnIndex(headerRow, [
    "derivate (e-code)",
    "derivate",
    "e-code",
    "generation",
  ]);
  const colEngineType = findColumnIndex(headerRow, [
    "engine type",
    "powertrain",
    "drivetrain",
    "engine",
  ]);
  const colFeedbackType = findColumnIndex(headerRow, [
    "feedback type",
    "type",
    "sentiment",
    "classification",
  ]);
  const colText = findColumnIndex(headerRow, [
    "customer feedback",
    "feedback",
    "finding",
    "text",
    "comment",
    "quote",
    "observation",
  ]);
  const colVfc = findColumnIndex(headerRow, [
    "vfc level2 3 name",
    "vfc",
    "category",
    "functional area",
    "topic",
  ]);
  const colUrl = findColumnIndex(headerRow, ["source url", "url", "link", "uri", "source link"]);
  const colDate = findColumnIndex(headerRow, [
    "published at",
    "published",
    "date",
    "publication date",
  ]);

  const sourceMap = new Map<string, Source>();
  const records: SourceRecord[] = [];
  const nowIso = new Date().toISOString();
  const kind = agentToSourceKind(agentId);

  let fallbackSeq = 1;

  for (const row of dataRows) {
    const getVal = (col: number) => (col >= 0 && col < row.length ? row[col] : undefined);
    const textVal = String(getVal(colText) ?? "").trim();
    if (!textVal) continue; // skip empty text rows

    const rawId = getVal(colId);
    const idVal = rawId
      ? String(rawId).trim()
      : `OPN-${agentId.toUpperCase()}-${String(fallbackSeq++).padStart(3, "0")}`;
    const sourceVal = String(getVal(colSource) ?? "").trim() || `OpenCode ${agentId}`;
    const brandVal = String(getVal(colBrand) ?? "").trim() || "BMW";
    const salesDescVal = String(getVal(colSalesDesc) ?? "").trim() || null;
    const countryVal = String(getVal(colCountry) ?? "").trim() || null;
    const derivateVal = String(getVal(colDerivate) ?? "").trim() || null;
    const engineTypeVal = String(getVal(colEngineType) ?? "").trim() || null;
    const feedbackTypeVal = String(getVal(colFeedbackType) ?? "").trim() || "Observation";
    const vfcVal = String(getVal(colVfc) ?? "").trim() || null;
    const urlVal = String(getVal(colUrl) ?? "").trim() || null;
    const rawDate = getVal(colDate);
    const dateVal = toIsoDatetime(rawDate);

    const sourceKey = urlVal || sourceVal;
    let source = sourceMap.get(sourceKey);
    if (!source) {
      const sourceId = `src_opn_${shortHash(sourceKey)}`;
      source = Source.parse({
        id: sourceId,
        kind,
        origin: "web",
        title: sourceVal,
        uri: urlVal ?? undefined,
        publisher: sourceVal,
        publishedAt: dateVal,
        retrievedAt: nowIso,
        reliability: "medium",
      });
      sourceMap.set(sourceKey, source);
    }

    const recordId = `rec_opn_${shortHash(`${idVal}-${textVal}`)}`;
    const record: SourceRecord = {
      id: recordId,
      sourceId: source.id,
      text: textVal,
      fields: {
        ID: idVal,
        Source: sourceVal,
        Brand: brandVal,
        "Sales Description": salesDescVal,
        Country: countryVal,
        "Derivate (e-code)": derivateVal,
        "Engine Type": engineTypeVal,
        "Feedback Type": feedbackTypeVal,
        "Customer Feedback": textVal,
        "Vfc level2 3 Name": vfcVal,
        "Source URL": urlVal,
        "Published At": dateVal,
        "Research Agent": agentId,
      },
    };

    records.push(record);
  }

  return {
    agentId,
    sources: Array.from(sourceMap.values()),
    records,
  };
}

/**
 * Scans a directory for all .xlsx files produced by OpenCode research agents and ingests them.
 */
export async function ingestOpenCodeDirectory(
  workingDir: string,
  selectedAgents: (ResearchAgentId | string)[],
): Promise<{ sources: Source[]; records: SourceRecord[] }> {
  const entries = await readdir(workingDir, { withFileTypes: true });
  const xlsxFiles = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".xlsx"))
    .map((e) => e.name);

  const allSources: Source[] = [];
  const allRecords: SourceRecord[] = [];
  const sourceIdSet = new Set<string>();

  for (const agentId of selectedAgents) {
    const targetName = `research_${agentId}.xlsx`;
    let fileToRead: string | undefined;

    if (xlsxFiles.includes(targetName)) {
      fileToRead = targetName;
    } else {
      // Look for any file containing agentId
      fileToRead = xlsxFiles.find((f) => f.toLowerCase().includes(agentId.toLowerCase()));
    }

    if (fileToRead) {
      const fullPath = path.join(workingDir, fileToRead);
      const parsed = await parseOpenCodeExcelFile(fullPath, agentId);
      for (const s of parsed.sources) {
        if (!sourceIdSet.has(s.id)) {
          sourceIdSet.add(s.id);
          allSources.push(s);
        }
      }
      allRecords.push(...parsed.records);
    }
  }

  // If some xlsx files were created that didn't match the specific agent names, ingest them under "general"
  for (const f of xlsxFiles) {
    const alreadyProcessed = selectedAgents.some(
      (agentId) =>
        f.toLowerCase() === `research_${agentId}.xlsx`.toLowerCase() ||
        f.toLowerCase().includes(agentId.toLowerCase()),
    );
    if (!alreadyProcessed) {
      const fullPath = path.join(workingDir, f);
      const parsed = await parseOpenCodeExcelFile(fullPath, "opencode_general");
      for (const s of parsed.sources) {
        if (!sourceIdSet.has(s.id)) {
          sourceIdSet.add(s.id);
          allSources.push(s);
        }
      }
      allRecords.push(...parsed.records);
    }
  }

  return { sources: allSources, records: allRecords };
}
