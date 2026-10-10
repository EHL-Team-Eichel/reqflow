import { DATA_KEYS, type PipelineData } from "@reqflow/core";
import { emptyMembership, emptyOutputs, evidenceIndex, primaryLayer, select } from "./evidence";

/**
 * Raw records are primary, even when an upstream envelope also contains findings/requirements.
 * Linked non-primary context follows each referenced record. A multi-record finding may appear on
 * multiple outputs, but its original references are never rewritten and primary records never copied.
 * Cross-output record links resolve through the run/report rather than duplicating classified records.
 */
export function selectRawOutputs(input: PipelineData, routes: Map<string, number>, count: number) {
  const outputs = emptyOutputs(count);
  const memberships = Array.from({ length: count }, emptyMembership);
  const recordPorts = new Map<string, Set<number>>();
  for (const record of input.records) {
    const port = routes.get(record.id);
    if (port === undefined || !memberships[port])
      throw new Error(`AI Splitter missing raw route for ${record.id}`);
    memberships[port]!.records.add(record.id);
    memberships[port]!.sources.add(record.sourceId);
    recordPorts.set(record.id, new Set([port]));
  }
  let crossBranchEvidence = false;
  let unavailableReferenceCount = 0;
  const index = evidenceIndex(input, () => {
    unavailableReferenceCount++;
  });
  const fallback = input.records.length
    ? [...routes.values()].reduce((min, port) => Math.min(min, port), count - 1)
    : count - 1;
  for (const key of ["findings", "themes", "requirements"] as const) {
    for (const item of input[key]) {
      const closure = index.closure(key, item.id);
      const ports = new Set([...closure.records].flatMap((id) => [...(recordPorts.get(id) ?? [])]));
      if (ports.size > 1) crossBranchEvidence = true;
      if (!ports.size) ports.add(fallback);
      for (const port of ports) {
        for (const dependency of DATA_KEYS) {
          if (dependency === "records") continue;
          for (const id of closure[dependency]) memberships[port]![dependency].add(id);
        }
      }
    }
  }
  const referencedSources = new Set(memberships.flatMap((m) => [...m.sources]));
  for (const source of input.sources)
    if (!referencedSources.has(source.id)) memberships[fallback]!.sources.add(source.id);
  for (const [i, membership] of memberships.entries()) {
    // Keep envelope extensions even on empty outputs, and keep all original entity objects.
    outputs[`out-${i}`] = select(input, membership);
  }
  return { outputs, crossBranchEvidence, unavailableReferenceCount };
}

/** Evidence-free new modes preserve non-record envelopes once; no provisional customer demand. */
export function selectWithoutRecords(input: PipelineData, count: number) {
  const outputs = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`out-${i}`, select(input, emptyMembership())]),
  );
  const layer = primaryLayer(input) ?? "sources";
  outputs[`out-${count - 1}`] = input;
  return { outputs, layer };
}
