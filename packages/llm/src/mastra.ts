import { Agent } from "@mastra/core/agent";
import { noopLogger, type IMastraLogger } from "@mastra/core/logger";
import type { LlmClient, LlmTextRequest, Settings } from "@reqflow/core";
import { z } from "zod";
import { cancellable, Request } from "./client-request";
import type { LlmClientOptions } from "./default-client";

/** Small request seam for offline tests; it does not expose tools, storage, or credentials discovery. */
export interface MastraAgentConfig {
  id: string;
  name: string;
  instructions: string;
  model: { providerId: "anthropic"; modelId: string; apiKey: string };
  maxRetries: 0;
  errorProcessorDefaults: false;
}

export interface MastraGenerateOptions {
  abortSignal?: AbortSignal;
  maxSteps: 1;
  modelSettings: { temperature: number; maxOutputTokens: number; maxRetries: 0 };
  structuredOutput?: {
    schema: z.ZodType<unknown>;
    errorStrategy: "strict";
    logger: IMastraLogger;
  };
}

export interface MastraGenerateResult {
  object?: unknown;
  text?: string;
  finishReason?: string;
  response?: { modelId?: string };
  error?: unknown;
  usedFallbackValue?: boolean;
}

export interface MastraAgent {
  generate(prompt: string, options: MastraGenerateOptions): Promise<MastraGenerateResult>;
}

export type MastraAgentFactory = (config: MastraAgentConfig) => MastraAgent;

export interface MastraLlmClientOptions extends LlmClientOptions {
  /** Replaces only Agent construction/generation; production uses the standalone Mastra Agent. */
  createAgent?: MastraAgentFactory;
}

const createAgent: MastraAgentFactory = (config) => {
  // Do not attach a Mastra instance: no tracing, memory, storage, tools, or source logging.
  const agent = new Agent(config);
  agent.__setLogger(noopLogger);
  return {
    generate: (prompt, options) =>
      options.structuredOutput
        ? agent.generate(prompt, { ...options, structuredOutput: options.structuredOutput })
        : agent.generate(prompt, { ...options, structuredOutput: undefined }),
  };
};

/** Provider errors can contain request bodies and credentials; expose only a numeric HTTP status. */
function providerError(error: unknown): Error {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const { statusCode, cause } = current as { statusCode?: unknown; cause?: unknown };
    if (
      typeof statusCode === "number" &&
      Number.isInteger(statusCode) &&
      statusCode >= 400 &&
      statusCode <= 599
    ) {
      return new Error(`Mastra Anthropic request failed (HTTP ${statusCode})`);
    }
    current = cause;
  }
  return new Error(
    "Mastra Anthropic generation failed; check model configuration, connectivity, or provider response.",
  );
}

/** Internal Anthropic provider; the public factory validates settings and reuses the existing mock. */
export function createMastraProvider(
  config: Settings["llm"],
  options: MastraLlmClientOptions,
): LlmClient {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) throw new Error("Anthropic API key is required; supply it from the secret store.");
  // Mastra's model router has no fetch option. Never silently ignore a caller's test transport.
  if (options.fetch && !options.createAgent) {
    throw new Error(
      "Inject createAgent for offline Mastra tests; use createLlmClient for fetch overrides.",
    );
  }
  const factory = options.createAgent ?? createAgent;

  async function generate(request: LlmTextRequest, schema?: z.ZodType<unknown>) {
    request.signal?.throwIfAborted();
    const checked = Request.parse(request);
    let result: MastraGenerateResult;
    try {
      result = await cancellable(() => {
        const agent = factory({
          id: "reqflow-llm",
          name: "ReqFlow LLM",
          instructions: checked.system ?? "",
          model: {
            providerId: "anthropic",
            modelId: checked.tier === "fast" ? config.fastModel : config.model,
            apiKey: apiKey!,
          },
          maxRetries: 0,
          // Mastra stability processors otherwise retry independently of model maxRetries.
          errorProcessorDefaults: false,
        });
        return agent.generate(checked.prompt, {
          abortSignal: request.signal,
          maxSteps: 1,
          modelSettings: { temperature: config.temperature, maxOutputTokens: 8192, maxRetries: 0 },
          ...(schema
            ? { structuredOutput: { schema, errorStrategy: "strict" as const, logger: noopLogger } }
            : {}),
        });
      }, request.signal);
      if (result.error) throw result.error;
    } catch (error) {
      request.signal?.throwIfAborted();
      throw providerError(error);
    }
    if (result.finishReason !== "stop" || result.usedFallbackValue) {
      throw new Error(
        "Mastra Anthropic response is incomplete, refused, or substituted; no output was accepted.",
      );
    }
    const model = z.string().min(1).parse(result.response?.modelId);
    return { result, model };
  }

  return {
    async generateObject(request) {
      const { result, model } = await generate(request, request.schema);
      if (result.object === undefined)
        throw new Error("Mastra Anthropic structured response is missing its object.");
      // Mastra validation is not a substitute for the caller's original Zod refinements.
      const object = request.schema.parse(result.object);
      request.signal?.throwIfAborted();
      return { object, model };
    },
    async generateText(request) {
      const { result, model } = await generate(request);
      const text = z.string().min(1).parse(result.text);
      request.signal?.throwIfAborted();
      return { text, model };
    },
  };
}
