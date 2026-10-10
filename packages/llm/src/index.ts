import {
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

export interface LlmClientOptions {
  /** Supplied by the main process secret store, never read from the environment. */
  apiKey?: string;
  /** Injectable transport for recorded, offline HTTP tests. */
  fetch?: typeof globalThis.fetch;
}

const Request = z.object({
  prompt: z.string().min(1),
  system: z.string().optional(),
  tier: z.enum(["default", "fast"]).optional(),
});
const Message = z.object({
  model: z.string().min(1),
  stop_reason: z.literal("end_turn"),
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
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

/** Minimal REST clients. No retries, secret discovery, SDK, or live calls at construction. */
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

  async function post(
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
        throw new Error(`${label} transport failed`);
      }
      signal?.throwIfAborted();
      // Error bodies and transport exceptions can contain credentials or request text. Never echo them.
      if (!response.ok) throw new Error(`${label} request failed (HTTP ${response.status})`);
      try {
        return (await response.json()) as unknown;
      } catch {
        signal?.throwIfAborted();
        throw new Error(`${label} response is not valid JSON`);
      }
    }, signal);
  }

  async function message(request: LlmTextRequest, schema?: JsonSchema) {
    request.signal?.throwIfAborted();
    const checked = validate(Request, request, `${label} request is invalid`);
    const model = (checked.tier === "fast" ? config.fastModel : config.model).trim();
    if (!model) throw new Error(`${label} model is invalid`);
    if (provider === "openai") {
      const body = {
        model,
        store: false,
        input: checked.prompt,
        max_output_tokens: 8192,
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
          maxOutputTokens: 8192,
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
      const result = validate(GoogleResponse, raw, `${label} response is invalid or incomplete`);
      const text = result.candidates[0]!.content.parts.filter((part) => !part.thought)
        .map((part) => part.text)
        .join("");
      if (!text.trim()) throw new Error(`${label} response is invalid or incomplete`);
      request.signal?.throwIfAborted();
      return { text, model: result.modelVersion };
    }
    const body = {
      model,
      max_tokens: 8192,
      temperature: config.temperature,
      ...(checked.system !== undefined ? { system: checked.system } : {}),
      messages: [{ role: "user", content: checked.prompt }],
      ...(schema ? { output_config: { format: { type: "json_schema", schema } } } : {}),
    };
    const raw = await post(
      "https://api.anthropic.com/v1/messages",
      { "anthropic-version": "2023-06-01", "x-api-key": apiKey! },
      body,
      request.signal,
    );
    const result = validate(Message, raw, `${label} response is invalid or incomplete`);
    request.signal?.throwIfAborted();
    return { text: result.content.map((part) => part.text).join(""), model: result.model };
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
          jsonSchema = provider === "google" ? googleSchema(original) : anthropicSchema(original);
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
