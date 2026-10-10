import { createHash } from "node:crypto";
import type { Source, SourceRecord } from "@reqflow/core";

export const FEEDBACK_KINDS = new Set<Source["kind"]>([
  "customer_feedback",
  "customer_study",
  "review",
]);

/** Recognize explicit original identities, not arbitrary row values or matching opinion text. */
function field(record: SourceRecord, names: string[]): string | undefined {
  const normalized = new Set(names.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "")));
  for (const [key, value] of Object.entries(record.fields ?? {})) {
    if (
      normalized.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")) &&
      ((typeof value === "string" && value.trim()) || typeof value === "number")
    )
      return String(value);
  }
  return undefined;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Units are feedback entries, never persons. Explicit provider/original IDs identify syndication.
 * Without those IDs, URI + locator + full content hash only deduplicates cross-source reimports
 * with one entry per source. Identical text from different IDs/customers remains independent.
 * No global text deduplication; content hashes never identify a unit on their own.
 */
export function feedbackUnits(
  records: SourceRecord[],
  sources: Map<string, Source>,
): Map<string, string> {
  const ids = new Map<string, string>();
  const possibleReimports = new Map<string, SourceRecord[]>();
  for (const record of records) {
    const source = sources.get(record.sourceId)!;
    const original = field(record, [
      "originalId",
      "originalRecordId",
      "originalCommentId",
      "providerRecordId",
      "reviewId",
      "feedbackId",
      "responseId",
      "commentId",
    ]);
    const customer = field(record, ["customerId", "respondentId", "authorId", "userId"]);
    const provider = field(record, ["provider", "providerId", "providerName"]);
    const originUri =
      field(record, [
        "canonicalUri",
        "canonicalUrl",
        "originalUrl",
        "syndicatedFrom",
        "sourceUri",
      ]) ?? source.uri;
    if (original !== undefined) {
      ids.set(
        record.id,
        `unit_${hash(["original", provider ?? originUri ?? source.id, original, customer ?? null])}`,
      );
    } else {
      ids.set(record.id, `unit_${hash(["record", record.sourceId, record.id])}`);
      if (originUri && record.locator) {
        const key = hash([
          "reimport",
          originUri,
          record.locator,
          customer ?? null,
          hash(record.text),
        ]);
        const group = possibleReimports.get(key) ?? [];
        group.push(record);
        possibleReimports.set(key, group);
      }
    }
  }
  for (const [key, records] of possibleReimports) {
    const distinctSources = new Set(records.map((r) => r.sourceId));
    if (distinctSources.size > 1 && distinctSources.size === records.length) {
      for (const record of records) ids.set(record.id, `unit_${key}`);
    }
  }
  return ids;
}
