import { DEFAULT_SETTINGS, LLM_MODEL_DEFAULTS, type LiveLlmProvider } from "@reqflow/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLlmClient } from "./index";

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
    const value = payload("openai", "first") as ReturnType<typeof payload> & { output: unknown[] };
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
      createLlmClient(settings("openai"), { apiKey: key, fetch: transport(value) }).generateObject({
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
    const result = await createLlmClient(settings("openai"), { apiKey: key, fetch }).generateObject(
      { prompt: "test", schema: original },
    );
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

  it("sanitizes HTTP errors and never reads their body or retries", async () => {
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
    const label = provider === "openai" ? "OpenAI" : provider === "google" ? "Google" : "Anthropic";
    const fetch = transport(payload(provider, privateText));
    await expect(
      createLlmClient(settings(provider), { apiKey: key, fetch }).generateObject({
        prompt: privateText,
        schema,
      }),
    ).rejects.toThrow(`${label} structured response is not valid JSON`);
    const conversionFetch = transport(payload(provider));
    await expect(
      createLlmClient(settings(provider), { apiKey: key, fetch: conversionFetch }).generateObject({
        prompt: privateText,
        schema: z.string().transform(() => privateText),
      }),
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
    const fetch = transport(payload(provider, JSON.stringify({ value: "x", count: 4, rows: [] })));
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
