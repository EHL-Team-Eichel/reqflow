import {
  AI_RETRIES,
  Settings,
  type LlmClient,
  type LlmTextRequest,
  type Settings as AppSettings,
} from "@reqflow/core";
import { z } from "zod";
import { anthropicSchema } from "./anthropic-schema";
import { googleSchema } from "./google-schema";
import { mockObject } from "./mock";
import { openaiSchema } from "./openai-schema";
import type { JsonSchema } from "./json-schema";
import { createMastraProvider, type MastraLlmClientOptions } from "./mastra";
import { isRetryableStatus, retryDelay, sleep } from "./http";

export interface LlmClientOptions {
  /** Supplied by the main process secret store, never read from the environment. */
  apiKey?: string;
  /** Injectable transport for recorded, offline HTTP tests. */
  fetch?: typeof globalThis.fetch;
  /** Injectable pause between retries, so tests don't wait for real back-off. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A failed call that can heal (network, timeout, rate limit, server error): worth another try. */
class RetryableCallError extends Error {
  constructor(
    message: string,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
  }
}

const Request = z.object({
  prompt: z.string().min(1),
  system: z.string().optional(),
  tier: z.enum(["default", "fast"]).optional(),
});

const AnthropicContentPart = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.looseObject({ type: z.string() }),
]);

const Message = z.object({
  model: z.string().min(1),
  stop_reason: z.literal("end_turn"),
  content: z.array(AnthropicContentPart).min(1),
});

const OpenAiResponse = z.object({
  model: z.string().min(1),
  status: z.literal("completed"),
  error: z.null().optional(),
  incomplete_details: z.null().optional(),
  output: z
    .array(
      z.union([
        z.object({ type: z.literal("reasoning"), status: z.literal("completed").optional() }),
        z.object({
          type: z.literal("message"),
          role: z.literal("assistant"),
          status: z.literal("completed"),
          content: z.array(z.object({ type: z.literal("output_text"), text: z.string() })).min(1),
        }),
      ]),
    )
    .min(1),
});

const SafetyRatings = z.array(z.object({ blocked: z.literal(false).optional() })).optional();
const GoogleResponse = z.object({
  modelVersion: z.string().min(1),
  error: z.null().optional(),
  promptFeedback: z
    .object({
      blockReason: z.literal("BLOCK_REASON_UNSPECIFIED").optional(),
      blockReasonMessage: z.literal("").optional(),
      safetyRatings: SafetyRatings,
    })
    .optional(),
  candidates: z
    .array(
      z.object({
        finishReason: z.literal("STOP"),
        safetyRatings: SafetyRatings,
        content: z.object({
          role: z.literal("model").optional(),
          parts: z
            .array(
              z
                .strictObject({
                  text: z.string().optional(),
                  thought: z.boolean().optional(),
                  thoughtSignature: z.string().optional(),
                })
                .refine((part) => part.thought === true || part.text !== undefined),
            )
            .min(1),
        }),
      }),
    )
    .length(1),
});

function validate<T>(schema: z.ZodType<T>, raw: unknown, error: string): T {
  try {
    return schema.parse(raw);
  } catch {
    throw new Error(error);
  }
}

/** Race even injected transports that ignore AbortSignal; always remove the listener. */
async function cancellable<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work();
  let listener: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    const value = await Promise.race([work(), aborted]);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

/** The answer the caller asked for (default 8,192 tokens). */
const DEFAULT_ANSWER_TOKENS = 8192;
/** Gemini 3.x and OpenAI reasoning models count their thinking against the output cap. */
const THINKING_HEADROOM = 16_384;
const MAX_OUTPUT_TOKENS = 65_536;

/**
 * Output cap for providers whose thinking shares the answer's budget. With a bare 8,192 a Gemini
 * call that thought for 7,864 tokens had 313 left and was cut off (MAX_TOKENS), failing a whole
 * AI Splitter run. The cap is a ceiling only; billing follows the tokens actually used.
 */
export function thinkingOutputCap(maxTokens?: number): number {
  const answer = maxTokens && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_ANSWER_TOKENS;
  return Math.min(MAX_OUTPUT_TOKENS, answer + THINKING_HEADROOM);
}

/**
 * Minimal REST clients. No secret discovery, SDK, or live calls at construction. A failed call is
 * retried up to AI_RETRIES times when it can heal (network, timeout, rate limit, server error).
 */
export function createLlmClient(
  settings: AppSettings["llm"],
  options: LlmClientOptions = {},
): LlmClient {
  const config = validate(Settings.shape.llm, settings, "Invalid LLM settings");
  if (config.provider === "mock") {
    return {
      async generateObject(request) {
        request.signal?.throwIfAborted();
        const checked = validate(Request, request, "Mock request is invalid");
        const object = validate(
          request.schema,
          mockObject(checked.prompt),
          "Mock structured response failed schema validation",
        );
        request.signal?.throwIfAborted();
        return { object, model: `mock:${checked.tier ?? "default"}` };
      },
      async generateText(request) {
        request.signal?.throwIfAborted();
        const checked = validate(Request, request, "Mock request is invalid");
        return {
          text: "[MOCK] Offline provider does not generate prose.",
          model: `mock:${checked.tier ?? "default"}`,
        };
      },
    };
  }

  const provider = config.provider;
  const label = provider === "openai" ? "OpenAI" : provider === "google" ? "Google" : "Anthropic";
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new Error(`${label} API key is required; supply it from the secret store.`);
  const fetch = options.fetch ?? globalThis.fetch;

  const pause = options.sleep ?? sleep;
  async function post(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal,
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await attemptPost(url, headers, body, signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof RetryableCallError) || attempt >= AI_RETRIES) {
          throw error instanceof RetryableCallError ? new Error(error.message) : error;
        }
        await pause(retryDelay(attempt, error.retryAfter), signal);
      }
    }
  }

  async function attemptPost(
    url: string,
    headers: Record<string, string>,
    body: unknown,
    signal?: AbortSignal,
  ) {
    return cancellable(async () => {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
          signal,
        });
      } catch {
        signal?.throwIfAborted();
        throw new RetryableCallError(`${label} transport failed`);
      }
      signal?.throwIfAborted();
      // Error bodies and transport exceptions can contain credentials or request text. Never echo them.
      if (!response.ok) {
        const message = `${label} request failed (HTTP ${response.status})`;
        if (isRetryableStatus(response.status))
          throw new RetryableCallError(message, response.headers?.get?.("retry-after") ?? null);
        throw new Error(message);
      }
      try {
        return (await response.json()) as unknown;
      } catch {
        signal?.throwIfAborted();
        throw new RetryableCallError(`${label} response is not valid JSON`);
      }
    }, signal);
  }

  async function message(request: LlmTextRequest, schema?: JsonSchema) {
    request.signal?.throwIfAborted();
    const checked = validate(Request, request, `${label} request is invalid`);
    const outputCap = thinkingOutputCap(request.maxTokens);
    const model = (checked.tier === "fast" ? config.fastModel : config.model).trim();
    if (!model) throw new Error(`${label} model is invalid`);
    if (provider === "openai") {
      const body = {
        model,
        store: false,
        input: checked.prompt,
        max_output_tokens: outputCap,
        // Reasoning model families reject temperature. Unknown custom IDs remain usable as supplied.
        ...(/^(?:ft:)?(?:gpt-[56](?:[.:-]|$)|o[134](?:[.:-]|$))/i.test(model)
          ? {}
          : { temperature: config.temperature }),
        ...(checked.system !== undefined ? { instructions: checked.system } : {}),
        ...(schema
          ? {
              text: {
                format: { type: "json_schema", name: "reqflow_result", strict: true, schema },
              },
            }
          : {}),
      };
      const raw = await post(
        "https://api.openai.com/v1/responses",
        { Authorization: `Bearer ${apiKey}` },
        body,
        request.signal,
      );
      const result = validate(OpenAiResponse, raw, `${label} response is invalid or incomplete`);
      const text = result.output
        .flatMap((item) => (item.type === "message" ? item.content.map((part) => part.text) : []))
        .join("");
      if (!text.trim()) throw new Error(`${label} response is invalid or incomplete`);
      request.signal?.throwIfAborted();
      return { text, model: result.model };
    }
    if (provider === "google") {
      const bareModel = model.replace(/^models\//, "");
      if (!bareModel) throw new Error(`${label} model is invalid`);
      const body = {
        contents: [{ role: "user", parts: [{ text: checked.prompt }] }],
        ...(checked.system !== undefined
          ? { systemInstruction: { parts: [{ text: checked.system }] } }
          : {}),
        generationConfig: {
          candidateCount: 1,
          maxOutputTokens: outputCap,
          temperature: config.temperature,
          ...(schema ? { responseMimeType: "application/json", responseJsonSchema: schema } : {}),
        },
      };
      const raw = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(bareModel)}:generateContent`,
        { "x-goog-api-key": apiKey! },
        body,
        request.signal,
      );
      const finish = (raw as { candidates?: { finishReason?: unknown }[] })?.candidates?.[0]
        ?.finishReason;
      if (finish === "MAX_TOKENS")
        throw new Error(`${label} answer was cut off at the output limit (MAX_TOKENS)`);
      const result = validate(GoogleResponse, raw, `${label} response is invalid or incomplete`);
      const text = result.candidates[0]!.content.parts.filter((part) => !part.thought)
        .map((part) => part.text)
        .join("");
      if (!text.trim()) throw new Error(`${label} response is invalid or incomplete`);
      request.signal?.throwIfAborted();
      return { text, model: result.modelVersion };
    }
    const isHaiku = model.includes("haiku");
    const outputConfig: Record<string, unknown> = {
      ...(schema ? { format: { type: "json_schema", schema } } : {}),
      ...(isHaiku ? {} : { effort: "low" }),
    };
    const body: Record<string, unknown> = {
      model,
      max_tokens: 8192,
      ...(isHaiku ? { temperature: config.temperature, thinking: { type: "disabled" } } : {}),
      ...(checked.system !== undefined
        ? { system: [{ type: "text", text: checked.system, cache_control: { type: "ephemeral" } }] }
        : {}),
      messages: [{ role: "user", content: checked.prompt }],
    };
    if (Object.keys(outputConfig).length > 0) {
      body.output_config = outputConfig;
    }
    const raw = await post(
      "https://api.anthropic.com/v1/messages",
      { "anthropic-version": "2023-06-01", "x-api-key": apiKey! },
      body,
      request.signal,
    );
    const result = validate(Message, raw, `${label} response is invalid or incomplete`);
    const text = result.content
      .flatMap((part) =>
        part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [],
      )
      .join("");
    if (!text.trim()) throw new Error(`${label} response is invalid or incomplete`);
    request.signal?.throwIfAborted();
    return { text, model: result.model };
  }

  return {
    async generateObject(request) {
      request.signal?.throwIfAborted();
      // Adapt transport constraints only; always validate the response with the original Zod schema.
      let jsonSchema: JsonSchema;
      let adapted: ReturnType<typeof openaiSchema> | undefined;
      try {
        const original = z.toJSONSchema(request.schema);
        if (provider === "openai") {
          adapted = openaiSchema(original);
          jsonSchema = adapted.schema;
        } else
          jsonSchema =
            provider === "google"
              ? googleSchema(original)
              : anthropicSchema(original as Record<string, unknown>);
      } catch {
        request.signal?.throwIfAborted();
        throw new Error(`${label} structured output schema is unsupported`);
      }
      const result = await message(request, jsonSchema);
      request.signal?.throwIfAborted();
      let raw: unknown;
      try {
        raw = JSON.parse(result.text);
      } catch {
        throw new Error(`${label} structured response is not valid JSON`);
      }
      try {
        let attempts = 0;
        for (const value of adapted ? adapted.values(raw) : [raw]) {
          // Bound ambiguous union normalization; never make an unbounded product of candidate values.
          if (++attempts > 128) break;
          const parsed = request.schema.safeParse(value);
          if (parsed.success) {
            request.signal?.throwIfAborted();
            return { object: parsed.data, model: result.model };
          }
        }
      } catch {
        request.signal?.throwIfAborted();
        throw new Error(`${label} structured response failed schema validation`);
      }
      request.signal?.throwIfAborted();
      throw new Error(`${label} structured response failed schema validation`);
    },
    generateText: (request) => message(request),
  };
}

/** Stateless standalone Mastra provider. Construction validates config but makes no model calls. */
export function createMastraLlmClient(
  settings: AppSettings["llm"],
  options: MastraLlmClientOptions = {},
): LlmClient {
  const config = Settings.shape.llm.parse(settings);
  return config.provider !== "anthropic"
    ? createLlmClient(config, options)
    : createMastraProvider(config, options);
}
