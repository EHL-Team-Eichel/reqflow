import { describe, expect, it, vi } from "vitest";
import { anthropicClient } from "./anthropic";
import { z } from "zod";

function response(object: any, extra: any = {}) {
  return new Response(
    JSON.stringify({
      model: "claude-test",
      stop_reason: "end_turn",
      content: [
        { type: "text", text: typeof object === "string" ? object : JSON.stringify(object) },
      ],
      ...extra,
    }),
  );
}

describe("anthropicClient", () => {
  it("effort off haiku", async () => {
    const fetch = vi.fn().mockResolvedValue(response({}));
    const client = anthropicClient({
      baseUrl: "https://api.anthropic.com",
      apiKey: "key",
      model: "claude-haiku-5-5",
      fastModel: "claude-haiku-5-5",
      effort: "off",
      temperature: 0.5,
      fetch,
    });
    await client.generateText({ prompt: "hi" });
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.temperature).toBe(0.5);
    expect(body.output_config).toBeUndefined();
  });

  it("effort high adaptive+summarized", async () => {
    const fetch = vi.fn().mockResolvedValue(response({}));
    const client = anthropicClient({
      baseUrl: "https://api.anthropic.com",
      apiKey: "key",
      model: "claude-opus-5-5",
      fastModel: "claude-haiku-5-5",
      effort: "high",
      temperature: 0.5,
      fetch,
    });
    await client.generateText({ prompt: "hi" });
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.temperature).toBeUndefined();
    expect(body.output_config.effort).toBe("high");
  });

  it("stop reason handling", async () => {
    const fetch = vi.fn().mockResolvedValue(response({}, { stop_reason: "max_tokens" }));
    const client = anthropicClient({
      baseUrl: "https://api.anthropic.com",
      apiKey: "key",
      model: "m",
      fastModel: "m",
      effort: "low",
      temperature: 0,
      fetch,
    });
    await expect(client.generateText({ prompt: "hi" })).rejects.toThrow(/stopped before finishing/);
  });

  it("usage sums cache tokens", async () => {
    const fetch = vi.fn().mockResolvedValue(
      response(
        {},
        {
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 2,
            output_tokens: 20,
          },
        },
      ),
    );
    const client = anthropicClient({
      baseUrl: "https://api.anthropic.com",
      apiKey: "key",
      model: "m",
      fastModel: "m",
      effort: "low",
      temperature: 0,
      fetch,
    });
    const res = await client.generateText({ prompt: "hi" });
    expect(res.usage?.inputTokens).toBe(17);
  });

  it("invalid JSON throws", async () => {
    const fetch = vi.fn().mockResolvedValue(response("{bad json"));
    const client = anthropicClient({
      baseUrl: "https://api.anthropic.com",
      apiKey: "key",
      model: "m",
      fastModel: "m",
      effort: "low",
      temperature: 0,
      fetch,
    });
    await expect(client.generateObject({ prompt: "hi", schema: z.object({}) })).rejects.toThrow(
      /not valid JSON/,
    );
  });
});
