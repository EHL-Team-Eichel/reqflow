import { describe, expect, it } from "vitest";
import { RESULT_TABS, shortResult } from "./result-tabs";

describe("compact AI result tabs", () => {
  it("keeps summary, targets and evidence separately accessible", () => {
    expect(RESULT_TABS).toEqual(["Summary", "Targets", "Evidence"]);
  });
  it("shortens only the display and preserves short descriptions", () => {
    expect(shortResult(" Improve seat support. ")).toBe("Improve seat support.");
    const original = "seat comfort ".repeat(50);
    expect(shortResult(original)).toHaveLength(220);
    expect(shortResult(original)).toMatch(/…$/);
    expect(original.length).toBeGreaterThan(220);
  });
});
