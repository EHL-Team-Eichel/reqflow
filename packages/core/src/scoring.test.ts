import { describe, expect, it } from "vitest";
import { priorityForScore, weightedTotal } from "./scoring";
import { DEFAULT_SETTINGS } from "./settings";

const { weights, thresholds } = DEFAULT_SETTINGS.scoring;
const all = (v: number) => ({
  customer_impact: v,
  evidence_strength: v,
  competitive_gap: v,
  trend_momentum: v,
  brand_fit: v,
  ease: v,
});

describe("scoring formula", () => {
  it("maps 0–5 factor values onto 0–100", () => {
    expect(weightedTotal(all(0), weights)).toBe(0);
    expect(weightedTotal(all(5), weights)).toBe(100);
    expect(weightedTotal(all(2.5), weights)).toBe(50);
  });

  it("rejects out-of-range values and all-zero weights", () => {
    expect(() => weightedTotal(all(6), weights)).toThrow(RangeError);
    expect(() => weightedTotal(all(3), all(0))).toThrow(/weight/);
  });

  it("bands totals with the default thresholds", () => {
    expect(priorityForScore(70, thresholds)).toBe("must");
    expect(priorityForScore(69.9, thresholds)).toBe("should");
    expect(priorityForScore(30, thresholds)).toBe("could");
    expect(priorityForScore(29.9, thresholds)).toBe("wont");
  });
});
