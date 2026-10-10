import { DATA_KEYS, PipelineData, emptyPipelineData, type DataKey } from "@reqflow/core";

export type PrimaryLayer = Exclude<DataKey, "sources">;
export type PrimaryItem = PipelineData[PrimaryLayer][number];
export interface PromptItem {
  id: string;
  layer: PrimaryLayer;
  item: PrimaryItem;
  context: PipelineData;
}
export type Membership = Record<DataKey, Set<string>>;
export function emptyMembership(): Membership {
  return Object.fromEntries(DATA_KEYS.map((key) => [key, new Set<string>()])) as Membership;
}

/** Validate without using the parsed copy: Zod strips upstream extension/provenance fields. */
export function validateInput(input: PipelineData): void {
  PipelineData.parse(input);
  for (const key of DATA_KEYS) {
    const ids = new Set<string>();
    for (const item of input[key]) {
      if (ids.has(item.id)) throw new Error(`AI Splitter input has duplicate ${key} ID ${item.id}`);
      ids.add(item.id);
    }
  }
  const records = new Map(input.records.map((r) => [r.id, r]));
  for (const finding of input.findings) {
    for (const evidence of finding.evidence) {
      const record = evidence.recordId ? records.get(evidence.recordId) : undefined;
      if (!record) continue; // Partial envelopes are allowed, but unavailable references are logged below.
      if (record.sourceId !== evidence.sourceId) {
        throw new Error(`Finding ${finding.id} evidence source does not match record ${record.id}`);
      }
      if (!record.text.includes(evidence.excerpt)) {
        throw new Error(`Finding ${finding.id} excerpt is not verbatim in record ${record.id}`);
      }
    }
  }
}

export function primaryLayer(input: PipelineData): PrimaryLayer | undefined {
  return (["requirements", "themes", "findings", "records"] as const).find(
    (key) => input[key].length,
  );
}

/** Stable original objects and envelope metadata, never schema-parsed copies. */
export function select(input: PipelineData, membership: Membership): PipelineData {
  return {
    ...input,
    sources: input.sources.filter((v) => membership.sources.has(v.id)),
    records: input.records.filter((v) => membership.records.has(v.id)),
    findings: input.findings.filter((v) => membership.findings.has(v.id)),
    themes: input.themes.filter((v) => membership.themes.has(v.id)),
    requirements: input.requirements.filter((v) => membership.requirements.has(v.id)),
  };
}

/**
 * Dependency closure. Supporting context may occur on several branches; primary items never do.
 * For requirements, themes connected to cited findings are contextual clusters, including siblings.
 * Missing referenced entities remain missing and are reported, never fabricated or removed from IDs.
 */
export function evidenceIndex(input: PipelineData, log: (message: string) => void) {
  const primary = primaryLayer(input);
  const maps = {
    sources: new Map(input.sources.map((v) => [v.id, v])),
    records: new Map(input.records.map((v) => [v.id, v])),
    findings: new Map(input.findings.map((v) => [v.id, v])),
    themes: new Map(input.themes.map((v) => [v.id, v])),
    requirements: new Map(input.requirements.map((v) => [v.id, v])),
  };
  const positions = new Map(
    DATA_KEYS.flatMap((key) => input[key].map((item, index) => [item.id, index] as const)),
  );
  function selected<T extends { id: string }>(map: Map<string, T>, ids: Set<string>): T[] {
    return [...ids]
      .map((id) => map.get(id)!)
      .sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
  }
  const themesByFinding = new Map<string, Set<string>>();
  const findingsByTheme = new Map<string, Set<string>>();
  for (const theme of input.themes) {
    for (const findingId of theme.findingIds) {
      const ids = themesByFinding.get(findingId) ?? new Set<string>();
      ids.add(theme.id);
      themesByFinding.set(findingId, ids);
    }
  }
  for (const finding of input.findings) {
    if (!finding.themeId) continue;
    const ids = findingsByTheme.get(finding.themeId) ?? new Set<string>();
    ids.add(finding.id);
    findingsByTheme.set(finding.themeId, ids);
  }
  const warned = new Set<string>();
  function missing(key: DataKey, id: string) {
    const ref = `${key}:${id}`;
    if (!warned.has(ref))
      log(`Unavailable referenced ${key} ${id}; retaining original link, no evidence invented.`);
    warned.add(ref);
  }
  return {
    /** Build small prompt contexts from indexes, not one full input scan per primary item. */
    context(membership: Membership): PipelineData {
      return {
        ...input,
        sources: selected(maps.sources, membership.sources),
        records: selected(maps.records, membership.records),
        findings: selected(maps.findings, membership.findings),
        themes: selected(maps.themes, membership.themes),
        requirements: selected(maps.requirements, membership.requirements),
      };
    },
    closure(layer: DataKey, id: string): Membership {
      const membership = emptyMembership();
      function add(key: DataKey, ref: string): void {
        if (membership[key].has(ref)) return;
        if (!maps[key].has(ref)) {
          missing(key, ref);
          return;
        }
        membership[key].add(ref);
        switch (key) {
          case "requirements": {
            const requirement = maps.requirements.get(ref)!;
            const findingIds = [...requirement.findingIds, ...requirement.conflictingFindingIds];
            for (const findingId of findingIds) {
              add("findings", findingId);
              for (const themeId of themesByFinding.get(findingId) ?? []) add("themes", themeId);
              const themeId = maps.findings.get(findingId)?.themeId;
              if (themeId) add("themes", themeId);
            }
            for (const sourceId of requirement.sourceIds) add("sources", sourceId);
            break;
          }
          case "themes": {
            for (const findingId of maps.themes.get(ref)!.findingIds) add("findings", findingId);
            for (const findingId of findingsByTheme.get(ref) ?? []) add("findings", findingId);
            break;
          }
          case "findings": {
            const finding = maps.findings.get(ref)!;
            // Supporting themes may be shared; classified primary themes must not be duplicated.
            if (finding.themeId && primary !== "themes") add("themes", finding.themeId);
            for (const evidence of finding.evidence) {
              add("sources", evidence.sourceId);
              if (evidence.recordId) add("records", evidence.recordId);
            }
            break;
          }
          case "records":
            add("sources", maps.records.get(ref)!.sourceId);
            break;
          case "sources":
            break;
        }
      }
      add(layer, id);
      return membership;
    },
  };
}

/** Orphans are unclassified context, retained once on the first occupied branch (lowest output index). */
export function retainOrphans(
  input: PipelineData,
  memberships: Membership[],
  index: ReturnType<typeof evidenceIndex>,
  log: (message: string) => void,
): void {
  const first = memberships.find((membership) => DATA_KEYS.some((key) => membership[key].size));
  if (!first) return;
  const counts: string[] = [];
  for (const key of DATA_KEYS) {
    const referenced = new Set(memberships.flatMap((membership) => [...membership[key]]));
    const orphans = input[key].filter((item) => !referenced.has(item.id));
    for (const item of orphans) {
      const closure = index.closure(key, item.id);
      for (const dependencyKey of DATA_KEYS) {
        for (const id of closure[dependencyKey]) first[dependencyKey].add(id);
      }
    }
    if (orphans.length) counts.push(`${orphans.length} ${key}`);
  }
  if (counts.length)
    log(
      `Retained orphan upstream context (${counts.join(", ")}) once on out-${memberships.indexOf(first)} with dependency closure; evidence may be shared, not independently classified.`,
    );
}

export function emptyOutputs(count: number): Record<string, PipelineData> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`out-${i}`, emptyPipelineData()]),
  );
}
