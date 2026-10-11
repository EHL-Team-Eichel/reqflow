import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { anthropicClient } from "./anthropic";
import { Limiter, LlmHttpError, postJson } from "./http";
import { jevClient } from "./jev";
import { openAiClient } from "./openai";

/** Recorded-style fetch: returns the queued responses in order and keeps every request. */
function fakeFetch(
  ...responses: Array<{ status?: number; body: unknown; headers?: Record<string, string> } | Error>
) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json", ...(next.headers ?? {}) },
    });
  });
  return { fetch: fn as unknown as typeof fetch, requests };
}

const claudeAnswer = (text: string, extra: Record<string, unknown> = {}) => ({
  body: {
    model: "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "Weighed the quotes.", signature: "sig" },
      { type: "text", text },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
    },
    ...extra,
  },
});
const claude = (fetch: typeof globalThis.fetch, patch: Record<string, unknown> = {}) =>
  anthropicClient({
    baseUrl: "https://api.anthropic.com",
    apiKey: "test-key",
    model: "claude-opus-5-5",
    fastModel: "claude-haiku-5-5",
    effort: "medium",
    temperature: 0.2,
    fetch,
    sleep: async () => {},
    ...patch,
  });
const schema = z.object({ ok: z.boolean() });

describe("anthropic client", () => {
  it("maps effort to thinking, never sending temperature while Claude thinks", async () => {
    const f = fakeFetch(
      claudeAnswer('{"ok":true}'),
      claudeAnswer('{"ok":true}'),
      claudeAnswer('{"ok":true}'),
    );
    const llm = claude(f.fetch);
    await llm.generateObject({ prompt: "p", system: "s", schema, tier: "fast", effort: "off" });
    await llm.generateObject({ prompt: "p", schema, effort: "off" });
    await llm.generateObject({ prompt: "p", schema, effort: "high" });
    const [haikuOff, opusOff, opusHigh] = f.requests.map((r) => r.body);
    expect(haikuOff).toMatchObject({
      model: "claude-haiku-5-5",
      thinking: { type: "disabled" },
      temperature: 0.2,
    });
    expect(haikuOff.system).toEqual([
      { type: "text", text: "s", cache_control: { type: "ephemeral" } },
    ]);
    expect(opusOff.thinking).toBeUndefined();
    expect(opusOff.temperature).toBeUndefined();
    expect(opusOff.output_config.effort).toBe("low");
    expect(opusOff.max_tokens).toBe(4096 + 8000); // still thinks, so it gets thinking headroom
    expect(haikuOff.max_tokens).toBe(4096);
    expect(opusHigh.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(opusHigh.temperature).toBeUndefined();
    expect(opusHigh.output_config).toMatchObject({
      effort: "high",
      format: { type: "json_schema" },
    });
    expect(opusHigh.max_tokens).toBe(4096 + 32000);
  });

  it("returns the thinking summary and counts cached input tokens", async () => {
    const res = await claude(fakeFetch(claudeAnswer('{"ok":true}')).fetch).generateObject({
      prompt: "p",
      schema,
    });
    expect(res).toMatchObject({
      object: { ok: true },
      model: "claude-opus-5-5",
      usage: { inputTokens: 1110, outputTokens: 5 },
      thinking: "Weighed the quotes.",
    });
  });

  it("treats every stop other than end_turn as incomplete", async () => {
    const cut = claude(fakeFetch(claudeAnswer("{", { stop_reason: "max_tokens" })).fetch);
    await expect(cut.generateObject({ prompt: "p", schema })).rejects.toThrow(/max_tokens/);
    const refused = claude(fakeFetch(claudeAnswer("{}", { stop_reason: "refusal" })).fetch);
    await expect(refused.generateObject({ prompt: "p", schema })).rejects.toThrow(/declined/);
    const paused = claude(fakeFetch(claudeAnswer("{}", { stop_reason: "pause_turn" })).fetch);
    await expect(paused.generateObject({ prompt: "p", schema })).rejects.toThrow(
      /stopped early \(pause_turn\)/,
    );
  });

  it("names the error type but never echoes the provider's message", async () => {
    const f = fakeFetch({
      status: 401,
      body: {
        type: "error",
        error: { type: "authentication_error", message: "secret-ish detail sk-123" },
      },
    });
    const err = await claude(f.fetch)
      .generateObject({ prompt: "p", schema })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(String((err as Error).message)).toContain("authentication_error");
    expect(String((err as Error).message)).not.toContain("sk-123");
    expect(f.requests).toHaveLength(1); // 401 is not retried
  });

  it("retries overloaded answers and honors retry-after", async () => {
    const slept: number[] = [];
    const f = fakeFetch(
      { status: 529, body: { type: "error", error: { type: "overloaded_error" } } },
      {
        status: 429,
        body: { type: "error", error: { type: "rate_limit_error" } },
        headers: { "retry-after": "2" },
      },
      claudeAnswer('{"ok":true}'),
    );
    const llm = claude(f.fetch, { sleep: async (ms: number) => void slept.push(ms) });
    await expect(llm.generateObject({ prompt: "p", schema })).resolves.toMatchObject({
      object: { ok: true },
    });
    expect(f.requests).toHaveLength(3);
    expect(slept[1]).toBe(2000);
  });

  it("does not retry a bad request", async () => {
    const f = fakeFetch({
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error" } },
    });
    await expect(claude(f.fetch).generateObject({ prompt: "p", schema })).rejects.toThrow(
      /HTTP 400, invalid_request_error/,
    );
    expect(f.requests).toHaveLength(1);
  });
});

describe("transport", () => {
  it("wraps network errors without passing their details on", async () => {
    const f = fakeFetch(
      new TypeError("fetch failed: getaddrinfo ENOTFOUND internal-host"),
      new TypeError("again"),
    );
    const err = await postJson("https://x.test/v1", {
      headers: {},
      body: {},
      fetch: f.fetch,
      timeoutMs: 1000,
      retries: 1,
      provider: "Test",
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as Error).message).toBe("Test could not be reached (network error)");
  });

  it("stops promptly when the caller aborts during a backoff", async () => {
    const controller = new AbortController();
    const f = fakeFetch({ status: 503, body: {} }, claudeAnswer("{}"));
    const pending = postJson("https://x.test/v1", {
      headers: {},
      body: {},
      fetch: f.fetch,
      timeoutMs: 1000,
      provider: "Test",
      signal: controller.signal,
      random: () => 0.5,
    });
    setTimeout(() => controller.abort(new Error("cancelled")), 20);
    await expect(pending).rejects.toThrow("cancelled");
    expect(f.requests).toHaveLength(1);
  });

  it("the limiter never runs more than its limit at once", async () => {
    const limiter = new Limiter(2);
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 5));
          running--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe("openai-compatible client", () => {
  const answer = (content: string) => ({
    body: {
      model: "local-model",
      choices: [{ finish_reason: "stop", message: { content } }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    },
  });

  it("falls back to JSON mode after a 400 without deadlocking a full limiter", async () => {
    const f = fakeFetch(
      { status: 400, body: { error: { code: "unsupported_response_format" } } },
      answer('{"ok":true}'),
    );
    const llm = openAiClient({
      provider: "openai_compatible",
      baseUrl: "http://localhost:11434/v1/",
      model: "local-model",
      fastModel: "",
      effort: "off",
      temperature: 0.1,
      fetch: f.fetch,
      limiter: new Limiter(1),
      sleep: async () => {},
    });
    const result = await Promise.race([
      llm.generateObject({ prompt: "p", schema }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock")), 1000)),
    ]);
    expect(result).toMatchObject({
      object: { ok: true },
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(f.requests[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(f.requests[0]!.headers.Authorization).toBeUndefined();
    expect(f.requests[0]!.body.response_format.type).toBe("json_schema");
    expect(f.requests[1]!.body.response_format).toEqual({ type: "json_object" });
    expect(f.requests[1]!.body.messages[0].content).toContain("JSON Schema");
  });
});

describe("openai client", () => {
  it("never sends temperature to OpenAI, whose current models reason by default", async () => {
    const f = fakeFetch(
      {
        body: {
          model: "m",
          choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
        },
      },
      {
        body: {
          model: "m",
          choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
        },
      },
    );
    const make = (provider: "openai" | "gemini") =>
      openAiClient({
        provider,
        baseUrl: "https://x.test/v1",
        apiKey: "k",
        model: "m",
        fastModel: "",
        effort: "off",
        temperature: 0.3,
        fetch: f.fetch,
      });
    await make("openai").generateObject({ prompt: "p", schema });
    await make("gemini").generateObject({ prompt: "p", schema });
    expect(f.requests[0]!.body.temperature).toBeUndefined();
    expect(f.requests[0]!.body.max_completion_tokens).toBe(4096 + 8000); // reasons by default
    expect(f.requests[1]!.body.temperature).toBe(0.3);
    expect(f.requests[1]!.body.max_tokens).toBe(4096 + 8000); // Gemini thinks by default too
  });
});

describe("jev client", () => {
  it("sends the documented request and maps the documented answer", async () => {
    const f = fakeFetch({
      body: {
        model: "jev-1.13.0",
        answers: {
          department: {
            type: "choice",
            choice: "technical",
            confidence: 0.78,
            probabilities: { technical: 0.85, sales: 0, billing: 0.15 },
          },
          frustration: {
            type: "score",
            score: 1,
            confidence: 1,
            legend: { "0": "Calm", "1": "Frustrated", "2": "Angry" },
            probabilities: { "0": 0, "1": 1, "2": 0 },
          },
          is_urgent: { type: "noul", noul: 1 },
        },
        usage: { input_tokens: 392, output_tokens: 65 },
      },
    });
    const jev = jevClient({ apiKey: "jev-key", fetch: f.fetch });
    const res = await jev.decide({
      state: "Integration keeps failing.",
      questions: {
        department: {
          type: "choice",
          instructions: "Team",
          criteria: { billing: "b", technical: "t", sales: "s" },
        },
        frustration: {
          type: "score",
          instructions: "How frustrated",
          criteria: ["Calm", "Frustrated", "Angry"],
        },
        is_urgent: { type: "noul", instructions: "Urgent" },
      },
    });
    const req = f.requests[0]!;
    expect(req.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(req.headers).toMatchObject({
      "content-type": "application/json",
      Authorization: "Bearer jev-key",
    });
    expect(req.body).toMatchObject({ model: "jev-latest", state: "Integration keeps failing." });
    expect(req.body.questions.frustration.criteria).toEqual(["Calm", "Frustrated", "Angry"]);
    expect(res.model).toBe("jev-1.13.0");
    expect(res.answers.is_urgent).toEqual({ type: "noul", value: 1 });
    expect(res.answers.frustration).toEqual({
      type: "score",
      score: 1,
      probabilities: [0, 1, 0],
      confidence: 1,
    });
    expect(res.answers.department).toMatchObject({
      type: "choice",
      choice: "technical",
      confidence: 0.78,
    });
    expect(res.usage).toEqual({ inputTokens: 392, outputTokens: 65 });
  });

  it("rejects an answer of the wrong type", async () => {
    const f = fakeFetch({
      body: { model: "jev", answers: { q: { type: "choice", choice: "x" } } },
    });
    await expect(
      jevClient({ apiKey: "k", fetch: f.fetch }).decide({
        state: "s",
        questions: { q: { type: "noul", instructions: "i" } },
      }),
    ).rejects.toThrow(/doesn't match/);
  });
});

import { DEFAULT_SETTINGS, LLM_MODEL_DEFAULTS, type LiveLlmProvider } from "@reqflow/core";
import { createLlmClient } from "./index";

describe("default LLM providers", () => {
  const schema = z.strictObject({ value: z.string() });
  const key = "synthetic-private-key";
  const privateText = "synthetic-private-prompt-and-response";
  const providers = ["anthropic", "openai", "google"] as const;
  function settings(provider: LiveLlmProvider, model?: string) {
    return {
      ...DEFAULT_SETTINGS.llm,
      provider,
      ...LLM_MODEL_DEFAULTS[provider],
      ...(model ? { model } : {}),
    };
  }
  function payload(provider: LiveLlmProvider, text = JSON.stringify({ value: "recorded" })) {
    if (provider === "openai")
      return {
        model: "returned-openai-model",
        status: "completed",
        error: null,
        incomplete_details: null,
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
      };
    if (provider === "google")
      return {
        modelVersion: "returned-google-model",
        candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }],
      };
    return {
      model: "returned-anthropic-model",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    };
  }
  function transport(value: unknown) {
    return vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(value)));
  }
  function body(fetch: ReturnType<typeof transport>) {
    return JSON.parse(fetch.mock.calls[0]![1]!.body as string);
  }

  describe("OpenAI Responses", () => {
    it.each(["default", "fast"] as const)(
      "sends exact REST structured contract for %s tier",
      async (tier) => {
        const fetch = transport(payload("openai"));
        const client = createLlmClient(settings("openai"), { apiKey: ` ${key} `, fetch });
        expect(fetch).not.toHaveBeenCalled();
        const controller = new AbortController();
        expect(
          await client.generateObject({
            schema,
            prompt: "test",
            system: "system",
            tier,
            signal: controller.signal,
          }),
        ).toEqual({ object: { value: "recorded" }, model: "returned-openai-model" });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0]).toEqual([
          "https://api.openai.com/v1/responses",
          expect.objectContaining({
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
          }),
        ]);
        expect(body(fetch)).toEqual({
          model:
            tier === "fast" ? LLM_MODEL_DEFAULTS.openai.fastModel : LLM_MODEL_DEFAULTS.openai.model,
          store: false,
          input: "test",
          instructions: "system",
          max_output_tokens: 8192,
          temperature: 0.2,
          text: {
            format: {
              type: "json_schema",
              name: "reqflow_result",
              strict: true,
              schema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            },
          },
        });
      },
    );

    it("extracts REST assistant text, ignores reasoning and SDK convenience output_text", async () => {
      const value = payload("openai", "first") as ReturnType<typeof payload> & {
        output: unknown[];
      };
      value.output.unshift({
        type: "reasoning",
        summary: [{ type: "summary_text", text: privateText }],
      });
      (value.output[1] as { content: unknown[] }).content.push({
        type: "output_text",
        text: " second",
      });
      const fetch = transport({ ...value, output_text: privateText });
      expect(
        await createLlmClient(settings("openai", "custom-model/free-text"), {
          apiKey: key,
          fetch,
        }).generateText({ prompt: "test" }),
      ).toEqual({ text: "first second", model: "returned-openai-model" });
      expect(body(fetch)).toEqual({
        model: "custom-model/free-text",
        store: false,
        input: "test",
        max_output_tokens: 8192,
        temperature: 0.2,
      });
    });

    it.each([
      "gpt-5",
      "gpt-5-mini",
      "gpt-5.4",
      "gpt-6",
      "gpt-6.1-custom",
      "o1",
      "o1-preview",
      "o3-pro",
      "o4-mini",
      "ft:gpt-5:custom",
    ])("omits unsupported temperature for %s", async (model) => {
      const fetch = transport(payload("openai", "text"));
      await createLlmClient(settings("openai", model), { apiKey: key, fetch }).generateText({
        prompt: "test",
      });
      expect(body(fetch).temperature).toBeUndefined();
      expect(body(fetch).model).toBe(model);
    });

    it.each([
      { status: "incomplete", incomplete_details: { reason: privateText } },
      { status: "failed", error: { message: privateText } },
      { error: { message: privateText } },
      { output: [] },
      { output: [], output_text: "SDK-only text" },
      {
        output: [
          {
            type: "message",
            role: "user",
            status: "completed",
            content: [{ type: "output_text", text: "text" }],
          },
        ],
      },
      {
        output: [
          {
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: [{ type: "output_text", text: "text" }],
          },
        ],
      },
      {
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: privateText }],
          },
        ],
      },
      { output: [{ type: "function_call", arguments: privateText }] },
      { output: [{ type: "reasoning", summary: [] }] },
      {
        output: [
          { type: "reasoning", status: "incomplete" },
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "text" }],
          },
        ],
      },
      {
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "  " }],
          },
        ],
      },
      { model: "" },
    ])(
      "rejects incomplete/refused/tool/missing responses without private contents %#",
      async (extra) => {
        const fetch = transport({ ...payload("openai"), ...extra });
        await expect(
          createLlmClient(settings("openai"), { apiKey: key, fetch }).generateText({
            prompt: privateText,
          }),
        ).rejects.toThrow(/^OpenAI response is invalid or incomplete$/);
      },
    );

    it("rejects tools even when valid assistant text exists", async () => {
      const value = payload("openai") as { output: unknown[] };
      value.output.push({ type: "web_search_call", status: "completed" });
      await expect(
        createLlmClient(settings("openai"), {
          apiKey: key,
          fetch: transport(value),
        }).generateObject({
          prompt: "test",
          schema,
        }),
      ).rejects.toThrow(/invalid or incomplete/);
    });

    it("requires all fields on wire, removes only optional nonnullable nulls across nested unions", async () => {
      const item = z.discriminatedUnion("kind", [
        z.strictObject({
          kind: z.literal("optional"),
          value: z.string().optional(),
          keep: z.string().nullable().optional(),
        }),
        z.strictObject({
          kind: z.literal("required"),
          value: z.string().nullable(),
          keep: z.string().nullable().optional(),
        }),
      ]);
      const original = z.strictObject({
        items: z.array(item),
        optional: z.strictObject({ x: z.string().optional() }).optional(),
        requiredNull: z.null(),
      });
      const fetch = transport(
        payload(
          "openai",
          JSON.stringify({
            items: [
              { kind: "optional", value: null, keep: null },
              { kind: "required", value: null, keep: null },
            ],
            optional: { x: null },
            requiredNull: null,
          }),
        ),
      );
      const result = await createLlmClient(settings("openai"), {
        apiKey: key,
        fetch,
      }).generateObject({ prompt: "test", schema: original });
      expect(result.object).toEqual({
        items: [
          { kind: "optional", keep: null },
          { kind: "required", value: null, keep: null },
        ],
        optional: {},
        requiredNull: null,
      });
      const wire = body(fetch).text.format.schema;
      expect(wire.required).toEqual(["items", "optional", "requiredNull"]);
      expect(wire.properties.items.items.anyOf[0]).toMatchObject({
        required: ["kind", "value", "keep"],
        additionalProperties: false,
        properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } },
      });
    });

    it.each([
      { original: z.string().min(2), wire: { result: "ok" }, expected: "ok" },
      { original: z.array(z.number()), wire: { result: [1, 2] }, expected: [1, 2] },
      {
        original: z.union([z.strictObject({ a: z.string().optional() }), z.number()]),
        wire: { result: { a: null } },
        expected: {},
      },
      { original: z.string().nullable(), wire: { result: null }, expected: null },
    ])(
      "envelopes non-object roots and validates unwrapped value %#",
      async ({ original, wire, expected }) => {
        const fetch = transport(payload("openai", JSON.stringify(wire)));
        expect(
          (
            await createLlmClient(settings("openai"), { apiKey: key, fetch }).generateObject({
              prompt: "test",
              schema: original as z.ZodType<unknown>,
            })
          ).object,
        ).toEqual(expected);
        expect(body(fetch).text.format.schema).toMatchObject({
          type: "object",
          required: ["result"],
          additionalProperties: false,
          properties: { result: expect.any(Object) },
        });
      },
    );

    it.each([{}, { result: "ok", extra: true }, "ok"])(
      "rejects malformed envelopes %#",
      async (wire) => {
        await expect(
          createLlmClient(settings("openai"), {
            apiKey: key,
            fetch: transport(payload("openai", JSON.stringify(wire))),
          }).generateObject({ prompt: "test", schema: z.string() }),
        ).rejects.toThrow(/structured response/);
      },
    );

    it("does not remove required nulls or null array elements", async () => {
      for (const original of [
        z.strictObject({ value: z.string() }),
        z.strictObject({ value: z.array(z.string()) }),
      ]) {
        const fetch = transport(
          payload(
            "openai",
            JSON.stringify({ value: original.shape.value instanceof z.ZodArray ? [null] : null }),
          ),
        );
        await expect(
          createLlmClient(settings("openai"), { apiKey: key, fetch }).generateObject({
            prompt: "test",
            schema: original as z.ZodType<unknown>,
          }),
        ).rejects.toThrow(/schema validation/);
      }
    });

    it("validates optional-null union alternatives with the original refinements", async () => {
      const original = z.strictObject({
        item: z.union([
          z
            .strictObject({ x: z.string().optional(), y: z.string().nullable().optional() })
            .refine(() => false, privateText),
          z.strictObject({ x: z.string().nullable().optional(), y: z.string().optional() }),
        ]),
        outer: z.string().optional(),
      });
      const fetch = transport(payload("openai", '{"item":{"x":null,"y":null},"outer":null}'));
      expect(
        (
          await createLlmClient(settings("openai"), { apiKey: key, fetch }).generateObject({
            prompt: "test",
            schema: original,
          })
        ).object,
      ).toEqual({ item: { x: null } });
    });

    it("normalizes definitions and recursive values in an enveloped root", async () => {
      interface Tree {
        value?: string;
        children: Tree[];
      }
      const tree: z.ZodType<Tree> = z.lazy(() =>
        z.strictObject({ value: z.string().optional(), children: z.array(tree) }),
      );
      const fetch = transport(
        payload("openai", '{"result":[{"value":null,"children":[{"value":null,"children":[]}]}]}'),
      );
      expect(
        (
          await createLlmClient(settings("openai"), { apiKey: key, fetch }).generateObject({
            prompt: "test",
            schema: z.array(tree),
          })
        ).object,
      ).toEqual([{ children: [{ children: [] }] }]);
    });

    it("bounds ambiguous optional-null normalization without accepting invalid data", async () => {
      const refinement = vi.fn(() => false);
      const item = z.union([
        z.strictObject({ x: z.string().optional(), y: z.string().nullable() }),
        z.strictObject({ x: z.string().nullable(), y: z.string().optional() }),
      ]);
      const original = z.strictObject({ items: z.array(item) }).refine(refinement);
      const fetch = transport(
        payload(
          "openai",
          JSON.stringify({ items: Array.from({ length: 8 }, () => ({ x: null, y: null })) }),
        ),
      );
      await expect(
        createLlmClient(settings("openai"), { apiKey: key, fetch }).generateObject({
          prompt: "test",
          schema: original,
        }),
      ).rejects.toThrow(/schema validation/);
      expect(refinement).toHaveBeenCalled();
      expect(refinement.mock.calls.length).toBeLessThanOrEqual(128);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("rejects dynamic records before HTTP rather than weakening structured output", async () => {
      for (const original of [
        z.record(z.string(), z.string()),
        z.strictObject({ nested: z.record(z.string(), z.number()).optional() }),
      ]) {
        const fetch = transport(payload("openai"));
        await expect(
          createLlmClient(settings("openai"), { apiKey: key, fetch }).generateObject({
            prompt: "test",
            schema: original as z.ZodType<unknown>,
          }),
        ).rejects.toThrow(/^OpenAI structured output schema is unsupported$/);
        expect(fetch).not.toHaveBeenCalled();
      }
    });
  });

  describe("Google Gemini", () => {
    it.each(["default", "fast"] as const)(
      "sends exact REST structured contract for %s tier",
      async (tier) => {
        const fetch = transport(payload("google"));
        const client = createLlmClient(settings("google"), { apiKey: key, fetch });
        expect(fetch).not.toHaveBeenCalled();
        expect(
          await client.generateObject({ schema, prompt: "test", system: "system", tier }),
        ).toEqual({ object: { value: "recorded" }, model: "returned-google-model" });
        expect(fetch.mock.calls[0]).toEqual([
          `https://generativelanguage.googleapis.com/v1beta/models/${tier === "fast" ? LLM_MODEL_DEFAULTS.google.fastModel : LLM_MODEL_DEFAULTS.google.model}:generateContent`,
          expect.objectContaining({
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": key },
          }),
        ]);
        expect(body(fetch)).toEqual({
          contents: [{ role: "user", parts: [{ text: "test" }] }],
          systemInstruction: { parts: [{ text: "system" }] },
          generationConfig: {
            candidateCount: 1,
            maxOutputTokens: 8192,
            temperature: 0.2,
            responseMimeType: "application/json",
            responseJsonSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        });
      },
    );

    it.each(["models/custom-model", "custom model/with?path#and&query"])(
      "normalizes/encodes custom model %s and never uses query credentials",
      async (model) => {
        const fetch = transport(payload("google", "text"));
        await createLlmClient(settings("google", model), { apiKey: key, fetch }).generateText({
          prompt: "test",
        });
        expect(fetch.mock.calls[0]![0]).toBe(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`,
        );
        expect(body(fetch)).toEqual({
          contents: [{ role: "user", parts: [{ text: "test" }] }],
          generationConfig: { candidateCount: 1, maxOutputTokens: 8192, temperature: 0.2 },
        });
      },
    );

    it("excludes thought parts and joins only plain answer parts", async () => {
      const value = {
        modelVersion: "version",
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                { text: privateText, thought: true },
                { text: "hello", thoughtSignature: "signature" },
                { text: " world" },
              ],
            },
          },
        ],
      };
      expect(
        await createLlmClient(settings("google"), {
          apiKey: key,
          fetch: transport(value),
        }).generateText({ prompt: "test" }),
      ).toEqual({ text: "hello world", model: "version" });
    });

    it("ignores thought-only parts without requiring answer text on them", async () => {
      const value = {
        modelVersion: "version",
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [{ thought: true, thoughtSignature: "signature" }, { text: "answer" }],
            },
          },
        ],
      };
      expect(
        await createLlmClient(settings("google"), {
          apiKey: key,
          fetch: transport(value),
        }).generateText({ prompt: "test" }),
      ).toEqual({ text: "answer", model: "version" });
    });

    it.each([
      { promptFeedback: { blockReason: "SAFETY", blockReasonMessage: privateText } },
      { promptFeedback: { safetyRatings: [{ blocked: true }] } },
      { candidates: [] },
      { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "partial" }] } }] },
      { candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "partial" }] } }] },
      { candidates: [{ finishReason: "RECITATION", content: { parts: [{ text: "partial" }] } }] },
      { candidates: [{ content: { parts: [{ text: "partial" }] } }] },
      {
        candidates: [
          {
            finishReason: "STOP",
            safetyRatings: [{ blocked: true }],
            content: { parts: [{ text: "text" }] },
          },
        ],
      },
      {
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "text" }, { functionCall: { name: privateText } }] },
          },
        ],
      },
      {
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "text", inlineData: { data: privateText } }] },
          },
        ],
      },
      {
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: privateText, thought: true }] } },
        ],
      },
      { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "  " }] } }] },
      { modelVersion: "" },
      { error: { message: privateText } },
    ])("rejects blocked/safety/incomplete/tools/media responses %#", async (extra) => {
      await expect(
        createLlmClient(settings("google"), {
          apiKey: key,
          fetch: transport({ ...payload("google"), ...extra }),
        }).generateText({ prompt: privateText }),
      ).rejects.toThrow(/^Google response is invalid or incomplete$/);
    });

    it("retains optional/nullable values without OpenAI null stripping", async () => {
      const original = z.strictObject({
        omitted: z.string().optional(),
        keep: z.string().nullable().optional(),
      });
      const fetch = transport(payload("google", '{"keep":null}'));
      expect(
        (
          await createLlmClient(settings("google"), { apiKey: key, fetch }).generateObject({
            prompt: "test",
            schema: original,
          })
        ).object,
      ).toEqual({ keep: null });
      expect(body(fetch).generationConfig.responseJsonSchema.required).toBeUndefined();
      const invalid = transport(payload("google", '{"omitted":null,"keep":null}'));
      await expect(
        createLlmClient(settings("google"), { apiKey: key, fetch: invalid }).generateObject({
          prompt: "test",
          schema: original,
        }),
      ).rejects.toThrow(/schema validation/);
    });

    it("rejects an empty models/ prefix without HTTP", async () => {
      const fetch = transport(payload("google"));
      await expect(
        createLlmClient(settings("google", "models/"), { apiKey: key, fetch }).generateText({
          prompt: "test",
        }),
      ).rejects.toThrow(/^Google model is invalid$/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("supports record schemas and validates their original key constraints", async () => {
      const original = z.record(z.string().min(2), z.number().min(1));
      const fetch = transport(payload("google", '{"ok":2}'));
      expect(
        (
          await createLlmClient(settings("google"), { apiKey: key, fetch }).generateObject({
            prompt: "test",
            schema: original,
          })
        ).object,
      ).toEqual({ ok: 2 });
      expect(body(fetch).generationConfig.responseJsonSchema.additionalProperties).toEqual({
        type: "number",
        minimum: 1,
      });
      await expect(
        createLlmClient(settings("google"), {
          apiKey: key,
          fetch: transport(payload("google", '{"x":2}')),
        }).generateObject({ prompt: "test", schema: original }),
      ).rejects.toThrow(/schema validation/);
    });

    it("rejects multiple candidates rather than silently choosing one", async () => {
      const value = payload("google") as { candidates: unknown[] };
      value.candidates.push(value.candidates[0]);
      await expect(
        createLlmClient(settings("google"), { apiKey: key, fetch: transport(value) }).generateText({
          prompt: "test",
        }),
      ).rejects.toThrow(/invalid or incomplete/);
    });
  });

  describe.each(providers)("%s offline security/validation/cancellation", (provider) => {
    it("uses explicit injected credentials and no eager requests", () => {
      const fetch = transport(payload(provider));
      expect(() => createLlmClient(settings(provider), { fetch })).toThrow(/API key is required/);
      expect(() => createLlmClient(settings(provider), { apiKey: "  ", fetch })).toThrow(
        /API key is required/,
      );
      createLlmClient(
        {
          ...settings(provider),
          modelProfiles: { [provider]: { model: "profile-model", fastModel: "profile-fast" } },
        },
        { apiKey: key, fetch },
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it("keeps status-only HTTP errors when safe details are unavailable and never retries", async () => {
      const json = vi.fn().mockRejectedValue(new Error(privateText));
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue({ ok: false, status: 429, json } as unknown as Response);
      await expect(
        createLlmClient(settings(provider), { apiKey: key, fetch }).generateText({
          prompt: privateText,
        }),
      ).rejects.toThrow(
        new RegExp(
          `^${provider === "openai" ? "OpenAI" : provider === "google" ? "Google" : "Anthropic"} request failed \\(HTTP 429\\)$`,
        ),
      );
      expect(json).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("sanitizes arbitrary transport and body errors", async () => {
      for (const fetch of [
        vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(`${key} ${privateText}`)),
        vi.fn<typeof globalThis.fetch>().mockResolvedValue({
          ok: true,
          json: () => Promise.reject(new Error(`${key} ${privateText}`)),
        } as unknown as Response),
      ]) {
        const error = await createLlmClient(settings(provider), { apiKey: key, fetch })
          .generateText({ prompt: privateText })
          .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(key);
        expect(String(error)).not.toContain(privateText);
        expect((error as Error).cause).toBeUndefined();
      }
    });

    it("sanitizes conversion, JSON, request and original refinement errors", async () => {
      const label =
        provider === "openai" ? "OpenAI" : provider === "google" ? "Google" : "Anthropic";
      const fetch = transport(payload(provider, privateText));
      await expect(
        createLlmClient(settings(provider), { apiKey: key, fetch }).generateObject({
          prompt: privateText,
          schema,
        }),
      ).rejects.toThrow(`${label} structured response is not valid JSON`);
      const conversionFetch = transport(payload(provider));
      await expect(
        createLlmClient(settings(provider), { apiKey: key, fetch: conversionFetch }).generateObject(
          {
            prompt: privateText,
            schema: z.string().transform(() => privateText),
          },
        ),
      ).rejects.toThrow(`${label} structured output schema is unsupported`);
      expect(conversionFetch).not.toHaveBeenCalled();
      const refined = schema.refine(() => false, { message: `${privateText} ${key}` });
      await expect(
        createLlmClient(settings(provider), {
          apiKey: key,
          fetch: transport(payload(provider)),
        }).generateObject({ prompt: privateText, schema: refined }),
      ).rejects.toThrow(`${label} structured response failed schema validation`);
      const requestFetch = transport(payload(provider));
      await expect(
        createLlmClient(settings(provider), { apiKey: key, fetch: requestFetch }).generateText({
          prompt: "",
          tier: privateText as "fast",
        }),
      ).rejects.toThrow(`${label} request is invalid`);
      expect(requestFetch).not.toHaveBeenCalled();
    });

    it("preserves local bounds despite transport schema adaptation", async () => {
      const original = z.strictObject({
        value: z.string().min(3),
        count: z.number().int().min(1).max(3),
        rows: z.array(z.string()).min(2),
      });
      const fetch = transport(
        payload(provider, JSON.stringify({ value: "x", count: 4, rows: [] })),
      );
      await expect(
        createLlmClient(settings(provider), { apiKey: key, fetch }).generateObject({
          prompt: "test",
          schema: original,
        }),
      ).rejects.toThrow(/schema validation/);
    });

    it("redacts schema refinements that throw arbitrary exceptions", async () => {
      const original = schema.refine(() => {
        throw new Error(`${key} ${privateText}`);
      });
      const error = await createLlmClient(settings(provider), {
        apiKey: key,
        fetch: transport(payload(provider)),
      })
        .generateObject({ prompt: privateText, schema: original })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(key);
      expect(String(error)).not.toContain(privateText);
      expect((error as Error).cause).toBeUndefined();
    });

    it.each(["fetch", "body"] as const)(
      "aborts during signal-ignoring %s and removes listeners",
      async (stage) => {
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
          started = resolve;
        });
        const fetch = vi.fn<typeof globalThis.fetch>(async () => {
          if (stage === "fetch") {
            started();
            return new Promise<Response>(() => {});
          }
          return {
            ok: true,
            json: () => {
              started();
              return new Promise(() => {});
            },
          } as unknown as Response;
        });
        const controller = new AbortController();
        const add = vi.spyOn(controller.signal, "addEventListener");
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        const pending = createLlmClient(settings(provider), { apiKey: key, fetch }).generateObject({
          prompt: "test",
          schema,
          signal: controller.signal,
        });
        await ready;
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(add).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
        expect(fetch).toHaveBeenCalledTimes(1);
      },
    );

    it("aborts before HTTP and preserves caller cancellation reason", async () => {
      const fetch = transport(payload(provider));
      const controller = new AbortController();
      const reason = new Error("Caller cancellation");
      controller.abort(reason);
      const client = createLlmClient(settings(provider), { apiKey: key, fetch });
      await expect(
        client.generateObject({ prompt: "test", schema, signal: controller.signal }),
      ).rejects.toBe(reason);
      await expect(client.generateText({ prompt: "test", signal: controller.signal })).rejects.toBe(
        reason,
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it("does not read a late response after cancellation", async () => {
      let finish!: (response: Response) => void;
      const fetch = vi.fn<typeof globalThis.fetch>(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const controller = new AbortController();
      const pending = createLlmClient(settings(provider), { apiKey: key, fetch }).generateText({
        prompt: "test",
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      const json = vi.fn().mockResolvedValue(payload(provider));
      finish({ ok: true, json } as unknown as Response);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(json).not.toHaveBeenCalled();
    });

    it("handles late body rejection after cancellation without leaking transport errors", async () => {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let rejectBody!: (error: Error) => void;
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue({
        ok: true,
        json: () => {
          started();
          return new Promise((_, reject) => {
            rejectBody = reject;
          });
        },
      } as unknown as Response);
      const controller = new AbortController();
      const pending = createLlmClient(settings(provider), { apiKey: key, fetch }).generateText({
        prompt: privateText,
        signal: controller.signal,
      });
      await ready;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      rejectBody(new Error(`${key} ${privateText}`));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it.each([true, false])(
      "removes cancellation listeners after response success=%s",
      async (success) => {
        const fetch = transport(success ? payload(provider) : {});
        const controller = new AbortController();
        const add = vi.spyOn(controller.signal, "addEventListener");
        const remove = vi.spyOn(controller.signal, "removeEventListener");
        await createLlmClient(settings(provider), { apiKey: key, fetch })
          .generateText({ prompt: "test", signal: controller.signal })
          .catch(() => {});
        expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
        expect(fetch).toHaveBeenCalledTimes(1);
      },
    );
  });
});
