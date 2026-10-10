import { HIL_SAMPLE_LIMIT, type PipelineData } from "@reqflow/core";

export type ExportSelection = {
  Requirements: Set<string>;
  Themes: Set<string>;
  Findings: Set<string>;
  Records: Set<string>;
  Sources: Set<string>;
};

export function initializeSampleSelection(data: PipelineData): ExportSelection {
  return {
    Requirements: new Set(data.requirements.slice(0, 3).map((x) => x.id)),
    Themes: new Set(data.themes.slice(0, 3).map((x) => x.id)),
    Findings: new Set(data.findings.slice(0, 3).map((x) => x.id)),
    Records: new Set(data.records.slice(0, 3).map((x) => x.id)),
    Sources: new Set(data.sources.slice(0, 3).map((x) => x.id)),
  };
}

export function toggleSelection(
  prev: ExportSelection,
  dataset: keyof ExportSelection,
  id: string,
  maxAllowed = HIL_SAMPLE_LIMIT,
): ExportSelection {
  const totalSelected = Object.values(prev).reduce(
    (acc, set) => acc + (set as Set<string>).size,
    0,
  );
  const next = { ...prev };
  const set = new Set(next[dataset]);
  if (set.has(id)) {
    set.delete(id);
  } else {
    if (totalSelected >= maxAllowed) return prev;
    set.add(id);
  }
  next[dataset] = set;
  return next;
}

export function selectedSample(data: PipelineData, ids: ExportSelection): PipelineData {
  return {
    requirements: data.requirements.filter((r) => ids.Requirements.has(r.id)),
    themes: data.themes.filter((r) => ids.Themes.has(r.id)),
    findings: data.findings.filter((r) => ids.Findings.has(r.id)),
    records: data.records.filter((r) => ids.Records.has(r.id)),
    sources: data.sources.filter((r) => ids.Sources.has(r.id)),
  };
}
