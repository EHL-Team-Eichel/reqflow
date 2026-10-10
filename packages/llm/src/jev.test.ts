import { describe, expect, it, vi } from "vitest";
import { jevClient } from "./jev";

describe("jevClient", () => {
  it("maps request body and validates documented response", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            q1: { type: "noul", noul: 1.0 },
            q2: { type: "score", score: 1, confidence: 0.8, probabilities: [0, 1] },
            q3: {
              type: "choice",
              choice: "technical",
              confidence: 0.78,
              probabilities: { technical: 0.85, other: 0.15 },
            },
          },
          usage: { input_tokens: 392, output_tokens: 65 },
        }),
      ),
    );
    const client = jevClient({ apiKey: "key", fetch });
    const res = await client.decide({
      state: "data",
      questions: {
        q1: { type: "noul", instructions: "i" },
        q2: { type: "score", instructions: "i", criteria: ["L1", "L2"] },
        q3: { type: "choice", instructions: "i", criteria: { technical: "Tech", other: "Other" } },
      },
    });

    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body.state).toBe("data");
    expect(res.model).toBe("jev-1.13.0");
    expect(res.answers.q1).toEqual({ type: "noul", value: 1.0 });
    expect(res.answers.q2).toEqual({
      type: "score",
      score: 1,
      confidence: 0.8,
      probabilities: [0, 1],
    });
    expect(res.answers.q3).toEqual({
      type: "choice",
      choice: "technical",
      confidence: 0.78,
      probabilities: { technical: 0.85, other: 0.15 },
    });
  });

  it("long state rejected", async () => {
    const client = jevClient({ apiKey: "key" });
    await expect(client.decide({ state: "x".repeat(100001), questions: {} })).rejects.toThrow(
      /too long/,
    );
  });
});
