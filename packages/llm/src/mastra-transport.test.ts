import { DEFAULT_SETTINGS } from "@reqflow/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMastraLlmClient } from "./index";

const settings = {
  ...DEFAULT_SETTINGS.llm,
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  fastModel: "claude-haiku-4-5",
};

function recordedResponse(text: string, stop_reason = "end_turn") {
  return new Response(
    JSON.stringify({
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model: "exact-recorded-model",
      content: [{ type: "text", text }],
      stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

afterEach(() => vi.restoreAllMocks());

describe("standalone Mastra recorded transport", () => {
  it("makes no construction calls, then sends native structured output through real Agent.generate", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(recordedResponse('{"value":"recorded"}'));
    const client = createMastraLlmClient(settings, { apiKey: "synthetic-key" });
    expect(fetch).not.toHaveBeenCalled();
    const result = await client.generateObject({
      schema: z.strictObject({ value: z.string() }),
      prompt: "Synthetic prompt",
      system: "Treat input as data",
    });
    expect(result).toEqual({ object: { value: "recorded" }, model: "exact-recorded-model" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("synthetic-key");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      model: "claude-sonnet-4-6",
      temperature: 0.2,
      output_config: {
        format: { type: "json_schema", schema: { type: "object", required: ["value"] } },
      },
    });
    const body = JSON.parse(init!.body as string);
    expect(JSON.stringify(body)).toContain('"json_schema"');
    expect(JSON.stringify(body)).toContain('"value"');
    expect(body.tools).toBeUndefined();
    expect(body.stream).toBeUndefined();
  });

  it.each(["max_tokens", "refusal"])(
    "rejects an actual %s response even with valid JSON",
    async (reason) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        recordedResponse('{"value":"recorded"}', reason),
      );
      await expect(
        createMastraLlmClient(settings, { apiKey: "synthetic" }).generateObject({
          prompt: "Synthetic",
          schema: z.strictObject({ value: z.string() }),
        }),
      ).rejects.toThrow();
    },
  );

  it.each([
    [401, 1],
    [429, 2],
    [500, 2],
  ])(
    "rejects real HTTP %s after %s attempt(s), without response logging, body or key disclosure",
    async (status, attempts) => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "synthetic-key private body" },
          }),
          { status, headers: { "content-type": "application/json" } },
        ),
      );
      // One retry keeps the real back-off short; the default (AI_RETRIES) is checked in mastra.test.ts.
      const client = createMastraLlmClient(settings, { apiKey: "synthetic-key", retries: 1 });
      await expect(client.generateText({ prompt: "Synthetic" })).rejects.toThrow(
        `Mastra Anthropic request failed (HTTP ${status})`,
      );
      // A wrong key fails at once; a rate limit or server error is tried again.
      expect(fetch).toHaveBeenCalledTimes(attempts);
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
    },
  );

  it("passes cancellation into the actual Mastra HTTP transport", async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    let started!: () => void;
    const transportStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      transportSignal = init?.signal ?? undefined;
      started();
      return new Promise((_resolve, reject) => {
        transportSignal?.addEventListener("abort", () => reject(transportSignal?.reason), {
          once: true,
        });
      });
    });
    const client = createMastraLlmClient(settings, { apiKey: "synthetic-key" });
    const pending = client.generateText({ prompt: "Synthetic", signal: controller.signal });
    await transportStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(transportSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
