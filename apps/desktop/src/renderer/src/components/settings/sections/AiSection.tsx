import {
  LlmProvider,
  ResearchProvider,
  type FixedSecretName,
  type SecretStatus,
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
  const [secrets, setSecrets] = useState<SecretStatus | null>(null);
  const [secretsError, setSecretsError] = useState<string | null>(null);
  const update = settingsStore.getState().update;

  useEffect(() => {
    api.settings.secrets().then(setSecrets, (err: unknown) => {
      setSecretsError(
        err instanceof ReqflowError && err.code === "not_implemented"
          ? "Key storage isn't built yet (WS1). For development, put keys in apps/desktop/.env."
          : `Couldn't read the key status: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">AI & research</h2>
        <p className="mt-1 text-sm text-muted">Which models write and how the web is searched.</p>
      </div>

      <div className="flex flex-col">
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
            onChange={(temperature) => settingsStore.getState().update("llm", { temperature })}
            min={0}
            max={1}
            step={0.05}
          />
        </SettingRow>
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
