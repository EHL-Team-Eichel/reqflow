import {
  API_PROVIDER_INFO,
  type ApiSetup,
  type DecisionClient,
  type LlmClient,
} from "@reqflow/core";
import { anthropicClient } from "./anthropic";
import { openAiClient } from "./openai";
import { jevClient } from "./jev";
import { llmDecisionClient } from "./decisions";
import { Limiter } from "./http";
import { createLlmClient } from "./default-client";

export function createSetupClient(
  setup: ApiSetup,
  o: { apiKey?: string; fetch?: typeof fetch; limiter?: Limiter },
): LlmClient {
  const info = API_PROVIDER_INFO[setup.provider as keyof typeof API_PROVIDER_INFO];

  if (setup.provider === "jev") {
    throw new Error(`"${setup.name}" (TypeSafe Jev) can only be the judge.`);
  }

  if (info.needsKey && !o.apiKey) {
    throw new Error(`API setup "${setup.name}" has no API key. Add it in Settings → AI.`);
  }

  const limiter = o.limiter ?? new Limiter(setup.maxParallel);
  const baseUrl = setup.baseUrl || info.baseUrl;

  if (setup.provider === "anthropic") {
    return anthropicClient({
      baseUrl,
      apiKey: o.apiKey!,
      model: setup.model,
      fastModel: setup.fastModel,
      effort: setup.effort,
      temperature: setup.temperature,
      fetch: o.fetch,
      limiter,
    });
  }

  if (
    setup.provider === "openai" ||
    setup.provider === "gemini" ||
    setup.provider === "openai_compatible"
  ) {
    return openAiClient({
      provider: setup.provider,
      baseUrl,
      apiKey: o.apiKey,
      model: setup.model,
      fastModel: setup.fastModel,
      effort: setup.effort,
      temperature: setup.temperature,
      fetch: o.fetch,
      limiter,
    });
  }

  if (setup.provider === "mock") {
    return createLlmClient(
      {
        provider: "mock",
        model: setup.model,
        fastModel: setup.fastModel,
        temperature: setup.temperature,
        outputLanguage: "en",
      },
      { fetch: o.fetch },
    );
  }

  throw new Error(`Unknown provider: ${setup.provider}`);
}

export function createJudgeClient(
  setup: ApiSetup,
  o: { apiKey?: string; fetch?: typeof fetch; limiter?: Limiter },
): DecisionClient {
  const info = API_PROVIDER_INFO[setup.provider as keyof typeof API_PROVIDER_INFO];

  if (info.needsKey && !o.apiKey) {
    throw new Error(`API setup "${setup.name}" has no API key. Add it in Settings → AI.`);
  }

  const limiter = o.limiter ?? new Limiter(setup.maxParallel);

  if (setup.provider === "jev") {
    return jevClient({
      baseUrl: setup.baseUrl || info.baseUrl,
      apiKey: o.apiKey!,
      model: setup.model || "jev-latest",
      fetch: o.fetch,
      limiter,
    });
  }

  const llm = createSetupClient(setup, { ...o, limiter });
  return llmDecisionClient(llm, { tier: "fast", effort: "low" });
}
