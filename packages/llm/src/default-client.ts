import { Settings, type LlmClient, type Settings as AppSettings } from "@reqflow/core";
import { z } from "zod";
import { mockObject } from "./mock";
import { anthropicClient } from "./anthropic";

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

/**
 * The default AI (Settings → AI): Anthropic or the AI Splitter's offline mock. No secret discovery
 * and no live call at construction; the key comes from the main process secret store.
 */
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

  return anthropicClient({
    baseUrl: "https://api.anthropic.com",
    apiKey,
    model: config.model,
    fastModel: config.fastModel,
    effort: "off",
    temperature: config.temperature,
    fetch: options.fetch,
  });
}
