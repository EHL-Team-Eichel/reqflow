import { cx } from "../../../lib/cx";
import {
  LlmProvider,
  ResearchProvider,
  LLM_SECRET_NAMES,
  type Settings,
  API_PROVIDER_INFO,
  type ApiProvider,
  DEFAULT_SETUP,
  AGENT_ROLES,
  AGENT_ROLE_INFO,
  type AgentRole,
} from "@reqflow/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../ui/Button";
import { NumberInput, Select, Slider, TextArea, ValidatedTextInput } from "../../ui/controls";
import { api, ReqflowError } from "../../../lib/api";
import { settingsStore, useSettings } from "../../../lib/settings";
import { SettingRow } from "../SettingRow";
import { Segmented } from "../Segmented";

import { CredentialInput } from "./ResearchApisSection";
import {
  LLM_PROVIDER_LABELS,
  LLM_PROVIDER_OPTIONS,
  createAiCredentialsController,
  modelPresets,
  modelValidationError,
  switchLlmProvider,
  temperatureHelp,
} from "./AiSection.helpers";

const RESEARCH_PROVIDER_OPTIONS = [
  { value: "off", label: "Off (no web search)" },
  { value: "firecrawl", label: "Firecrawl (recommended)" },
  { value: "tavily", label: "Tavily (alternative)" },
];

/** One domain per line; blank lines ignored. */
function parseDomains(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function DomainList(props: {
  label: string;
  value: readonly string[];
  onChange: (val: string[]) => void;
}) {
  const [draft, setDraft] = useState(props.value.join("\n"));

  // Follow outside changes (reset), but keep the draft while it parses to the same list —
  // otherwise the newline you just typed would disappear.
  useEffect(() => {
    setDraft((d) =>
      parseDomains(d).join("\n") === props.value.join("\n") ? d : props.value.join("\n"),
    );
  }, [props.value]);

  const commit = (text: string) => {
    setDraft(text);
    props.onChange(parseDomains(text));
  };

  return (
    <SettingRow label={props.label}>
      <TextArea value={draft} onChange={commit} rows={4} placeholder="One domain per line" />
    </SettingRow>
  );
}

function ModelSelection(props: {
  provider: Settings["llm"]["provider"];
  tier: "quality" | "fast";
  value: string;
}) {
  const [customSelected, setCustomSelected] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const presets = modelPresets(props.provider);
  const custom = customSelected || !presets.some((option) => option.value === props.value);
  const disabled = props.provider === "mock";
  const label = props.tier === "quality" ? "Quality model" : "Fast model";
  const id = `llm-${props.tier}`;
  const commit = (input: string) => {
    if (disabled) return "Mock does not use live models.";
    if (settingsStore.getState().settings.llm.provider !== props.provider) {
      return "Provider changed. Edit the selected provider's model.";
    }
    const error = modelValidationError(props.provider, input);
    if (error) return error;
    return settingsStore.getState().update("llm", {
      [props.tier === "quality" ? "model" : "fastModel"]: input.trim(),
    });
  };

  return (
    <SettingRow
      label={label}
      description={
        props.tier === "quality"
          ? "QUALITY · complex writing and reasoning"
          : "FAST · bulk extraction and lightweight work"
      }
      error={
        disabled ? null : (selectionError ?? modelValidationError(props.provider, props.value))
      }
    >
      <label htmlFor={`${id}-preset`} className="sr-only">
        {label} preset
      </label>
      <Select
        id={`${id}-preset`}
        options={[...presets, { value: "custom", label: "Custom model ID" }]}
        value={custom ? "custom" : props.value}
        disabled={disabled}
        onChange={(value) => {
          if (disabled) return;
          if (value === "custom") {
            setCustomSelected(true);
            setSelectionError(null);
          } else if (presets.some((option) => option.value === value)) {
            const error = commit(value);
            setSelectionError(error);
            if (!error) setCustomSelected(false);
          }
        }}
      />
      {custom && !disabled && (
        <>
          <label htmlFor={`${id}-custom`} className="sr-only">
            Custom {label.toLowerCase()} ID
          </label>
          <ValidatedTextInput
            id={`${id}-custom`}
            value={props.value}
            onCommit={commit}
            maxLength={200}
            spellCheck={false}
            autoComplete="off"
            aria-describedby={`${id}-help`}
          />
        </>
      )}
      {!disabled && (
        <p id={`${id}-help`} className="text-xs text-muted">
          Use a model ID for {LLM_PROVIDER_LABELS[props.provider]}. Presets do not verify account
          access. Custom IDs are allowed; known foreign-provider IDs are rejected.
        </p>
      )}
    </SettingRow>
  );
}

export function AiSection() {
  const llm = useSettings((s) => s.settings.llm);
  const research = useSettings((s) => s.settings.research);
  const agents = useSettings((s) => s.settings.agents);
  // Keep older settings readable without offering the unsupported provider to new users.
  const researchProviderOptions =
    research.provider === "anthropic_web_search"
      ? [
          ...RESEARCH_PROVIDER_OPTIONS,
          {
            value: "anthropic_web_search",
            label: "Claude web search (legacy · unsupported)",
          },
        ]
      : RESEARCH_PROVIDER_OPTIONS;
  const [providerError, setProviderError] = useState<string | null>(null);
  const [credentials] = useState(() => createAiCredentialsController(api, llm.provider));
  const credentialState = useSyncExternalStore(
    credentials.subscribe,
    credentials.getSnapshot,
    credentials.getSnapshot,
  );
  const matchingProvider = credentialState.provider === llm.provider;
  const secrets = matchingProvider ? credentialState.secrets : null;
  const secretsPending =
    !matchingProvider || !!credentialState.pending || (!secrets && !credentialState.error);
  const secretName = llm.provider === "mock" ? null : LLM_SECRET_NAMES[llm.provider];
  const keyLabel = llm.provider === "anthropic" ? "Anthropic" : LLM_PROVIDER_LABELS[llm.provider];
  const update = settingsStore.getState().update;

  useEffect(() => {
    credentials.activate();
    return () => credentials.deactivate();
  }, [credentials]);
  useEffect(() => {
    credentials.selectProvider(llm.provider);
    void credentials.refresh();
    setProviderError(null);
  }, [credentials, llm.provider]);

  const credentialCurrent = () =>
    matchingProvider && settingsStore.getState().settings.llm.provider === llm.provider;

  const refreshSecrets = () => {
    void credentials.refresh();
  };

  const [setupErrors, setSetupErrors] = useState<Record<string, string>>({});
  const [setupMessages, setSetupMessages] = useState<
    Record<string, { text: string; isError: boolean }>
  >({});

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">AI & research</h2>
        <p className="mt-1 text-sm text-muted">Which models write and how the web is searched.</p>
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 text-sm font-semibold text-ink">Default AI</h3>
        <p className="mb-4 text-xs text-muted">
          Used by the AI Splitter and challenge answers, and by agents set to Default AI.
        </p>
        <SettingRow label="Provider" error={providerError}>
          <label htmlFor="llm-provider" className="sr-only">
            AI provider
          </label>
          <Select
            id="llm-provider"
            options={LLM_PROVIDER_OPTIONS}
            value={llm.provider}
            onChange={(value) => {
              const provider = LlmProvider.safeParse(value);
              if (!provider.success) return;
              try {
                const next = switchLlmProvider(
                  settingsStore.getState().settings.llm,
                  provider.data,
                );
                const error = update("llm", next);
                setProviderError(error);
                if (!error) credentials.selectProvider(provider.data);
              } catch {
                setProviderError(
                  "Current model IDs must have 1–200 characters before switching providers.",
                );
              }
            }}
          />
        </SettingRow>
        <ModelSelection
          key={`${llm.provider}-quality`}
          provider={llm.provider}
          tier="quality"
          value={llm.model}
        />
        <ModelSelection
          key={`${llm.provider}-fast`}
          provider={llm.provider}
          tier="fast"
          value={llm.fastModel}
        />
        <SettingRow label="Temperature" description={temperatureHelp(llm)}>
          <label htmlFor="llm-temperature" className="sr-only">
            Temperature
          </label>
          <Slider
            id="llm-temperature"
            disabled={llm.provider === "mock"}
            value={llm.temperature}
            onChange={(temperature) => update("llm", { temperature })}
            min={0}
            max={1}
            step={0.05}
          />
        </SettingRow>
        <p className="mt-2 text-xs text-muted">
          Switching live providers remembers each provider's quality and fast model IDs. Mock keeps
          them inactive; it never makes paid model calls. Model selection does not start a run or
          enable web research.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">API setups</h3>

        {agents.setups.map((setup) => {
          const providerInfo = API_PROVIDER_INFO[setup.provider];
          const isMock = setup.provider === "mock";
          const isJev = setup.provider === "jev";

          const updateSetup = (changes: Partial<typeof setup>) => {
            const nextSetups = agents.setups.map((s) =>
              s.id === setup.id ? { ...s, ...changes } : s,
            );
            const err = update("agents", { ...agents, setups: nextSetups });
            setSetupErrors((prev) => ({ ...prev, [setup.id]: err ?? "" }));
          };

          const handleProviderChange = (newProvider: ApiProvider) => {
            const p = newProvider;
            let model = setup.model;
            let fastModel = setup.fastModel;

            if (p === "anthropic") {
              model = "claude-opus-5-5";
              fastModel = "claude-haiku-5-5";
            } else if (p === "jev") {
              model = "jev-latest";
              fastModel = "";
            } else if (p === "mock") {
              model = "";
              fastModel = "";
            }

            updateSetup({ provider: p, model, fastModel });
          };

          return (
            <div
              key={setup.id}
              className="rounded-xl border border-line bg-panel p-4 flex flex-col gap-4"
            >
              <div className="grid grid-cols-2 gap-4">
                <SettingRow label="Name">
                  <ValidatedTextInput
                    aria-label="Setup name"
                    value={setup.name}
                    onCommit={(name) => {
                      updateSetup({ name: name.trim() });
                      return null;
                    }}
                  />
                </SettingRow>
                <SettingRow label="Provider">
                  <Select
                    options={(Object.keys(API_PROVIDER_INFO) as ApiProvider[]).map((p) => ({
                      value: p,
                      label: API_PROVIDER_INFO[p].label,
                    }))}
                    value={setup.provider}
                    onChange={(v) => handleProviderChange(v as ApiProvider)}
                  />
                </SettingRow>
              </div>

              {!isMock && (
                <SettingRow label="Base URL">
                  <ValidatedTextInput
                    aria-label="Base URL"
                    value={setup.baseUrl}
                    placeholder={providerInfo.baseUrl || "https://.../v1"}
                    onCommit={(baseUrl) => {
                      updateSetup({ baseUrl: baseUrl.trim() });
                      return null;
                    }}
                  />
                </SettingRow>
              )}

              <div className="grid grid-cols-2 gap-4">
                <SettingRow label="Quality model">
                  <ValidatedTextInput
                    aria-label="Quality model"
                    value={setup.model}
                    onCommit={(model) => {
                      updateSetup({ model: model.trim() });
                      return null;
                    }}
                  />
                </SettingRow>
                {!isJev && !isMock && (
                  <SettingRow label="Fast model">
                    <ValidatedTextInput
                      aria-label="Fast model"
                      value={setup.fastModel}
                      onCommit={(fastModel) => {
                        updateSetup({ fastModel: fastModel.trim() });
                        return null;
                      }}
                    />
                  </SettingRow>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                {!isJev && !isMock && (
                  <SettingRow label="Reasoning effort">
                    <Segmented
                      options={[
                        { value: "off", label: "Off" },
                        { value: "low", label: "Low" },
                        { value: "medium", label: "Medium" },
                        { value: "high", label: "High" },
                      ]}
                      value={setup.effort}
                      onChange={(effort) => updateSetup({ effort: effort as any })}
                      testIdPrefix={`setup-${setup.id}-effort-`}
                    />
                  </SettingRow>
                )}
                <SettingRow label="Parallel calls">
                  <NumberInput
                    value={setup.maxParallel}
                    min={1}
                    max={16}
                    onChange={(maxParallel) => updateSetup({ maxParallel })}
                  />
                </SettingRow>
              </div>

              {!isMock && (
                <SettingRow label="API key">
                  <div className="flex flex-col gap-2 w-full">
                    <span className="text-sm text-muted">
                      {secrets?.setups?.[setup.id]?.configured
                        ? "Stored in the OS keychain"
                        : "No key yet"}
                    </span>
                    <div className="flex gap-2 w-full">
                      <input
                        type="password"
                        id={`key-${setup.id}`}
                        className="flex-1 h-8 rounded-md border border-line bg-panel px-2 text-sm text-ink outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                        placeholder="Paste key to save"
                        autoComplete="off"
                        onKeyDown={async (e) => {
                          if (e.key === "Enter") {
                            const val = e.currentTarget.value.trim();
                            if (val) {
                              await api.settings.setSecret(`setup:${setup.id}`, val);
                              e.currentTarget.value = "";
                              refreshSecrets();
                            }
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        onClick={async () => {
                          const input = document.getElementById(
                            `key-${setup.id}`,
                          ) as HTMLInputElement;
                          const val = input.value.trim();
                          if (val) {
                            await api.settings.setSecret(`setup:${setup.id}`, val);
                            input.value = "";
                            refreshSecrets();
                          }
                        }}
                      >
                        Save key
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await api.settings.setSecret(`setup:${setup.id}`, null);
                          refreshSecrets();
                        }}
                      >
                        Remove key
                      </Button>
                    </div>
                  </div>
                </SettingRow>
              )}

              <div className="flex items-center gap-3 border-t border-line pt-4">
                <Button
                  size="sm"
                  onClick={async () => {
                    setSetupMessages((prev) => ({
                      ...prev,
                      [setup.id]: { text: "Testing...", isError: false },
                    }));
                    try {
                      const res = await api.settings.testSetup(setup.id);
                      setSetupMessages((prev) => ({
                        ...prev,
                        [setup.id]: {
                          text: `${res.message} (${res.ms} ms)`,
                          isError: false,
                        },
                      }));
                    } catch (e) {
                      const isNotImpl = e instanceof ReqflowError && e.code === "not_implemented";
                      setSetupMessages((prev) => ({
                        ...prev,
                        [setup.id]: {
                          text: isNotImpl
                            ? "The thought process isn't available in this build yet."
                            : e instanceof Error
                              ? e.message
                              : String(e),
                          isError: true,
                        },
                      }));
                    }
                  }}
                >
                  Test
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  data-testid={`settings-delete-setup-${setup.id}`}
                  onClick={() => {
                    const nextSetups = agents.setups.filter((s) => s.id !== setup.id);
                    const nextRoles = { ...agents.roles };
                    for (const r of AGENT_ROLES) {
                      if (nextRoles[r] === setup.id) nextRoles[r] = "default";
                    }
                    update("agents", { ...agents, setups: nextSetups, roles: nextRoles });
                  }}
                >
                  Delete setup
                </Button>

                {setupMessages[setup.id] && (
                  <span
                    className={cx(
                      "text-sm",
                      setupMessages[setup.id]?.isError ? "text-danger" : "text-ok",
                    )}
                  >
                    {setupMessages[setup.id]?.text}
                  </span>
                )}
              </div>
              {setupErrors[setup.id] && (
                <div className="text-sm text-danger mt-1">{setupErrors[setup.id]}</div>
              )}
            </div>
          );
        })}

        <Button
          data-testid="settings-add-setup"
          onClick={() => {
            let idNum = 1;
            while (agents.setups.some((s) => s.id === `setup-${idNum}`)) idNum++;
            let nameNum = 1;
            while (agents.setups.some((s) => s.name === `Setup ${nameNum}`)) nameNum++;

            const newSetup = {
              id: `setup-${idNum}`,
              name: `Setup ${nameNum}`,
              provider: "anthropic" as const,
              baseUrl: "",
              model: "claude-opus-5-5",
              fastModel: "claude-haiku-5-5",
              effort: "medium" as const,
              temperature: 0.2,
              maxParallel: 4,
            };
            update("agents", { ...agents, setups: [...agents.setups, newSetup] });
          }}
        >
          + Add API setup
        </Button>
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">Agents</h3>
        {AGENT_ROLES.map((role) => {
          const isJudge = role === "judge";
          const roleInfo = AGENT_ROLE_INFO[role];

          const options = [{ value: DEFAULT_SETUP, label: "Default AI" }];
          agents.setups.forEach((s) => {
            if (isJudge || API_PROVIDER_INFO[s.provider].writes) {
              options.push({ value: s.id, label: s.name });
            }
          });

          return (
            <div key={role} className="mb-4">
              <SettingRow label={roleInfo.label}>
                <Select
                  options={options}
                  value={agents.roles[role]}
                  onChange={(val) => {
                    update("agents", { ...agents, roles: { ...agents.roles, [role]: val } });
                  }}
                />
              </SettingRow>
              <div className="ml-48 mt-1 text-xs text-muted">{roleInfo.does}</div>
              {isJudge && (
                <div className="ml-48 mt-1 text-xs text-muted">
                  TypeSafe Jev answers the judge's yes/no and scale questions with calibrated
                  probabilities. Any other setup answers the same questions as an LLM.
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">Web research</h3>
        <SettingRow label="Provider">
          <label htmlFor="web-research-provider" className="sr-only">
            Web research provider
          </label>
          <Select
            id="web-research-provider"
            options={researchProviderOptions}
            value={research.provider}
            onChange={(value) => {
              const provider = ResearchProvider.safeParse(value);
              if (provider.success) update("research", { provider: provider.data });
            }}
          />
        </SettingRow>
        <p className="mt-2 text-xs text-muted">
          Off blocks web search. Select Firecrawl (recommended) or Tavily here, then configure and
          enable it in Research APIs &amp; Zugänge. No automatic fallback is used. Other research
          providers are controlled independently by their own access settings.
        </p>
        {research.provider === "anthropic_web_search" && (
          <p role="alert" className="mt-2 text-sm text-muted">
            Claude web search is a legacy setting and is unsupported. Select Firecrawl, Tavily, or
            Off before running web research.
          </p>
        )}
        <SettingRow label="Max results per search">
          <NumberInput
            value={research.maxResultsPerQuery}
            onChange={(maxResultsPerQuery) => update("research", { maxResultsPerQuery })}
            min={1}
            max={50}
          />
        </SettingRow>
        <DomainList
          label="Allowed domains"
          value={research.allowedDomains}
          onChange={(allowedDomains) => update("research", { allowedDomains })}
        />
        <DomainList
          label="Blocked domains"
          value={research.blockedDomains}
          onChange={(blockedDomains) => update("research", { blockedDomains })}
        />
      </div>

      <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm text-muted">
        <h3 className="font-medium text-ink">Optional Mastra query planning</h3>
        <p className="mt-1">
          {llm.provider === "mock"
            ? "Mock is offline and never makes paid model calls. For live planning, select a provider and configure its matching credential: Anthropic key, OpenAI key, or Google Gemini key."
            : `Requires a ${keyLabel} key for the selected ${LLM_PROVIDER_LABELS[llm.provider]} provider.`}{" "}
          Also requires the Research block's explicit query-planning toggle (off by default).
          Enabling it may make paid model calls during a run with a live provider and the block's
          planning model. Custom planning models must match that provider. It only plans queries and
          cannot enable providers, bypass missing credentials or approval, or create source
          evidence. Saving a key or choosing an AI model does not enable planning.
        </p>
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">API keys</h3>
        {matchingProvider && credentialState.error && (
          <div
            role="alert"
            className="rounded-lg border border-line bg-danger-soft p-3 text-sm text-danger"
          >
            {credentialState.error}
          </div>
        )}
        {matchingProvider && credentialState.notice && (
          <p role="status" className="mt-2 text-sm text-ink">
            {credentialState.notice}
          </p>
        )}
        {secretsPending && (
          <div role="status" className="text-sm text-muted">
            Updating credential status…
          </div>
        )}
        {secretName ? (
          <SettingRow label={LLM_PROVIDER_LABELS[llm.provider]}>
            <CredentialInput
              key={secretName}
              id={secretName}
              label={`${keyLabel} API key`}
              configured={secrets?.[secretName].configured}
              source={secrets?.[secretName].source}
              draft={matchingProvider ? credentialState.draft : ""}
              disabled={secretsPending || !secrets}
              onDraft={(value) => {
                if (credentialCurrent()) credentials.setDraft(value);
              }}
              onSave={() => {
                if (credentialCurrent()) void credentials.saveSecret();
              }}
              onRemove={() => {
                if (credentialCurrent()) void credentials.removeSecret();
              }}
            />
            <p className="text-xs text-muted">
              Drafts also clear when switching providers. Other providers' saved keys are not
              removed.
            </p>
          </SettingRow>
        ) : (
          <p className="mt-2 text-sm text-muted">
            Mock needs no API key. Select a live provider to manage its key.
          </p>
        )}
        <SettingRow label="Tavily">
          <span className="text-sm text-muted">
            {!secrets
              ? "Status unavailable"
              : secrets.tavily_api_key.configured
                ? `Configured (${secrets.tavily_api_key.source === "env" ? "environment" : "OS keychain"})`
                : "Not set"}
          </span>
          <p className="text-xs text-muted">Manage this key in Research APIs &amp; Zugänge.</p>
        </SettingRow>
        <Button
          variant="ghost"
          size="sm"
          disabled={secretsPending}
          onClick={() => {
            void credentials.refresh();
          }}
        >
          Reload credential status
        </Button>
      </div>

      <div className="mt-4 flex gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            credentials.selectProvider("mock");
            settingsStore.getState().resetSection("llm");
            setProviderError(null);
          }}
        >
          Reset AI
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => settingsStore.getState().resetSection("research")}
        >
          Reset research
        </Button>
      </div>
    </div>
  );
}
