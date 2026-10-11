import { describe, expect, it } from "vitest";
import { FilterOverride, FilterReport, FilterReview } from "./filter-report";
import { defaultBlockParams, migrateBlockParams, parseBlockParams } from "./blocks";
import { emptyPipelineData } from "./pipeline";

describe("selection-only filter contracts", () => {
  it("migrates persisted four-parameter filters without changing their criterion or policy", () => {
    const legacy = {
      criterion: "Keep original vehicle feedback",
      model: "default",
      minConfidence: 0.9,
      keepUnsure: false,
    };
    const migrated = migrateBlockParams("ai_filter", legacy);
    expect(parseBlockParams("ai_filter", migrated)).toEqual({
      ...defaultBlockParams("ai_filter"),
      ...legacy,
    });
    expect(() => parseBlockParams("ai_filter", { ...migrated, unexpected: true })).toThrow();
  });
  it("validates originals without stripping unknown provenance and structured fields", () => {
    const originalInput = {
      ...emptyPipelineData(),
      records: [
        {
          id: "rec_test",
          sourceId: "src_test",
          text: "Synthetic seats",
          fields: { nested: { original: true } },
          extraProvenance: { offset: 12 },
        },
      ],
      dataProfile: { synthetic: true },
    };
    const report = FilterReport.parse({
      schemaVersion: 1,
      runId: "run_test",
      blockId: "filter",
      createdAt: "2026-10-11T00:00:00Z",
      primaryLayer: "records",
      configurationHash: "a".repeat(64),
      configuration: { ...defaultBlockParams("ai_filter"), fields: [] },
      originalInput,
      decisions: [],
      warnings: [],
    });
    expect(report.originalInput).toBe(originalInput);
    expect(report.originalInput).toEqual(originalInput);
    expect(() => FilterReport.parse({ ...report, originalInput: { records: [] } })).toThrow();
  });
  it("rejects nonhuman overrides and requires unique items and rationale", () => {
    const override = {
      itemId: "rec_test",
      itemHash: "a".repeat(64),
      configurationHash: "b".repeat(64),
      actor: { type: "human", userId: "pm", name: "Synthetic PM" },
      at: "2026-10-11T00:00:00Z",
      rationale: "Restore relevant context",
      version: 1,
    };
    expect(FilterOverride.parse(override)).toEqual(override);
    expect(() =>
      FilterOverride.parse({
        ...override,
        actor: { type: "ai", model: "mock", component: "filter" },
      }),
    ).toThrow();
    expect(() =>
      FilterReview.parse({
        expectedVersion: 0,
        itemIds: ["rec_test", "rec_test"],
        rationale: "Restore",
      }),
    ).toThrow();
    expect(() =>
      FilterReview.parse({ expectedVersion: 0, itemIds: ["rec_test"], rationale: " " }),
    ).toThrow();
  });
});
