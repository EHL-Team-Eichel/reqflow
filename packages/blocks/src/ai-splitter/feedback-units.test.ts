import type { Source, SourceRecord } from "@reqflow/core";
import { describe, expect, it } from "vitest";
import { feedbackUnits } from "./feedback-units";

const source = (id: string, uri?: string): Source => ({
  id,
  uri,
  kind: "customer_feedback",
  origin: "bmw_internal",
  title: "Synthetic data",
  retrievedAt: "2026-01-01T00:00:00.000Z",
  reliability: "high",
});
const record = (
  id: string,
  sourceId: string,
  fields?: Record<string, unknown>,
  locator?: string,
): SourceRecord => ({ id, sourceId, text: "Identical synthetic opinions", fields, locator });
function units(records: SourceRecord[], sources: Source[]) {
  return feedbackUnits(records, new Map(sources.map((s) => [s.id, s])));
}

describe("feedback unit identities", () => {
  it("recognizes syndicated originalCommentId and normalized spreadsheet column names", () => {
    const records = [
      record("rec_a", "src_a", { provider: "synthetic-provider", originalCommentId: "comment-42" }),
      record("rec_b", "src_b", {
        Provider: "synthetic-provider",
        "Original Comment ID": "comment-42",
      }),
      record("rec_c", "src_b", { provider: "other-provider", originalCommentId: "comment-42" }),
    ];
    const result = units(records, [source("src_a"), source("src_b")]);
    expect(result.get("rec_a")).toBe(result.get("rec_b"));
    expect(result.get("rec_a")).not.toBe(result.get("rec_c"));
  });
  it("deduplicates cross-source reimport by canonical source/locator/content, not text alone", () => {
    const records = [
      record("rec_a", "src_a", undefined, "row 1"),
      record("rec_b", "src_b", undefined, "row 1"),
      record("rec_other", "src_a", undefined, "row 2"),
    ];
    const result = units(records, [source("src_a", "file_same"), source("src_b", "file_same")]);
    expect(result.get("rec_a")).toBe(result.get("rec_b"));
    expect(result.get("rec_a")).not.toBe(result.get("rec_other"));
    const withoutLocators = records.map((r) => ({ ...r, locator: undefined }));
    expect(
      new Set(
        units(withoutLocators, [
          source("src_a", "file_same"),
          source("src_b", "file_same"),
        ]).values(),
      ).size,
    ).toBe(3);
  });

  it("preserves matching text/locator with distinct customer identities and provider namespaces", () => {
    const records = [
      record("rec_a", "src_a", { customerId: "a" }, "row 1"),
      record("rec_b", "src_b", { customerId: "b" }, "row 1"),
      record("rec_c", "src_a", { provider: "one", originalId: 42 }),
      record("rec_d", "src_a", { provider: "two", originalId: 42 }),
      record("rec_e", "src_a", { provider: "one", originalId: 42, customerId: "other" }),
    ];
    expect(
      new Set(units(records, [source("src_a", "file_same"), source("src_b", "file_same")]).values())
        .size,
    ).toBe(5);
  });

  it("does not collapse repeated text within one source without explicit original identity", () => {
    const records = [
      record("rec_a", "src_a", undefined, "row 1"),
      record("rec_b", "src_a", undefined, "row 1"),
    ];
    expect(new Set(units(records, [source("src_a", "file_same")]).values()).size).toBe(2);
  });
});
