import { z } from "zod";
import { createHash } from "node:crypto";
import { ResearchDataset, type ResearchRecord, type Source } from "@reqflow/core";
import { assertJsonByteBudget, jsonByteSize, PERSISTED_JSON_MAX_BYTES } from "./data-budget";
import { assessedSelection, sourceAssessments } from "./assessment";
export { assessedSelection, sourceAssessments };

export const BMW_FEEDBACK_HEADERS = [
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
] as const;

export const SourceAssociation = z
  .object({
    headers: z.array(z.string()),
    values: z.array(z.unknown()),
    sheet: z.string(),
    row: z.number().int().positive(),
  })
  .refine(
    (association) => association.headers.length === association.values.length,
    "Source association headers and values must have equal length",
  );

export function sourceAssociations(record: ResearchRecord) {
  const parsed = z.array(SourceAssociation).safeParse(record.metadata.sourceAssociations ?? []);
  if (!parsed.success) throw new Error(`Invalid source association for record ${record.id}.`);
  return parsed.data;
}

function originalFields(record: ResearchRecord): Record<string, unknown> {
  const original = record.metadata.originalFields;
  if (original && typeof original === "object" && !Array.isArray(original))
    return { ...(original as Record<string, unknown>) };
  return Object.fromEntries(
    BMW_FEEDBACK_HEADERS.filter((key) => Object.hasOwn(record.metadata, key)).map((key) => [
      key,
      record.metadata[key],
    ]),
  );
}

/** Paragraph boundaries are mechanical: every returned text is an exact source substring. */
function passages(text: string): { text: string; start: number; end: number }[] {
  const parts = [...text.matchAll(/[^\r\n]+(?:\r?\n(?![\t ]*\r?\n)[^\r\n]+)*/g)]
    .filter((match) => match[0].trim())
    .map((match) => ({ text: match[0], start: match.index!, end: match.index! + match[0].length }));
  // Keep a single record byte-for-byte, including original line breaks and blank content.
  return parts.length > 1 ? parts : [{ text, start: 0, end: text.length }];
}

export type ResearchTableRow = ResearchRecord & {
  collectedRecordId: string;
  /** These metadata values are available on the collected record, not copied per row. */
  archivedMetadataKeys?: string[];
  sourceAssessments?: { agentId: string; verdict: string; model: string }[];
};

const ROW_METADATA_MAX_BYTES = 8 * 1024;

function rowMetadata(metadata: ResearchRecord["metadata"]): {
  metadata: ResearchRecord["metadata"];
  archivedMetadataKeys?: string[];
} {
  const entries: [string, unknown][] = [];
  const archivedMetadataKeys: string[] = [];
  let bytes = 2; // Object braces, plus a comma between retained properties.
  for (const [key, value] of Object.entries(metadata)) {
    const propertyBytes = jsonByteSize({ [key]: value }) - 2 + (entries.length ? 1 : 0);
    if (propertyBytes > ROW_METADATA_MAX_BYTES - bytes) archivedMetadataKeys.push(key);
    else {
      entries.push([key, value]);
      bytes += propertyBytes;
    }
  }
  return {
    metadata: Object.fromEntries(entries),
    ...(archivedMetadataKeys.length ? { archivedMetadataKeys } : {}),
  };
}

/** Same column-oriented fields/text/locator shape as Raw; source archives stay untouched. */
export function researchTableRows(input: ResearchDataset): ResearchTableRow[] {
  const dataset = ResearchDataset.parse(input);
  const sources = new Map(dataset.sources.map((source) => [source.id, source]));
  const rows: ResearchTableRow[] = [];
  const textRow = (
    record: ResearchRecord,
    source: Source | undefined,
    fields: Record<string, unknown>,
    text: string,
    id: string,
    locator: string | undefined,
    association = false,
  ) => {
    const columns = Object.fromEntries(BMW_FEEDBACK_HEADERS.map((key) => [key, null]));
    rows.push({
      ...record,
      collectedRecordId: record.id,
      id,
      text,
      locator,
      fields: {
        ...columns,
        ...fields,
        ID: fields.ID ?? id,
        Source: fields.Source ?? (association ? null : (source?.publisher ?? record.provider)),
        Country: fields.Country ?? (association ? null : (record.marketAttribution?.value ?? null)),
        "Customer Feedback": text,
      },
      market:
        typeof fields.Country === "string"
          ? fields.Country
          : association
            ? undefined
            : record.marketAttribution?.value,
    });
  };

  for (const record of dataset.records) {
    const selection = assessedSelection(record);
    if (selection.reviewed && !selection.excerpts.length && !selection.tableRows.size) continue;
    // Provider HTML, PDF pages and other bulk values belong to the collected archive.
    // A paragraph/native row links to that record instead of multiplying its payload.
    const base = {
      ...record,
      ...rowMetadata(record.metadata),
      ...(selection.reviewed
        ? {
            sourceAssessments: sourceAssessments(record).map(({ agentId, verdict, model }) => ({
              agentId,
              verdict,
              model,
            })),
          }
        : {}),
    };
    const source = sources.get(record.sourceId);
    const associations = sourceAssociations(record);
    if (associations.length) {
      // Like Raw, repeated classifications of one opinion are one record, with lists for
      // differing columns. Exact individual supplied rows remain available in the archive/export.
      const headers = [...new Set(associations.flatMap((association) => association.headers))];
      const fields = Object.fromEntries(
        headers.map((header) => {
          const distinct = new Map<string, unknown>();
          for (const association of associations) {
            const value = association.values[association.headers.indexOf(header)];
            if (value != null) distinct.set(JSON.stringify(value), value);
          }
          const values = [...distinct.values()];
          return [header, values.length > 1 ? values : (values[0] ?? null)];
        }),
      );
      textRow(base, source, fields, record.text, record.id, record.locator, true);
    } else if (record.recordType === "table" && record.table) {
      const { headers, rows: values } = record.table;
      if (
        !headers.length ||
        headers.some((header) => !header.trim()) ||
        new Set(headers).size !== headers.length
      )
        throw new Error("Research table needs unique, nonempty column headers.");
      values.forEach((values, index) => {
        if (selection.reviewed && !selection.tableRows.has(index)) return;
        if (values.length > headers.length)
          throw new Error(`Research table row ${index + 1} has values beyond its column headers.`);
        const fields = Object.fromEntries(
          headers.map((header, column) => [header, values[column] ?? null]),
        );
        const text = headers
          .filter((header) => fields[header] !== null)
          .map((header) => `${header}: ${fields[header]}`)
          .join("; ");
        const locator = `${record.locator ? `${record.locator}, ` : ""}table row ${index + 1}`;
        rows.push({
          ...base,
          collectedRecordId: record.id,
          id: `${record.id}_row${index + 1}`,
          text,
          locator,
          table: { ...record.table!, rows: [values] },
          fields,
          market: record.marketAttribution?.value,
        });
      });
    } else {
      const parts =
        record.recordType === "feedback"
          ? [{ text: record.text, start: 0, end: record.text.length }]
          : selection.reviewed
            ? selection.excerpts.map(({ start, end }) => ({
                text: record.text.slice(start, end),
                start,
                end,
              }))
            : record.recordType === "metadata"
              ? [{ text: record.text, start: 0, end: record.text.length }]
              : passages(record.text);
      const fields = originalFields(record);
      parts.forEach((part, index) => {
        const locator =
          selection.reviewed || parts.length > 1
            ? `${record.locator ? `${record.locator}, ` : ""}chars ${part.start + 1}–${part.end}`
            : record.locator;
        textRow(
          base,
          source,
          fields,
          part.text,
          (selection.reviewed &&
            record.recordType !== "feedback" &&
            (part.start !== 0 || part.end !== record.text.length)) ||
            parts.length > 1
            ? `${record.id}_passage${index + 1}`
            : record.id,
          locator,
        );
      });
    }
  }
  assertJsonByteBudget(rows, PERSISTED_JSON_MAX_BYTES);
  for (const row of rows)
    row.contentHash = createHash("sha256")
      .update(JSON.stringify({ text: row.text, table: row.table, metadata: row.metadata }))
      .digest("hex");
  return rows;
}
