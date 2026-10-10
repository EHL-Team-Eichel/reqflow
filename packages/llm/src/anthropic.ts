import type {
  LlmClient,
  LlmObjectRequest,
  LlmTextRequest,
  LlmUsage,
  ReasoningEffort,
} from "@reqflow/core";
import { z } from "zod";
import { anthropicSchema } from "./anthropic-schema";
import { Limiter, postJson } from "./http";

/** Thinking headroom on top of the answer: `max_tokens` caps thinking and answer together. */
const HEADROOM: Record<ReasoningEffort, number> = { off: 0, low: 8000, medium: 16000, high: 32000 };
const TIMEOUT_MS: Record<ReasoningEffort, number> = {
  off: 120_000,
  low: 120_000,
  medium: 300_000,
  high: 600_000,
};
const MAX_THINKING_CHARS = 4000;

const Block = z.looseObject({ type: z.string() });
const Response = z.object({
  model: z.string().min(1),
  stop_reason: z.string().nullable(),
  content: z.array(Block),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      cache_creation_input_tokens: z.number().nullish(),
      cache_read_input_tokens: z.number().nullish(),
    })
    .optional(),
});

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fastModel: string;
  effort: ReasoningEffort;
  temperature: number;
  fetch?: typeof fetch;
  limiter?: Limiter;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Claude Messages API. Claude 5.x models think adaptively: `effort` sets how hard, and only Haiku
 * can switch thinking off. While thinking is on, sampling parameters (temperature, top_p) are
 * rejected, so they are only sent with thinking disabled. Only `end_turn` is a complete answer.
 */
export function anthropicClient(o: AnthropicOptions): LlmClient {
  const limiter = o.limiter ?? new Limiter(4);
  const url = `${o.baseUrl.replace(/\/+$/, "")}/v1/messages`;

  async function call(
    request: LlmTextRequest & { schema?: z.ZodType },
  ): Promise<{ text: string; model: string; usage: LlmUsage; thinking?: string }> {
    const model = request.tier === "fast" ? o.fastModel || o.model : o.model;
    const effort = request.effort ?? o.effort;
    const body: Record<string, unknown> = {
      model,
      max_tokens: Math.min(64_000, (request.maxTokens ?? 4096) + HEADROOM[effort]),
      messages: [{ role: "user", content: request.prompt }],
    };
    if (request.system) {
      body.system = [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }];
    }
    const outputConfig: Record<string, unknown> = {};
    if (effort === "off" && /haiku/i.test(model)) {
      body.thinking = { type: "disabled" };
      body.temperature = o.temperature;
    } else if (effort === "off") {
      outputConfig.effort = "low"; // Opus and Sonnet can't switch thinking off
    } else {
      body.thinking = { type: "adaptive", display: "summarized" };
      outputConfig.effort = effort;
    }
    if (request.schema) {
      outputConfig.format = {
        type: "json_schema",
        schema: anthropicSchema(z.toJSONSchema(request.schema) as Record<string, unknown>),
      };
    }
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;

    return limiter.run(async () => {
      const res = await postJson(url, {
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": o.apiKey,
        },
        body,
        signal: request.signal,
        fetch: o.fetch ?? fetch,
        timeoutMs: o.timeoutMs ?? TIMEOUT_MS[effort],
        provider: "Anthropic",
        sleep: o.sleep,
      });
      const parsed = Response.safeParse(res.json);
      if (!parsed.success) throw new Error("Anthropic sent an answer in an unexpected format.");
      const data = parsed.data;
      if (
        data.stop_reason === "max_tokens" ||
        data.stop_reason === "model_context_window_exceeded"
      ) {
        throw new Error(
          "Claude stopped before finishing its answer (max_tokens). Lower the effort or send fewer items per call.",
        );
      }
      if (data.stop_reason === "refusal") throw new Error("Claude declined to answer (refusal).");
      if (data.stop_reason !== "end_turn") {
        throw new Error(`Claude stopped early (${data.stop_reason ?? "no stop reason"}).`);
      }
      const text = data.content
        .flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : []))
        .join("");
      if (!text.trim()) throw new Error("Claude returned no answer text.");
      const thinking = data.content
        .flatMap((b) =>
          b.type === "thinking" && typeof b.thinking === "string" ? [b.thinking] : [],
        )
        .join("\n\n")
        .trim()
        .slice(0, MAX_THINKING_CHARS);
      const u = data.usage ?? {};
      return {
        text,
        model: data.model,
        usage: {
          inputTokens:
            (u.input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
        },
        ...(thinking ? { thinking } : {}),
      };
    }, request.signal);
  }

  return {
    async generateObject<T>(request: LlmObjectRequest<T>) {
      const result = await call(request);
      let raw: unknown;
      try {
        raw = JSON.parse(result.text);
      } catch {
        throw new Error("Claude's answer is not valid JSON.");
      }
      return {
        object: request.schema.parse(raw),
        model: result.model,
        usage: result.usage,
        ...(result.thinking ? { thinking: result.thinking } : {}),
      };
    },
    async generateText(request) {
      return call(request);
    },
  };
}
