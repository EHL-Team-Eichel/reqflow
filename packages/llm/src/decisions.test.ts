import { describe, expect, it, vi } from "vitest";
import { llmDecisionClient } from "./decisions";
import { type LlmClient } from "@reqflow/core";

describe("llmDecisionClient", () => {
  it("explicit keys, normalization, confidence, score length check", async () => {
    const mockLlm: LlmClient = {
      generateObject: vi.fn().mockResolvedValue({
        object: {
          answers: {
            q1: { probability: 1.5 }, // will clamp
            q2: { levels: [0.1, 0.4] }, // sum=0.5 -> probs: [0.2, 0.8]
            q3: { options: { a: 0, b: 2 } }, // clamps to 0, 1 -> probs: [0, 1]
          },
        },
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      generateText: vi.fn(),
    };

    const client = llmDecisionClient(mockLlm);
    const res = await client.decide({
      state: "hello",
      questions: {
        q1: { type: "noul", instructions: "t" },
        q2: { type: "score", instructions: "t", criteria: ["L1", "L2"] },
        q3: { type: "choice", instructions: "t", criteria: { a: "A", b: "B" } },
      },
    });

    expect(res.answers.q1).toEqual({ type: "noul", value: 1 });
    // score probs: [0.2, 0.8], score = 0*0.2 + 1*0.8 = 0.8
    // L=2, maxP=0.8, conf = (2*0.8 - 1) / 1 = 0.6
    expect((res.answers.q2 as any).score).toBeCloseTo(0.8);
    expect((res.answers.q2 as any).confidence).toBeCloseTo(0.6);
    // choice probs: {a: 0, b: 1}
    expect((res.answers.q3 as any).choice).toBe("b");
    expect((res.answers.q3 as any).confidence).toBe(1);

    // length check failure
    const badLlm: LlmClient = {
      generateObject: vi.fn().mockResolvedValue({
        object: { answers: { q2: { levels: [0.1] } } },
      }),
      generateText: vi.fn(),
    };
    await expect(
      llmDecisionClient(badLlm).decide({
        state: "h",
        questions: { q2: { type: "score", instructions: "t", criteria: ["L1", "L2"] } },
      }),
    ).rejects.toThrow(/wrong number of levels/);
  });
});
