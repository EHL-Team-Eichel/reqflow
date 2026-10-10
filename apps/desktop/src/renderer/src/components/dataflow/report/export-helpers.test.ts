import { describe, it, expect } from "vitest";
import { emptyPipelineData } from "@reqflow/core";
import { fixturePipelineData } from "@reqflow/core/fixtures";
import { initializeSampleSelection, toggleSelection, selectedSample } from "./export-helpers";

describe("Export sample selection", () => {
  it("defaults to at most the first 3 per dataset and never more than 15", () => {
    const ids = initializeSampleSelection(fixturePipelineData);
    const sample = selectedSample(fixturePipelineData, ids);
    expect(sample.records).toEqual(fixturePipelineData.records.slice(0, 3));
    expect(sample.requirements).toEqual(fixturePipelineData.requirements.slice(0, 3));
    expect(Object.values(ids).reduce((n, set) => n + set.size, 0)).toBeLessThanOrEqual(15);
  });
  it("selects records by canonical id, not a locator, and omits unchecked data without expanding references", () => {
    const data = { ...emptyPipelineData(), records: fixturePipelineData.records.slice(0, 4) };
    const initial = initializeSampleSelection(data);
    const removed = toggleSelection(initial, "Records", data.records[0]!.id);
    const added = toggleSelection(removed, "Records", data.records[3]!.id);
    expect(selectedSample(data, added).records.map((r) => r.id)).toEqual(
      data.records.slice(1, 4).map((r) => r.id),
    );
    expect(initial.Records.has(data.records[0]!.id)).toBe(true);
    expect(selectedSample(data, added).sources).toEqual([]);
  });
  it("enforces the total cap across categories and still allows deselection", () => {
    const ids = initializeSampleSelection(emptyPipelineData());
    ids.Records = new Set(Array.from({ length: 15 }, (_, n) => `rec_${n}`));
    expect(toggleSelection(ids, "Sources", "src_extra")).toBe(ids);
    const removed = toggleSelection(ids, "Records", "rec_0");
    expect(removed.Records.size).toBe(14);
    expect(toggleSelection(removed, "Sources", "src_extra").Sources.has("src_extra")).toBe(true);
  });
  it("initializes empty data without phantom selections", () => {
    const data = emptyPipelineData();
    expect(selectedSample(data, initializeSampleSelection(data))).toEqual(data);
  });
});
