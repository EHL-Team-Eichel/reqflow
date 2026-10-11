import {
  AGENT_ROLE_INFO,
  API_PROVIDER_INFO,
  DEFAULT_SETUP,
  type AgentModel,
  type AgentServices,
  type ApiSetup,
  type LlmClient,
  type ReasoningEffort,
  type Settings,
  type WriterRole,
} from "@reqflow/core";
import type { SetupTestResult } from "@reqflow/core/ipc";
import {
  createJudgeClient,
  createLlmClient,
  createSetupClient,
  Limiter,
  llmDecisionClient,
} from "@reqflow/llm";

export interface AgentDeps {
  /** The default AI (Settings → AI) with its key; throws a readable error when it can't be used. */
  defaultLlm: (settings: Settings) => Promise<LlmClient>;
  /** The stored key of an API setup (`setup:<id>` in the OS keychain), or null. */
  getKey: (setupId: string) => Promise<string | null>;
  fetch?: typeof fetch;
}

/** The default AI has no effort setting of its own: writing roles think at this level. */
const DEFAULT_AI_EFFORT: ReasoningEffort = "medium";
const DEFAULT_AI_PARALLEL = 4;

/**
 * The default AI as the agents call it: straight to the provider's API, so adaptive thinking and
 * effort apply (blocks may wrap the same settings differently, e.g. in a Mastra Agent).
 */
export function directDefaultLlm(
  settings: Settings,
  apiKey: string | undefined,
  fetch?: typeof globalThis.fetch,
): LlmClient {
  if (settings.llm.provider === "mock") return createLlmClient(settings.llm);
  return createSetupClient(
    {
      id: "default-ai",
      name: "Default AI",
      baseUrl: "",
      provider: settings.llm.provider === "google" ? "gemini" : settings.llm.provider,
      model: settings.llm.model,
      fastModel: settings.llm.fastModel,
      temperature: settings.llm.temperature,
      effort: DEFAULT_AI_EFFORT,
      maxParallel: DEFAULT_AI_PARALLEL,
    },
    { apiKey, fetch },
  );
}

function defaultInfo(settings: Settings): AgentModel {
  return {
    setupId: DEFAULT_SETUP,
    setupName: "Default AI",
    provider: settings.llm.provider === "google" ? "gemini" : settings.llm.provider,
    model: settings.llm.model,
    fastModel: settings.llm.fastModel,
    maxParallel: DEFAULT_AI_PARALLEL,
  };
}

function setupInfo(s: ApiSetup): AgentModel {
  return {
    setupId: s.id,
    setupName: s.name,
    provider: s.provider,
    model: s.model,
    fastModel: s.fastModel || s.model,
    maxParallel: s.maxParallel,
  };
}

/** Requests that name no effort get this one (the agents ask for less where speed matters). */
function withEffort(llm: LlmClient, effort: ReasoningEffort): LlmClient {
  return {
    generateObject: (r) => llm.generateObject({ ...r, effort: r.effort ?? effort }),
    generateText: (r) => llm.generateText({ ...r, effort: r.effort ?? effort }),
  };
}

/**
 * Resolves every agent role to its API setup (Settings → AI → Agents) for one block run.
 * Roles that share a setup share one limiter, so its "parallel calls" setting holds overall.
 */
export function createAgentServices(settings: Settings, deps: AgentDeps): AgentServices {
  const limiters = new Map<string, Limiter>();
  const limiterOf = (s: ApiSetup) => {
    let l = limiters.get(s.id);
    if (!l) limiters.set(s.id, (l = new Limiter(s.maxParallel)));
    return l;
  };
  const setupOf = (id: string) => {
    const s = settings.agents.setups.find((x) => x.id === id);
    if (!s)
      throw new Error(
        `The API setup "${id}" no longer exists. Pick another one in Settings → AI → Agents.`,
      );
    return s;
  };
  const keyOf = async (s: ApiSetup) => {
    const key = (await deps.getKey(s.id)) ?? undefined;
    if (API_PROVIDER_INFO[s.provider].needsKey && !key) {
      throw new Error(`API setup "${s.name}" has no API key. Add it in Settings → AI.`);
    }
    return key;
  };
  return {
    async writer(role: WriterRole) {
      const id = settings.agents.roles[role];
      if (id === DEFAULT_SETUP) {
        return {
          info: defaultInfo(settings),
          llm: withEffort(await deps.defaultLlm(settings), DEFAULT_AI_EFFORT),
        };
      }
      const s = setupOf(id);
      if (!API_PROVIDER_INFO[s.provider].writes) {
        throw new Error(
          `"${s.name}" (${API_PROVIDER_INFO[s.provider].label}) can only be the judge. Pick another setup for the ${AGENT_ROLE_INFO[role].label.toLowerCase()} in Settings → AI.`,
        );
      }
      const llm = createSetupClient(s, {
        apiKey: await keyOf(s),
        fetch: deps.fetch,
        limiter: limiterOf(s),
      });
      return { info: setupInfo(s), llm };
    },
    async judge() {
      const id = settings.agents.roles.judge;
      if (id === DEFAULT_SETUP) {
        return {
          info: defaultInfo(settings),
          decisions: llmDecisionClient(await deps.defaultLlm(settings)),
        };
      }
      const s = setupOf(id);
      return {
        info: setupInfo(s),
        decisions: createJudgeClient(s, {
          apiKey: await keyOf(s),
          fetch: deps.fetch,
          limiter: limiterOf(s),
        }),
      };
    },
  };
}

/**
 * One tiny request through a setup ("Test" in Settings → AI). Never throws: the result says what
 * went wrong in words safe to show (provider errors never carry keys or response bodies).
 */
export async function testSetup(
  settings: Settings,
  setupId: string,
  deps: AgentDeps,
): Promise<SetupTestResult> {
  const started = Date.now();
  const ms = () => Date.now() - started;
  const signal = AbortSignal.timeout(60_000);
  try {
    if (setupId === DEFAULT_SETUP) {
      const res = await (
        await deps.defaultLlm(settings)
      ).generateText({
        prompt: "Reply with the single word OK.",
        maxTokens: 200,
        signal,
      });
      return {
        ok: true,
        model: res.model,
        ms: ms(),
        message: `Connected: ${res.model} answered in ${ms()} ms.`,
      };
    }
    const s = settings.agents.setups.find((x) => x.id === setupId);
    if (!s)
      return {
        ok: false,
        ms: 0,
        message: "This API setup isn't saved yet. Try again in a moment.",
      };
    if (s.provider === "mock") {
      return {
        ok: true,
        model: "offline",
        ms: 0,
        message: "Mock runs offline: nothing to connect to.",
      };
    }
    const apiKey = (await deps.getKey(s.id)) ?? undefined;
    if (s.provider === "jev") {
      const res = await createJudgeClient(s, { apiKey, fetch: deps.fetch }).decide({
        state: "The car has four doors and a large boot.",
        questions: { check: { type: "noul", instructions: "The text describes a car." } },
        signal,
      });
      return {
        ok: true,
        model: res.model,
        ms: ms(),
        message: `Connected: ${res.model} answered in ${ms()} ms.`,
      };
    }
    const res = await createSetupClient(s, { apiKey, fetch: deps.fetch }).generateText({
      prompt: "Reply with the single word OK.",
      maxTokens: 200,
      signal,
    });
    return {
      ok: true,
      model: res.model,
      ms: ms(),
      message: `Connected: ${res.model} answered in ${ms()} ms.`,
    };
  } catch (err) {
    const timedOut = signal.aborted;
    return {
      ok: false,
      ms: ms(),
      message: timedOut
        ? "No answer within 60 s."
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}
