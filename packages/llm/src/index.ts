import {
  Settings,
  type LlmClient,
  type LlmTextRequest,
  type Settings as AppSettings,
} from "@reqflow/core";
import { z } from "zod";
import { anthropicSchema } from "./anthropic-schema";
import { mockObject } from "./mock";

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

/** Minimal Messages API client. No retries, secret discovery, SDK, or live calls at construction. */
export function createLlmClient(
  settings: AppSettings["llm"],
  options: LlmClientOptions = {},
): LlmClient {
  const config = Settings.shape.llm.parse(settings);
  if (config.provider === "mock") {
    return {
      async generateObject(request) {
        request.signal?.throwIfAborted();
        const checked = Request.parse(request);
        const object = request.schema.parse(mockObject(checked.prompt));
        request.signal?.throwIfAborted();
        return { object, model: `mock:${checked.tier ?? "default"}` };
      },
      async generateText(request) {
        request.signal?.throwIfAborted();
        const checked = Request.parse(request);
        return {
          text: "[MOCK] Offline provider does not generate prose.",
          model: `mock:${checked.tier ?? "default"}`,
        };
      },
    };
  }

  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new Error("Anthropic API key is required; supply it from the secret store.");
  const fetch = options.fetch ?? globalThis.fetch;

  async function message(request: LlmTextRequest, schema?: Record<string, unknown>) {
    request.signal?.throwIfAborted();
    const checked = Request.parse(request);
    const body = {
      model: checked.tier === "fast" ? config.fastModel : config.model,
      max_tokens: 8192,
      temperature: config.temperature,
      ...(checked.system !== undefined ? { system: checked.system } : {}),
      messages: [{ role: "user", content: checked.prompt }],
      ...(schema ? { output_config: { format: { type: "json_schema", schema } } } : {}),
    };
    const result = await cancellable(async () => {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey!,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
      // Error bodies can contain secrets or request text. Do not include them in errors/logs.
      if (!response.ok) throw new Error(`Anthropic request failed (HTTP ${response.status})`);
      return Message.parse(await response.json());
    }, request.signal);
    return { text: result.content.map((part) => part.text).join(""), model: result.model };
  }

  return {
    async generateObject(request) {
      request.signal?.throwIfAborted();
      // Adapt transport constraints only; always validate the response with the original Zod schema.
      const jsonSchema = anthropicSchema(z.toJSONSchema(request.schema));
      const result = await message(request, jsonSchema);
      let raw: unknown;
      try {
        raw = JSON.parse(result.text);
      } catch {
        throw new Error("Anthropic structured response is not valid JSON");
      }
      const object = request.schema.parse(raw);
      request.signal?.throwIfAborted();
      return { object, model: result.model };
    },
    generateText: (request) => message(request),
  };
}
