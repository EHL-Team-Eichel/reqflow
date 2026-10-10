import { describe, expect, it } from "vitest";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import { judgeScore } from "./judge-score";

describe("independent judge score presentation", () => {
  it("does not label other scorers as independent confidence", () => {
    expect(judgeScore(undefined)).toBeNull();
    expect(judgeScore(fixtureRequirements[0]!.score)).toBeNull();
  });
  it("keeps importance and independent confidence separate", () => {
    const score = fixtureRequirements.find((r) => r.score)!.score!;
    expect(
      judgeScore({
        ...score,
        method: "ai-judge@1",
        total: 35,
        factors: {
          ...score.factors,
          evidence_strength: { value: 2, weight: 0, note: "Independent judge" },
        },
      }),
    ).toEqual({ importance: 35, confidence: 40, explanation: "Independent judge" });
  });
});
