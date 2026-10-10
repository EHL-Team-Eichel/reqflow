import { z } from "zod";

export const SourceKind = z.enum([
  // provided by BMW per vehicle
  "customer_feedback",
  "equipment_data",
  "sales_volume",
  "customer_study",
  // external enrichment
  "competitor",
  "review",
  "market_trend",
  "other_web",
]);
export type SourceKind = z.infer<typeof SourceKind>;

export const SourceOrigin = z.enum(["bmw_internal", "web"]);
export type SourceOrigin = z.infer<typeof SourceOrigin>;

/** Trust in the source itself (not in a claim derived from it). Feeds the evidence level. */
export const Reliability = z.enum(["high", "medium", "low"]);
export type Reliability = z.infer<typeof Reliability>;

/** A document, dataset or web page that evidence comes from. */
export const Source = z.object({
  id: z.string().startsWith("src_"),
  kind: SourceKind,
  origin: SourceOrigin,
  title: z.string().min(1),
  uri: z.string().optional(), // URL, or `file_…` id of an upload
  publisher: z.string().optional(),
  publishedAt: z.iso.datetime().optional(),
  retrievedAt: z.iso.datetime(),
  reliability: Reliability,
  market: z.string().optional(),
  vehicleLine: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

/** One atomic input item: a feedback comment, a table row, a paragraph of a web page. */
export const SourceRecord = z.object({
  id: z.string().startsWith("rec_"),
  sourceId: z.string().startsWith("src_"),
  text: z.string(), // human-readable content; for tables a "col: value; …" rendering
  fields: z.record(z.string(), z.unknown()).optional(), // original structured columns
  locator: z.string().optional(), // "row 42", "p. 3", "§2" — lets a PM find it in the original
  market: z.string().optional(),
  language: z.string().optional(), // BCP-47, e.g. "de", "zh"
});
export type SourceRecord = z.infer<typeof SourceRecord>;

/** Points from a finding/requirement to the exact evidence. `excerpt` must be verbatim. */
export const EvidenceRef = z.object({
  sourceId: z.string().startsWith("src_"),
  recordId: z.string().startsWith("rec_").optional(),
  excerpt: z.string().min(1).max(1000),
  locator: z.string().optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;
