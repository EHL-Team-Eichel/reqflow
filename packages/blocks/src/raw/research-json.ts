import {
  DATA_KEYS,
  Finding,
  PipelineData,
  Requirement,
  Source,
  SourceRecord,
  Theme,
  type DataKey,
  type StoredFile,
} from "@reqflow/core";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const schemas = {
  sources: Source,
  records: SourceRecord,
  findings: Finding,
  themes: Theme,
  requirements: Requirement,
};

/** Detect only declared JSON files; do not guess an envelope from CSV or spreadsheet contents. */
export function isResearchJsonFile(file: Pick<StoredFile, "name" | "mimeType">): boolean {
  const mime = file.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  return /\.json$/i.test(file.name) || /^(application|text)\/(?:json|[^/\s]+\+json)$/.test(mime);
}

function fail(path: string, reason: string): never {
  // Paths and reasons are constructed here, never from data values or native parser messages.
  throw new Error(`Research JSON: ${path} ${reason}`);
}

function indexById<T extends { id: string }>(items: T[], layer: DataKey): Map<string, T> {
  const byId = new Map<string, T>();
  for (const [index, item] of items.entries()) {
    if (byId.has(item.id)) fail(`${layer}[${index}].id`, "is a duplicate ID.");
    byId.set(item.id, item);
  }
  return byId;
}

/** Only explicit scalar IDs count; never infer an identity from arbitrary fields or wording. */
function identityField(record: SourceRecord, names: string[]): string | undefined {
  const fields = Object.entries(record.fields ?? {});
  for (const name of names) {
    for (const [key, value] of fields) {
      if (key.toLowerCase().replace(/[^a-z0-9]/g, "") !== name.toLowerCase()) continue;
      if (typeof value === "string" && value.trim()) return value;
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return undefined;
}

function checkIdentities(data: PipelineData): void {
  // A web URI identifies a document. Internal sources may share an upload URI across sheets.
  // No URL normalization is applied: queries and fragments can identify different evidence.
  const sourceUris = new Set<string>();
  for (const [index, source] of data.sources.entries()) {
    const uri = source.uri?.trim();
    if (source.origin !== "web" || !uri) continue;
    if (sourceUris.has(uri)) fail(`sources[${index}].uri`, "is a duplicate web source identity.");
    sourceUris.add(uri);
  }

  // Only an explicit original/comment ID in fields verifies a repeated entry. Scope it to the
  // source, provider and customer: local comment IDs may repeat across providers or customers.
  // Text and locators do not identify people or comments. Without an explicit original ID,
  // distinct core record IDs remain independent, even with identical text and locators.
  const recordIdentities = new Set<string>();
  for (const [index, record] of data.records.entries()) {
    const original = identityField(record, [
      "originalId",
      "originalRecordId",
      "originalCommentId",
      "providerRecordId",
      "reviewId",
      "feedbackId",
      "responseId",
      "commentId",
    ]);
    if (original === undefined) continue;
    const identity = JSON.stringify([
      record.sourceId,
      identityField(record, ["provider", "providerId", "providerName"]) ?? null,
      original,
      identityField(record, ["customerId", "respondentId", "authorId", "userId"]) ?? null,
    ]);
    if (recordIdentities.has(identity))
      fail(`records[${index}]`, "is a duplicate record identity.");
    recordIdentities.add(identity);
  }
}

function checkReferences(data: PipelineData): void {
  const sources = indexById(data.sources, "sources");
  const records = indexById(data.records, "records");
  const findings = indexById(data.findings, "findings");
  const themes = indexById(data.themes, "themes");
  indexById(data.requirements, "requirements");
  checkIdentities(data);

  const requireReference = (exists: boolean, path: string, layer: DataKey) => {
    if (!exists) fail(path, `must reference an item in ${layer}.`);
  };
  for (const [index, record] of data.records.entries()) {
    requireReference(sources.has(record.sourceId), `records[${index}].sourceId`, "sources");
  }
  for (const [index, finding] of data.findings.entries()) {
    if (finding.themeId !== undefined) {
      requireReference(themes.has(finding.themeId), `findings[${index}].themeId`, "themes");
    }
    for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
      const path = `findings[${index}].evidence[${evidenceIndex}]`;
      requireReference(sources.has(evidence.sourceId), `${path}.sourceId`, "sources");
      if (evidence.recordId === undefined) continue; // Source-only evidence is allowed by core.
      const record = records.get(evidence.recordId);
      requireReference(record !== undefined, `${path}.recordId`, "records");
      if (record!.sourceId !== evidence.sourceId) {
        fail(`${path}.sourceId`, "does not match the linked record's source.");
      }
      if (!record!.text.includes(evidence.excerpt)) {
        fail(`${path}.excerpt`, "must be verbatim text from the linked record.");
      }
    }
  }
  for (const [index, theme] of data.themes.entries()) {
    for (const [linkIndex, id] of theme.findingIds.entries()) {
      requireReference(findings.has(id), `themes[${index}].findingIds[${linkIndex}]`, "findings");
    }
  }
  for (const [index, requirement] of data.requirements.entries()) {
    for (const field of ["findingIds", "conflictingFindingIds"] as const) {
      for (const [linkIndex, id] of requirement[field].entries()) {
        requireReference(
          findings.has(id),
          `requirements[${index}].${field}[${linkIndex}]`,
          "findings",
        );
      }
    }
    for (const [linkIndex, id] of requirement.sourceIds.entries()) {
      requireReference(
        sources.has(id),
        `requirements[${index}].sourceIds[${linkIndex}]`,
        "sources",
      );
    }
  }
}

/**
 * Accept a core PipelineData envelope or a structural Research dataset with sources and records.
 * Only absent findings/themes/requirements default to []; malformed supplied layers are errors.
 * Core schemas validate every layer, but their stripped parse output is deliberately discarded:
 * original objects, nested extensions, provenance and envelope metadata must survive unchanged.
 * Duplicate IDs/identities and dangling references fail instead of silently dropping evidence.
 * Errors contain only trusted schema fields and array indexes, never file contents or causes.
 */
export function parseResearchJson(bytes: Uint8Array): PipelineData & Record<string, unknown> {
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new Error("Research JSON exceeds the 16 MiB file limit.");
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Research JSON must contain valid UTF-8 JSON.");
  }
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !("sources" in input) ||
    !Array.isArray(input.sources) ||
    !("records" in input) ||
    !Array.isArray(input.records)
  ) {
    throw new Error("Research JSON must be an object with sources and records arrays.");
  }
  const data = { findings: [], themes: [], requirements: [], ...input };
  const validated = PipelineData.safeParse(data);
  if (!validated.success) {
    const issue = validated.error.issues[0]!;
    const layer = DATA_KEYS.find((key) => key === issue.path[0]);
    let path: string = layer ?? "envelope";
    if (layer && typeof issue.path[1] === "number") {
      path += `[${issue.path[1]}]`;
      const field = issue.path[2];
      if (typeof field === "string" && Object.hasOwn(schemas[layer].shape, field)) {
        path += `.${field}`;
      }
    }
    fail(path, `does not match the core schema (${issue.code}).`);
  }
  const original = data as PipelineData & Record<string, unknown>;
  checkReferences(original);
  return original;
}
