import { z } from "zod";
import { Finding, Theme } from "./finding";
import { Requirement } from "./requirement";
import { Source, SourceRecord } from "./source";

/**
 * The single envelope that flows along every workflow edge (n8n-style: one input, one output).
 * A node reads the keys it `consumes` and returns the envelope with the keys it `produces` updated.
 */
export const DATA_KEYS = ["sources", "records", "findings", "themes", "requirements"] as const;
export const DataKey = z.enum(DATA_KEYS);
export type DataKey = z.infer<typeof DataKey>;

export const PipelineData = z.object({
  sources: z.array(Source),
  records: z.array(SourceRecord),
  findings: z.array(Finding),
  themes: z.array(Theme),
  requirements: z.array(Requirement),
});
export type PipelineData = z.infer<typeof PipelineData>;

export function emptyPipelineData(): PipelineData {
  return { sources: [], records: [], findings: [], themes: [], requirements: [] };
}

function mergeById<T extends { id: string }>(lists: T[][]): T[] {
  const byId = new Map<string, T>();
  for (const list of lists) for (const item of list) byId.set(item.id, item);
  return [...byId.values()];
}

/**
 * How the engine combines several incoming edges into one node input:
 * concatenate per key and de-duplicate by `id`; a later input wins (order = edge order),
 * first-seen position is kept so output order stays stable.
 */
export function mergePipelineData(...parts: PipelineData[]): PipelineData {
  return {
    sources: mergeById(parts.map((p) => p.sources)),
    records: mergeById(parts.map((p) => p.records)),
    findings: mergeById(parts.map((p) => p.findings)),
    themes: mergeById(parts.map((p) => p.themes)),
    requirements: mergeById(parts.map((p) => p.requirements)),
  };
}

export function countPipelineData(data: PipelineData): Record<DataKey, number> {
  return {
    sources: data.sources.length,
    records: data.records.length,
    findings: data.findings.length,
    themes: data.themes.length,
    requirements: data.requirements.length,
  };
}
