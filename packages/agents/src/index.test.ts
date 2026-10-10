import { describe, expect, it } from "vitest";
import { createJudgingAgents, createOfflineJudgingAgents } from "./index";

describe("judging agent factory", () => {
  it("rejects missing keys and unsupported providers without making a model call", () => {
    expect(() => createJudgingAgents({ apiKey: "" })).toThrow(/OpenAI API key/);
    expect(() =>
      createJudgingAgents({ apiKey: "synthetic-test-only", model: "other/model" }),
    ).toThrow(/OpenAI model/);
  });
  it("constructs all four roles with the configured model without calling them", () => {
    const agents = createJudgingAgents({
      apiKey: "synthetic-test-only",
      reasoningEffort: "medium",
    });
    expect(agents.model).toBe("openai/gpt-6-luna (reasoning medium)");
    expect(
      [agents.resolveScope, agents.research, agents.proposeActions, agents.judge].every(
        (f) => typeof f === "function",
      ),
    ).toBe(true);
  });
  it("labels the explicit offline demonstration and never pretends to judge quotes", async () => {
    const agents = createOfflineJudgingAgents();
    expect(agents.model).toMatch(/offline demonstration/);
    expect((await agents.judge("synthetic evidence")).quoteChecks).toEqual([]);
    expect((await agents.research("synthetic evidence")).items).toEqual([]);
  });
});
