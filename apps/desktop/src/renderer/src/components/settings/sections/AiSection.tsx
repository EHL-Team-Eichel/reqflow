import { LLM_SECRET_NAMES, LlmProvider, ResearchProvider, type Settings } from "@reqflow/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../../ui/Button";
import { NumberInput, Select, Slider, TextArea, ValidatedTextInput } from "../../ui/controls";
import { api } from "../../../lib/api";
import { settingsStore, useSettings } from "../../../lib/settings";
import { SettingRow } from "../SettingRow";
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">AI & research</h2>
        <p className="mt-1 text-sm text-muted">Which models write and how the web is searched.</p>
      </div>

      <div className="flex flex-col">
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
            onChange={(temperature) => settingsStore.getState().update("llm", { temperature })}
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
            onChange={(maxResultsPerQuery) =>
              settingsStore.getState().update("research", { maxResultsPerQuery })
            }
            min={1}
            max={50}
          />
        </SettingRow>
        <DomainList
          label="Allowed domains"
          value={research.allowedDomains}
          onChange={(allowedDomains) =>
            settingsStore.getState().update("research", { allowedDomains })
          }
        />
        <DomainList
          label="Blocked domains"
          value={research.blockedDomains}
          onChange={(blockedDomains) =>
            settingsStore.getState().update("research", { blockedDomains })
          }
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
