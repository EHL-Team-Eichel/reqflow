import { describe, expect, it } from "vitest";
import { defaultBlockParams, parseBlockParams } from "./blocks";

describe("quick AI Judge defaults", () => {
  it("ranks reviews first and keeps a small, low-reasoning run", () => {
    const params = defaultBlockParams("ai_judge");
    expect(params.sources).toEqual([
      "Press & competitor reviews",
      "Customer feedback",
      "Customer studies",
    ]);
    expect(params.reasoningEffort).toBe("low");
    expect(params.maxProblems).toBe(3);
    expect(params.webResearch).toBe(false);
    expect(() => parseBlockParams("ai_judge", params)).not.toThrow();
  });
});
