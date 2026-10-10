import { describe, expect, it } from "vitest";
import {
  formatPercent,
  levelLabel,
  levelColorClass,
  formatVerdict,
  roleLabel,
  formatDuration,
} from "./format";

describe("format", () => {
  it("formats percent", () => {
    expect(formatPercent(0.823)).toBe("82 %");
  });
  it("formats levels", () => {
    expect(levelLabel("high")).toBe("High");
    expect(levelColorClass("medium")).toBe("text-warn");
  });
  it("formats verdict", () => {
    expect(formatVerdict("accepted")).toBe("Accepted");
    expect(formatVerdict("revised")).toBe("Revised after review");
    expect(formatVerdict("flagged")).toBe("Open issues");
  });
  it("formats role", () => {
    expect(roleLabel("analyst")).toBe("Analysts");
  });
  it("formats duration", () => {
    expect(formatDuration(4200)).toBe("4.2 s");
    expect(formatDuration(72000)).toBe("1 min 12 s");
  });
});
