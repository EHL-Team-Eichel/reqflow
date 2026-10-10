import { countPipelineData } from "@reqflow/core";
import { fixturePipelineData } from "@reqflow/core/fixtures";
import { describe, expect, it } from "vitest";
import { sampleDataAt } from "./sample";

describe("sampleDataAt", () => {
  it("shapes the synthetic sample like each block's output", () => {
    const raw = sampleDataAt("raw");
    expect(raw.sources.every((s) => s.origin === "bmw_internal")).toBe(true);
    expect(raw.records.length).toBeGreaterThan(0);
    expect(raw.records.every((r) => raw.sources.some((s) => s.id === r.sourceId))).toBe(true);
    expect(countPipelineData(raw)).toMatchObject({ findings: 0, requirements: 0 });

    expect(sampleDataAt("research").sources.every((s) => s.origin === "web")).toBe(true);
    expect(countPipelineData(sampleDataAt("ai_filter")).requirements).toBe(0);
    expect(sampleDataAt("hil")).toBe(fixturePipelineData);
  });
});
