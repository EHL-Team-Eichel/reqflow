import {
  LLM_MODEL_DEFAULTS,
  LLM_SECRET_NAMES,
  LlmModels,
  SECRET_NAMES,
  type LiveLlmProvider,
  type LlmProvider,
  type ReqflowApi,
  type SecretStatus,
  type SecretName,
  type SecretState,
  type Settings,
} from "@reqflow/core";
import { nonEmptySecretDraft, settingsErrorMessage } from "./ResearchApisSection.helpers";

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  mock: "Mock (offline demo)",
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
  google: "Google Gemini",
};
export const LLM_PROVIDER_OPTIONS = (["mock", "anthropic", "openai", "google"] as const).map(
  (value) => ({ value, label: LLM_PROVIDER_LABELS[value] }),
);

/** Presets come from the shared contract, not an inferred account model catalogue. */
export function modelPresets(provider: LlmProvider) {
  if (provider === "mock") return [];
  const defaults = LLM_MODEL_DEFAULTS[provider];
  return [
    { value: defaults.model, label: `${defaults.model} (quality default)` },
    { value: defaults.fastModel, label: `${defaults.fastModel} (fast default)` },
  ];
}

/** Reject obvious vendor mismatches; unfamiliar private/custom IDs remain usable. */
export function modelValidationError(provider: LlmProvider, input: string): string | null {
  const parsed = LlmModels.shape.model.safeParse(input);
  if (!parsed.success) return "Enter a model ID with 1–200 characters.";
  const model = parsed.data;
  if (/\s/.test(model)) return "Model IDs cannot contain whitespace.";
  const knownProvider: LiveLlmProvider | null = /^claude-/i.test(model)
    ? "anthropic"
    : /^(?:ft:)?(?:gpt-|chatgpt-|o\d(?:[.:-]|$))/i.test(model)
      ? "openai"
      : /^(?:models\/)?gemini-/i.test(model)
        ? "google"
        : null;
  if (provider !== "mock" && knownProvider && knownProvider !== provider) {
    return "This model belongs to another provider. Choose a matching model or change the AI provider.";
  }
  return null;
}

/** Canonical runtime fields win over an older active profile, including pre-profile settings. */
export function switchLlmProvider(
  current: Settings["llm"],
  provider: LlmProvider,
): Settings["llm"] {
  if (current.provider === provider) return current;
  const profiles = { ...current.modelProfiles };
  if (current.provider !== "mock") {
    const outgoing = LlmModels.safeParse({ model: current.model, fastModel: current.fastModel });
    if (!outgoing.success)
      throw new Error("Current model IDs must have 1–200 characters before switching providers.");
    profiles[current.provider] = outgoing.data;
  }
  let models = { model: current.model, fastModel: current.fastModel };
  if (provider !== "mock") {
    const saved = LlmModels.safeParse(profiles[provider]);
    models =
      saved.success &&
      !modelValidationError(provider, saved.data.model) &&
      !modelValidationError(provider, saved.data.fastModel)
        ? saved.data
        : LLM_MODEL_DEFAULTS[provider];
  }
  return {
    ...current,
    provider,
    ...models,
    ...(Object.keys(profiles).length ? { modelProfiles: profiles } : {}),
  };
}

/** Presentation only: main owns request parameters and enforces model restrictions. */
export function temperatureHelp(llm: Settings["llm"]): string {
  if (llm.provider === "mock")
    return "Mock is offline. Models and temperature are not used for paid calls.";
  if (
    llm.provider === "openai" &&
    [llm.model, llm.fastModel].some((model) =>
      /^(?:ft:)?(?:gpt-[56](?:[.:-]|$)|o[134](?:[.:-]|$))/i.test(model.trim()),
    )
  ) {
    return "The OpenAI adapter omits temperature for GPT-5/GPT-6 and o1/o3/o4 reasoning models. The saved value still applies to other models; it does not control reasoning effort.";
  }
  return "Temperature support depends on the provider and model. Custom model restrictions and account access are checked during an explicit run; choosing a model does not test it.";
}

interface AiCredentialsSnapshot {
  provider: LlmProvider;
  secrets: SecretStatus | null;
  draft: string;
  pending: string | null;
  error: string | null;
  notice: string | null;
}
type AiCredentialsClient = { settings: Pick<ReqflowApi["settings"], "secrets" | "setSecret"> };

/** Copy only boolean/source fields. Never retain extra values from an IPC response. */
function secretStatuses(input: SecretStatus): SecretStatus {
  if (!input || typeof input !== "object") throw new Error("Invalid credential status");
  const fixed = Object.fromEntries(
    SECRET_NAMES.map((name) => {
      const status = input[name];
      if (
        !status ||
        typeof status.configured !== "boolean" ||
        (status.source !== null && status.source !== "env" && status.source !== "keychain")
      ) {
        throw new Error("Invalid credential status");
      }
      return [name, { configured: status.configured, source: status.source }];
    }),
  ) as Record<SecretName, SecretState>;
  const setups = Object.fromEntries(
    Object.entries(input.setups ?? {}).map(([id, status]) => {
      if (
        typeof status.configured !== "boolean" ||
        (status.source !== null && status.source !== "keychain" && status.source !== "env")
      )
        throw new Error("Invalid credential status");
      return [id, { configured: status.configured, source: status.source }];
    }),
  );
  return { ...fixed, ...(input.setups ? { setups } : {}) };
}

/** Independent from settings autosave. Switching/unmounting invalidates all UI replies, not IPC writes. */
export function createAiCredentialsController(client: AiCredentialsClient, provider: LlmProvider) {
  let snapshot: AiCredentialsSnapshot = {
    provider,
    secrets: null,
    draft: "",
    pending: null,
    error: null,
    notice: null,
  };
  let active = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  const current = (token: number) => active && token === generation;
  const publish = (patch: Partial<AiCredentialsSnapshot>, token = generation) => {
    if (!current(token)) return;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const readStatuses = async (token: number) => {
    const input = await client.settings.secrets();
    if (current(token)) publish({ secrets: secretStatuses(input) }, token);
  };
  const run = async (pending: string, work: (token: number) => Promise<void>) => {
    if (!active || snapshot.pending) return;
    const token = ++generation;
    publish({ pending, error: null, notice: null }, token);
    try {
      await work(token);
    } catch (error) {
      publish(
        {
          draft: "",
          error: settingsErrorMessage(
            error,
            "Could not update or reload credential status. Retry or reopen this section.",
          ),
        },
        token,
      );
    } finally {
      publish({ pending: null }, token);
    }
  };
  const writeSecret = (remove: boolean) => {
    if (!active || snapshot.pending || !snapshot.secrets || snapshot.provider === "mock")
      return Promise.resolve();
    const name = LLM_SECRET_NAMES[snapshot.provider];
    const value = remove ? null : nonEmptySecretDraft(snapshot.draft);
    if (remove ? !snapshot.secrets[name].configured : value === null) return Promise.resolve();
    return run(remove ? "Removing credential…" : "Saving credential…", async (token) => {
      publish({ draft: "" }, token);
      // The write's response is deliberately ignored: only the refreshed, projected status is retained.
      await client.settings.setSecret(name, value);
      if (!current(token)) return;
      publish(
        {
          notice: remove
            ? "Saved key removed. An environment key may still be configured."
            : "Key saved. Your model and provider settings did not change.",
        },
        token,
      );
      await readStatuses(token);
    });
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate() {
      active = true;
      generation++;
    },
    deactivate() {
      active = false;
      generation++;
      snapshot = {
        ...snapshot,
        draft: "",
        pending: null,
        error: null,
        notice: null,
        secrets: null,
      };
    },
    selectProvider(next: LlmProvider) {
      if (next === snapshot.provider) return;
      generation++;
      snapshot = {
        provider: next,
        draft: "",
        pending: null,
        error: null,
        notice: null,
        secrets: null,
      };
      if (active) listeners.forEach((listener) => listener());
    },
    refresh: () => run("Updating credential status…", readStatuses),
    setDraft(draft: string) {
      if (active && !snapshot.pending && snapshot.secrets && snapshot.provider !== "mock")
        publish({ draft });
    },
    saveSecret: () => writeSecret(false),
    removeSecret: () => writeSecret(true),
  };
}
