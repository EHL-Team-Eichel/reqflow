/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./CarPage.tsx", import.meta.url), "utf8");

describe("Car page requirement source", () => {
  it("uses flow requirements without exposing a synthetic sample toggle", () => {
    expect(page).toContain('useCarRequirements("app")');
    expect(page).not.toContain("car-source-");
    expect(page).not.toMatch(/synthetic sample/i);
    expect(page).not.toContain("setSource");
  });

  it("keeps the view controls and gives an actionable empty state", () => {
    expect(page).toContain('testIdPrefix="car-view-"');
    expect(page).toContain("Run a flow with an Add to Car block to see requirements here.");
  });
});
