import { DATA_KEYS, PipelineData, filterGraph, type DataKey } from "@reqflow/core";

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
  const themes = new Map(input.themes.map((theme) => [theme.id, theme]));
  for (const finding of input.findings) {
    if (!finding.themeId) continue;
    const theme = themes.get(finding.themeId);
    if (theme && !theme.findingIds.includes(finding.id))
      throw new Error("AI Filter available theme and finding references are inconsistent.");
  }
  const graph = filterGraph(input);
  const units = graph.units();
  const primary: DataKey = units[0]?.layer ?? "sources";
  const missing = (key: DataKey) =>
    warnings.add(`Unavailable referenced ${key}; original links preserved, no evidence invented.`);
  function select(ids: ReturnType<typeof graph.membership>): PipelineData {
    return {
      ...input,
      ...Object.fromEntries(
        DATA_KEYS.map((key) => [key, input[key].filter((item) => ids[key].has(item.id))]),
      ),
    } as PipelineData;
  }
  const closure = (layer: DataKey, id: string) => graph.closure(layer, id, missing);
  // Validate/report missing links even for items later excluded, without resurrecting them.
  for (const key of DATA_KEYS) for (const item of input[key]) closure(key, item.id);
  return { primary, units, membership: graph.membership, select, closure };
}
