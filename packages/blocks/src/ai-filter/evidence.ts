import { DATA_KEYS, PipelineData, type DataKey } from "@reqflow/core";

export function evidenceIndex(input: PipelineData, warnings: Set<string>) {
  if (!PipelineData.safeParse(input).success) throw new Error("AI Filter input is invalid.");
  const maps = Object.fromEntries(
    DATA_KEYS.map((key) => [
      key,
      new Map<string, { id: string }>(input[key].map((item) => [item.id, item])),
    ]),
  ) as Record<DataKey, Map<string, { id: string }>>;
  for (const key of DATA_KEYS) {
    if (maps[key].size !== input[key].length)
      throw new Error(`AI Filter input has duplicate ${key} IDs.`);
  }
  const records = new Map(input.records.map((item) => [item.id, item]));
  for (const finding of input.findings) {
    for (const ref of finding.evidence) {
      const record = ref.recordId ? records.get(ref.recordId) : undefined;
      if (record && (record.sourceId !== ref.sourceId || !record.text.includes(ref.excerpt)))
        throw new Error("AI Filter available evidence has inconsistent source or excerpt.");
    }
  }
  const primary: DataKey =
    (["requirements", "themes", "findings", "records"] as const).find((key) => input[key].length) ??
    "sources";
  const themes = new Map(input.themes.map((item) => [item.id, item]));
  const findings = new Map(input.findings.map((item) => [item.id, item]));
  const requirements = new Map(input.requirements.map((item) => [item.id, item]));
  const themesByFinding = new Map<string, Set<string>>();
  for (const theme of input.themes) {
    for (const id of theme.findingIds) {
      const refs = themesByFinding.get(id) ?? new Set<string>();
      refs.add(theme.id);
      themesByFinding.set(id, refs);
    }
  }
  for (const finding of input.findings) {
    if (!finding.themeId) continue;
    const theme = themes.get(finding.themeId);
    if (theme && !theme.findingIds.includes(finding.id))
      throw new Error("AI Filter available theme and finding references are inconsistent.");
  }
  function membership() {
    return Object.fromEntries(DATA_KEYS.map((key) => [key, new Set<string>()])) as Record<
      DataKey,
      Set<string>
    >;
  }
  function select(ids: ReturnType<typeof membership>): PipelineData {
    return {
      ...input,
      ...Object.fromEntries(
        DATA_KEYS.map((key) => [key, input[key].filter((item) => ids[key].has(item.id))]),
      ),
    } as PipelineData;
  }
  function closure(layer: DataKey, id: string) {
    const ids = membership();
    const pending: [DataKey, string][] = [];
    function add(key: DataKey, ref: string) {
      if (ids[key].has(ref)) return;
      if (!maps[key].has(ref)) {
        warnings.add(
          `Unavailable referenced ${key}; original links preserved, no evidence invented.`,
        );
        return;
      }
      ids[key].add(ref);
      pending.push([key, ref]);
    }
    add(layer, id);
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const [key, ref] = pending[cursor]!;
      switch (key) {
        case "requirements": {
          const item = requirements.get(ref)!;
          for (const findingId of [...item.findingIds, ...item.conflictingFindingIds])
            add("findings", findingId);
          for (const sourceId of item.sourceIds) add("sources", sourceId);
          break;
        }
        case "themes":
          for (const findingId of themes.get(ref)!.findingIds) add("findings", findingId);
          for (const finding of input.findings)
            if (finding.themeId === ref) add("findings", finding.id);
          break;
        case "findings": {
          const item = findings.get(ref)!;
          if (item.themeId) add("themes", item.themeId);
          for (const themeId of themesByFinding.get(ref) ?? []) add("themes", themeId);
          for (const evidence of item.evidence) {
            add("sources", evidence.sourceId);
            if (evidence.recordId) add("records", evidence.recordId);
          }
          break;
        }
        case "records":
          add("sources", records.get(ref)!.sourceId);
          break;
        case "sources":
          break;
      }
    }
    return ids;
  }
  // Validate/report missing links even for items later excluded, without resurrecting them.
  for (const key of DATA_KEYS) for (const item of input[key]) closure(key, item.id);
  return { primary, membership, select, closure };
}
