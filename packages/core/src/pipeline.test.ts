import { describe, expect, it } from "vitest";
import { fixtureRecords, fixtureSources } from "./fixtures/sample-f70-eu";
import { emptyPipelineData, mergePipelineData, PipelineData } from "./pipeline";

describe("merged research envelopes", () => {
  it("preserves imported envelope metadata through validation and serialization", () => {
    const original = {
      ...emptyPipelineData(),
      sources: fixtureSources,
      records: fixtureRecords,
      collection: { runIds: ["synthetic-research-run"], limitations: ["Synthetic fixture"] },
    };
    const restored = PipelineData.parse(JSON.parse(JSON.stringify(original)));
    expect(restored.collection).toEqual(original.collection);
  });

  it("merges multiple datasets without replacing record provenance with parsed copies", () => {
    const record = {
      ...fixtureRecords[0]!,
      provenance: { originalId: "synthetic-original-comment", collectedBy: ["agent-a"] },
    };
    const reimport = { ...record, provenance: { ...record.provenance, collectedBy: ["agent-b"] } };
    const left = {
      ...emptyPipelineData(),
      records: [record],
      sources: fixtureSources,
      revision: 1,
    };
    const right = {
      ...emptyPipelineData(),
      records: [reimport, fixtureRecords[1]!],
      sources: fixtureSources,
      revision: 2,
      researchRunIds: ["synthetic-run-b"],
    };
    const merged = mergePipelineData(left, right);
    expect(merged.records).toHaveLength(2);
    expect(merged.records[0]).toBe(reimport);
    expect(merged.records[1]).toBe(fixtureRecords[1]);
    expect(merged.sources).toHaveLength(fixtureSources.length);
    expect(merged.revision).toBe(2);
    expect(merged.researchRunIds).toEqual(["synthetic-run-b"]);
    expect(record.provenance.collectedBy).toEqual(["agent-a"]);
  });
});
