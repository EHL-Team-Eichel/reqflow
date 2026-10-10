import { describe, expect, it, vi } from "vitest";
import { openAiClient, openAiStrictSchema } from "./openai";
import { z } from "zod";

function response(object: any, extra: any = {}) {
  return new Response(
    JSON.stringify({
      model: "test-model",
      choices: [
        {
          message: { content: typeof object === "string" ? object : JSON.stringify(object) },
          finish_reason: "stop",
          ...extra,
        },
      ],
    }),
  );
}

describe("openAiClient", () => {
  it("effort vs temperature, token keys", async () => {
    const fetch = vi.fn().mockResolvedValue(response({}));
    const client = openAiClient({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "m",
      fastModel: "m",
      effort: "high",
      temperature: 0.5,
      fetch,
    });
    await client.generateText({ prompt: "hi" });
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body.reasoning_effort).toBe("high");
    expect(body.temperature).toBeUndefined();
    expect(body.max_completion_tokens).toBeGreaterThan(32000);
    expect(body.max_tokens).toBeUndefined();
  });

  it("effort off gets temperature, token keys for gemini", async () => {
    const fetch = vi.fn().mockResolvedValue(response({}));
    const client = openAiClient({
      provider: "gemini",
      baseUrl: "https://api.openai.com/v1",
      model: "m",
      fastModel: "m",
      effort: "off",
      temperature: 0.5,
      fetch,
    });
    await client.generateText({ prompt: "hi" });
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body.temperature).toBe(0.5);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_tokens).toBeGreaterThan(4000);
  });

  it("json_object fallback after 400", async () => {
    let calls = 0;
    const fetch = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1)
        return Promise.resolve(
          new Response(JSON.stringify({ error: { type: "invalid_request_error" } }), {
            status: 400,
          }),
        );
      return Promise.resolve(response({ a: 1 }));
    });
    const client = openAiClient({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "m",
      fastModel: "m",
      effort: "low",
      temperature: 0,
      fetch,
    });
    await client.generateObject({ prompt: "hi", schema: z.object({ a: z.number() }) });
    expect(calls).toBe(2);
    const body2 = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
    expect(body2.response_format.type).toBe("json_object");
  });

  it("strict schema transforms optionals to nullable", () => {
    const schema = z.toJSONSchema(z.object({ a: z.number(), b: z.string().optional() }));
    const strict = openAiStrictSchema(schema);
    expect(strict.required).toEqual(["a", "b"]);
    expect(strict.properties.b.anyOf).toBeDefined();
    expect(strict.properties.b.anyOf[1].type).toBe("null");
  });
});
