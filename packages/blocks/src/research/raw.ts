import { createHash } from "node:crypto";
import { z } from "zod";
import { ASSESSMENT_FIELD, sourceAssessments } from "./assessment";
import {
  CollectedItem,
  ResearchDataset,
  ResearchRecord,
  Source,
  type ResearchAgentId,
  type AgentCollectionResult,
} from "@reqflow/core";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function compareRetrievedAt(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds) return milliseconds;
  // Valid UTC ISO timestamps may have more than millisecond precision or omit the fraction.
  const fraction = (timestamp: string) => /\.(\d+)Z$/.exec(timestamp)?.[1] ?? "";
  const a = fraction(left),
    b = fraction(right);
  const precision = Math.max(a.length, b.length);
  return a.padEnd(precision, "0").localeCompare(b.padEnd(precision, "0"));
}
export function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}
function identity(item: CollectedItem): string {
  // Documents collected through two search vendors remain one publication/record.
  const document = item.provider === "firecrawl" || item.provider === "tavily";
  return document
    ? `${normalizedUrl(item.sourceUrl)}|document`
    : `${new URL(item.sourceUrl).hostname}|${item.provider}|${item.recordId}`;
}
function contentPayload(item: CollectedItem): unknown {
  const substantiveMetadata = item.metadata ? { ...item.metadata } : undefined;
  if (substantiveMetadata) {
    delete substantiveMetadata.search;
    delete substantiveMetadata.requestId;
    delete substantiveMetadata.usage;
    delete substantiveMetadata.executionTimeMs;
  }
  return {
    text: item.text,
    table: item.table,
    recordType: item.recordType,
    metadata: substantiveMetadata,
  };
}

export function normalizeItem(
  input: unknown,
  agentId: ResearchAgentId,
  runId: string,
  retrievedAt: string,
): { source: Source; record: ResearchRecord } {
  const item = CollectedItem.parse(input);
  const sourceId = `src_${digest(normalizedUrl(item.sourceUrl)).slice(0, 32)}`;
  const source = Source.parse({
    id: sourceId,
    kind: item.sourceKind,
    origin: item.provider === "local_documents" ? "bmw_internal" : "web",
    title: item.sourceTitle,
    uri: item.sourceUrl,
    publisher: item.publisher,
    publishedAt: z.iso.datetime().safeParse(item.publishedAt).success
      ? item.publishedAt
      : undefined,
    retrievedAt,
  });
  const rawMeta = (item.metadata ?? {}) as Record<string, unknown>;
  const { rawHtml: _rawHtml, pages: _pages, pdfDump: _pdfDump, ...compactOriginal } = rawMeta;
  const record = ResearchRecord.parse({
    id: `rec_${digest(identity(item)).slice(0, 32)}`,
    sourceId,
    text: item.text,
    locator: item.locator,
    language: item.language,
    fields: { original: compactOriginal, ...(item.table ? { table: item.table } : {}) },
    recordType: item.recordType,
    originalSourceId: item.sourceId,
    originalRecordId: item.recordId,
    provider: item.provider,
    originalUrl: item.sourceUrl,
    collectingAgents: [agentId],
    runIds: [runId],
    retrievedAt,
    publishedAt: item.publishedAt,
    datePrecision: item.datePrecision,
    marketAttribution: item.market,
    vehicleAttribution: item.vehicle,
    parentId: item.parentId,
    threadId: item.threadId,
    context: item.context,
    table: item.table,
    metadata: item.metadata,
    limitations: item.limitations,
    contentHash: digest(JSON.stringify(contentPayload(item))),
  });
  return { source, record };
}
export function mergeResearchDatasets(...datasets: ResearchDataset[]): ResearchDataset {
  if (!datasets.length) throw new Error("No research datasets to merge");
  const sources = new Map<string, Source>();
  const records = new Map<string, ResearchRecord>();
  const results: AgentCollectionResult[] = [];
  let latestDataset: ResearchDataset | undefined;
  for (const input of datasets) {
    const dataset = ResearchDataset.parse(input);
    if (!latestDataset || compareRetrievedAt(dataset.retrievedAt, latestDataset.retrievedAt) >= 0)
      latestDataset = dataset;
    for (const source of dataset.sources) {
      const previous = sources.get(source.id);
      if (!previous || compareRetrievedAt(source.retrievedAt, previous.retrievedAt) >= 0)
        sources.set(source.id, source);
    }
    for (const record of dataset.records) {
      const previous = records.get(record.id);
      const latest =
        previous && compareRetrievedAt(previous.retrievedAt, record.retrievedAt) > 0
          ? previous
          : record;
      records.set(record.id, {
        ...latest,
        fields: {
          ...latest.fields,
          ...((previous?.fields && Object.hasOwn(previous.fields, ASSESSMENT_FIELD)) ||
          Object.hasOwn(record.fields ?? {}, ASSESSMENT_FIELD)
            ? {
                [ASSESSMENT_FIELD]: [
                  ...new Map(
                    [...(previous ? sourceAssessments(previous) : []), ...sourceAssessments(record)]
                      .filter((assessment) => assessment.contentHash === latest.contentHash)
                      .map((assessment) => [
                        `${assessment.agentId}:${assessment.runId}:${JSON.stringify(assessment.scope)}`,
                        assessment,
                      ]),
                  ).values(),
                ],
              }
            : {}),
        },
        collectingAgents: [
          ...new Set([...(previous?.collectingAgents ?? []), ...record.collectingAgents]),
        ],
        runIds: [...new Set([...(previous?.runIds ?? []), ...record.runIds])],
        limitations: [
          ...new Set([
            ...(previous?.limitations ?? []),
            ...record.limitations,
            ...(previous && previous.contentHash !== record.contentHash
              ? [
                  "Source content changed; this dataset retains the latest collected revision by retrievedAt; timestamp ties use merge order. Earlier run datasets retain previous content.",
                ]
              : []),
          ]),
        ],
      });
    }
    results.push(...dataset.results);
  }
  return ResearchDataset.parse({
    ...latestDataset!,
    sources: [...sources.values()],
    records: [...records.values()],
    results,
    synthetic: datasets.some((d) => d.synthetic),
  });
}
