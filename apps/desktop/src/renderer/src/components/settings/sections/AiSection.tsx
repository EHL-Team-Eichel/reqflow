import { cx } from "@/lib/cx";
import {
  LlmProvider,
  ResearchProvider,
  type FixedSecretName,
  type SecretStatus,
  API_PROVIDER_INFO,
  type ApiProvider,
  DEFAULT_SETUP,
  AGENT_ROLES,
  AGENT_ROLE_INFO,
  type AgentRole,
} from "@reqflow/core";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  NumberInput,
  Select,
  Slider,
  TextArea,
  ValidatedTextInput,
} from "@/components/ui/controls";
import { api, ReqflowError } from "@/lib/api";
import { settingsStore, useSettings } from "@/lib/settings";
import { SettingRow } from "../SettingRow";
import { Segmented } from "../Segmented";

const SECRET_LABELS: Record<FixedSecretName, string> = {
  anthropic_api_key: "Anthropic",
  tavily_api_key: "Tavily",
};

const LLM_PROVIDER_OPTIONS = [
  { value: "mock", label: "Mock (offline demo)" },
  { value: "anthropic", label: "Anthropic Claude" },
];
const RESEARCH_PROVIDER_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "anthropic_web_search", label: "Claude web search" },
  { value: "tavily", label: "Tavily" },
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

export function AiSection() {
  const llm = useSettings((s) => s.settings.llm);
  const research = useSettings((s) => s.settings.research);
  const agents = useSettings((s) => s.settings.agents);
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const update = settingsStore.getState().update;

  useEffect(() => {
    let active = true;
    const loadSecrets = () => {
      api.settings
        .secrets()
        .then((res) => {
          if (active) {
            setSecrets(res);
            setSecretsError(null);
          }
        })
        .catch((err: unknown) => {
          if (active) {
            setSecretsError(
              err instanceof ReqflowError && err.code === "not_implemented"
                ? "Key storage isn't built yet (WS1). For development, put keys in apps/desktop/.env."
                : `Couldn't read the key status: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
    };
    loadSecrets();

    // Listen for custom event or provide a callback to re-fetch when secrets change?
    // The instructions say "api.settings.setSecret(`setup:${id}`, value) then clear the input"
    // I can just re-fetch in the component when save/remove key happens.

    return () => {
      active = false;
    };
  }, []);

  const refreshSecrets = () => {
    api.settings
      .secrets()
      .then(setSecrets)
      .catch(() => {});
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
        <SettingRow label="Provider">
          <Select
            options={LLM_PROVIDER_OPTIONS}
            value={llm.provider}
            onChange={(value) => {
              const provider = LlmProvider.safeParse(value);
              if (provider.success) update("llm", { provider: provider.data });
            }}
          />
        </SettingRow>
        <SettingRow label="Quality model">
          <ValidatedTextInput
            aria-label="Quality model"
            value={llm.model}
            onCommit={(model) => update("llm", { model: model.trim() })}
          />
        </SettingRow>
        <SettingRow label="Fast model">
          <ValidatedTextInput
            aria-label="Fast model"
            value={llm.fastModel}
            onCommit={(fastModel) => update("llm", { fastModel: fastModel.trim() })}
          />
        </SettingRow>
        <SettingRow label="Temperature">
          <Slider
            value={llm.temperature}
            onChange={(temperature) => update("llm", { temperature })}
            min={0}
            max={1}
            step={0.05}
          />
        </SettingRow>
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
          <Select
            options={RESEARCH_PROVIDER_OPTIONS}
            value={research.provider}
            onChange={(value) => {
              const provider = ResearchProvider.safeParse(value);
              if (provider.success) update("research", { provider: provider.data });
            }}
          />
        </SettingRow>
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

      <div className="flex flex-col">
        <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">API keys</h3>
        {secretsError ? (
          <div className="rounded-lg border border-line bg-panel-2 p-3 text-sm text-muted">
            {secretsError}
          </div>
        ) : !secrets ? (
          <div className="text-sm text-muted">Checking keys…</div>
        ) : (
          (Object.keys(SECRET_LABELS) as FixedSecretName[]).map((name) => {
            const status = secrets[name];
            if (!status) return null;
            return (
              <SettingRow key={name} label={SECRET_LABELS[name]}>
                <span className={status.configured ? "text-sm text-ok" : "text-sm text-muted"}>
                  {status.configured
                    ? `Configured (${status.source === "env" ? ".env file" : "OS keychain"})`
                    : "Not set"}
                </span>
              </SettingRow>
            );
          })
        )}
      </div>

      <div className="mt-4 flex gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => settingsStore.getState().resetSection("llm")}
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
