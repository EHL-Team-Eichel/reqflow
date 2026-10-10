import { Settings, type LlmClient, type Settings as AppSettings } from "@reqflow/core";
import { mockObject } from "./mock";
import { anthropicClient } from "./anthropic";
import { Request } from "./client-request";
import { createMastraProvider, type MastraLlmClientOptions } from "./mastra";

export interface LlmClientOptions {
  /** Supplied by the main process secret store, never read from the environment. */
  apiKey?: string;
  /** Injectable transport for recorded, offline HTTP tests. */
  fetch?: typeof globalThis.fetch;
}

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

/** Stateless standalone Mastra provider. Construction validates config but makes no model calls. */
export function createMastraLlmClient(
  settings: AppSettings["llm"],
  options: MastraLlmClientOptions = {},
): LlmClient {
  const config = Settings.shape.llm.parse(settings);
  return config.provider === "mock"
    ? createLlmClient(config, options)
    : createMastraProvider(config, options);
}
