import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatNumber,
  formatPercent,
  formatPoints,
  niceTicks,
  truncate,
} from "./format";

describe("chart formatting", () => {
  it("formats counts, shares and differences", () => {
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(12.345)).toBe("12.3");
    expect(formatCompact(12_345)).toBe("12.3k");
    expect(formatCompact(1_250_000)).toBe("1.3M");
    expect(formatPercent(0.4249)).toBe("42%");
    expect(formatPercent(0.042)).toBe("4.2%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPoints(0.034)).toBe("+3.4 pp");
    expect(formatPoints(-0.12)).toBe("−12 pp");
    expect(formatNumber(Number.NaN)).toBe("–");
  });

  it("makes round ticks that cover the maximum", () => {
    expect(niceTicks(0, 87)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0, 0)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    const ticks = niceTicks(0, 4321);
    expect(ticks[0]).toBe(0);
    expect(ticks.at(-1)!).toBeGreaterThanOrEqual(4321);
  });

  it("truncates long labels", () => {
    expect(truncate("Infotainment & display", 12)).toBe("Infotainmen…");
    expect(truncate("Seats", 12)).toBe("Seats");
  });
});
