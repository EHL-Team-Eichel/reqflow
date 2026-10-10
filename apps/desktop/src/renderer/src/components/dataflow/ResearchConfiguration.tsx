import { BLOCK_SPECS, type WorkflowBlock } from "@reqflow/core";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { ChipSelect, TextArea, TextInput } from "@/components/ui/controls";
import { useSettings } from "@/lib/settings";
import {
  SOCIAL_MEDIA_OPTIONS,
  scopeFormFromJson,
  scopeJsonFromForm,
  selectSocialMedia,
  socialMediaSelection,
  validateResearchAgents,
  validateScopeJson,
  type ResearchScopeForm,
  type ScopeListField,
  type ScopeTextField,
  type SocialMediaSelection,
} from "./research-configuration";
import { dataflowStore } from "./store";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Invalid research configuration.";

/** Only agents and scopeJson are written here; provider access and budgets keep their existing owners. */
export function ResearchConfiguration({ block }: { block: WorkflowBlock }) {
  const [agentError, setAgentError] = useState<string | null>(null);
  const settingsScope = useSettings((state) => state.settings.defaultScope);
  const agentSpec = BLOCK_SPECS.research.params.find((param) => param.key === "agents");
  const agents = Array.isArray(block.params.agents) ? (block.params.agents as string[]) : [];
  let existingAgentError: string | null = null;
  try {
    validateResearchAgents(block.params.agents);
  } catch (error) {
    existingAgentError = message(error);
  }

  const commit = (key: "agents" | "scopeJson", value: unknown) =>
    dataflowStore.getState().setParams(block.id, { ...block.params, [key]: value });

  const changeAgents = (next: readonly string[]) => {
    try {
      setAgentError(commit("agents", validateResearchAgents(next)));
    } catch (error) {
      setAgentError(message(error));
    }
  };

  const scopeJson = block.params.scopeJson === undefined ? "{}" : String(block.params.scopeJson);
  const fallbackMarket =
    typeof block.params.market === "string" && block.params.market !== "global"
      ? block.params.market
      : settingsScope.market;

  return (
    <div data-testid="research-configuration" className="flex flex-col gap-4">
      <Field
        label="Social media"
        help="Changes only social agents. Custom reflects your combination in Research agents below. None keeps non-social agents."
        error={agentError ?? existingAgentError}
      >
        {(id) => (
          <select
            id={id}
            data-testid="research-social-media"
            value={socialMediaSelection(agents)}
            aria-invalid={agentError || existingAgentError ? true : undefined}
            onChange={(event) => {
              try {
                changeAgents(selectSocialMedia(agents, event.target.value as SocialMediaSelection));
              } catch (error) {
                setAgentError(message(error));
              }
            }}
            className="h-9 w-full cursor-pointer rounded-lg border border-line bg-panel-2 px-3 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20"
          >
            {SOCIAL_MEDIA_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {agentSpec?.type === "multiselect" && (
        <div data-testid="research-agents" role="group" aria-label={agentSpec.label}>
          <Field
            label={agentSpec.label}
            help="Select at least one agent. Use the chips for any custom social/non-social combination."
          >
            {(id) => (
              <ChipSelect
                id={id}
                value={agents}
                onChange={changeAgents}
                options={agentSpec.options}
              />
            )}
          </Field>
        </div>
      )}
      <p className="text-xs text-muted">
        Research agents select collectors. Legacy “Look at” categories are hidden, not a second
        agent selector. Selecting agents never enables a provider or grants permission. Configure
        authorized access in Settings.
      </p>
      <ScopeEditor
        key={scopeJson}
        value={scopeJson}
        modelDefault={settingsScope.vehicleLine}
        derivativeDefault={settingsScope.derivative}
        marketDefault={fallbackMarket}
        onCommit={(json) => commit("scopeJson", json)}
      />
    </div>
  );
}

type ScopeDraft = {
  baseJson: string;
  json: string;
  form: ResearchScopeForm | null;
  mode: "form" | "json";
  error: string | null;
};

function initialScopeDraft(json: string): ScopeDraft {
  try {
    return { baseJson: json, json, form: scopeFormFromJson(json), mode: "form", error: null };
  } catch (error) {
    // Invalid/unsupported advanced content stays visible and editable, never replaced by {}.
    return { baseJson: json, json, form: null, mode: "json", error: message(error) };
  }
}

function ScopeEditor({
  value,
  modelDefault,
  derivativeDefault,
  marketDefault,
  onCommit,
}: {
  value: string;
  modelDefault: string;
  derivativeDefault?: string;
  marketDefault: string;
  onCommit: (json: string) => string | null;
}) {
  const initial = useMemo(() => initialScopeDraft(value), [value]);
  const [draft, setDraft] = useState(initial);
  const dirty = draft.json !== value || JSON.stringify(draft.form) !== JSON.stringify(initial.form);

  const switchMode = (mode: ScopeDraft["mode"]) => {
    try {
      const json =
        draft.mode === "form" && draft.form
          ? scopeJsonFromForm(draft.baseJson, draft.form)
          : validateScopeJson(draft.json);
      setDraft({ baseJson: json, json, form: scopeFormFromJson(json), mode, error: null });
    } catch (error) {
      setDraft({ ...draft, error: message(error) });
    }
  };

  const apply = () => {
    try {
      const json =
        draft.mode === "form" && draft.form
          ? scopeJsonFromForm(draft.baseJson, draft.form)
          : validateScopeJson(draft.json);
      const error = onCommit(json);
      if (error) setDraft({ ...draft, error });
      else setDraft({ ...initialScopeDraft(json), mode: draft.mode });
    } catch (error) {
      setDraft({ ...draft, error: message(error) });
    }
  };

  const updateForm = (form: ResearchScopeForm) => setDraft({ ...draft, form, error: null });

  return (
    <section
      data-testid="research-scope"
      aria-label="Research scope"
      className="flex flex-col gap-3 border-t border-line pt-4"
    >
      <h4 className="text-sm font-medium text-ink">Research scope</h4>
      <p className="text-xs text-muted">
        Blank fields keep backend defaults. Clear a field to remove its override, then Apply scope.
        Model defaults to From Settings at run time. These are search filters, not evidence of a
        source’s market or language.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          aria-pressed={draft.mode === "form"}
          data-testid="research-scope-form-toggle"
          onClick={() => switchMode("form")}
        >
          Scope form
        </Button>
        <Button
          size="sm"
          aria-pressed={draft.mode === "json"}
          data-testid="research-scope-advanced-toggle"
          onClick={() => switchMode("json")}
        >
          Advanced JSON
        </Button>
      </div>
      {draft.mode === "form" && draft.form ? (
        <ScopeForm
          form={draft.form}
          onChange={updateForm}
          modelDefault={modelDefault}
          derivativeDefault={derivativeDefault}
          marketDefault={marketDefault}
        />
      ) : (
        <Field
          label="Advanced research scope (JSON)"
          help="Full canonical scope object. Documents, Eurostat datasets, domains, questions and horizon remain supported. Unknown/invalid fields are kept visible but must pass ResearchScope before acceptance."
        >
          {(id) => (
            <TextArea
              id={id}
              data-testid="research-scope-json"
              rows={12}
              spellCheck={false}
              value={draft.json}
              aria-invalid={draft.error ? true : undefined}
              onChange={(json) => {
                let error: string | null = null;
                try {
                  validateScopeJson(json);
                } catch (cause) {
                  error = message(cause);
                }
                setDraft({ ...draft, json, error });
              }}
            />
          )}
        </Field>
      )}
      {draft.error && (
        <p data-testid="research-scope-error" role="alert" className="text-xs text-danger">
          {draft.error}
        </p>
      )}
      {dirty && (
        <p role="status" className="text-xs text-muted">
          Scope draft not applied. Apply scope before starting a run.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          data-testid="research-scope-apply"
          disabled={!dirty}
          onClick={apply}
        >
          Apply scope
        </Button>
        <Button
          size="sm"
          data-testid="research-scope-discard"
          disabled={!dirty}
          onClick={() => setDraft(initial)}
        >
          Discard draft
        </Button>
      </div>
    </section>
  );
}

function ScopeForm({
  form,
  onChange,
  modelDefault,
  derivativeDefault,
  marketDefault,
}: {
  form: ResearchScopeForm;
  onChange: (form: ResearchScopeForm) => void;
  modelDefault: string;
  derivativeDefault?: string;
  marketDefault: string;
}) {
  const textFields: { key: ScopeTextField; label: string; help?: string; placeholder?: string }[] =
    [
      { key: "brand", label: "Brand override", placeholder: "BMW (backend default)" },
      {
        key: "model",
        label: "Model override",
        placeholder: `From Settings: ${modelDefault}`,
        help: "Leave blank for From Settings. No model default is saved into this block.",
      },
      { key: "currentGeneration", label: "Current generation", placeholder: "e.g. F70" },
      { key: "previousGeneration", label: "Previous generation", placeholder: "e.g. F40" },
      {
        key: "derivative",
        label: "Derivative override",
        placeholder: derivativeDefault ? `From Settings: ${derivativeDefault}` : "Backend default",
      },
      { key: "propulsion", label: "Propulsion", placeholder: "e.g. ICE, PHEV or BEV" },
      { key: "modelYear", label: "Model year", placeholder: "e.g. 2026" },
    ];
  const lists: { key: ScopeListField; label: string; help: string }[] = [
    {
      key: "markets",
      label: "Markets",
      help: `One per line. Blank keeps backend fallback: ${marketDefault}. This does not attribute returned sources to these markets.`,
    },
    {
      key: "languages",
      label: "Languages",
      help: "One language/code per line. Blank keeps backend defaults; unknown source language remains unknown.",
    },
    {
      key: "keywords",
      label: "Keywords",
      help: "One phrase per line. Commas within a phrase are preserved.",
    },
    {
      key: "urls",
      label: "Source URLs",
      help: "One complete URL per line. URLs are collection inputs, not verified evidence. Never include credentials.",
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {textFields.map(({ key, label, help, placeholder }) => (
        <Field key={key} label={label} help={help}>
          {(id) => (
            <TextInput
              id={id}
              data-testid={`research-scope-${key}`}
              value={form[key]}
              placeholder={placeholder}
              onChange={(value) => onChange({ ...form, [key]: value })}
            />
          )}
        </Field>
      ))}
      {lists.slice(0, 2).map(({ key, label, help }) => (
        <ScopeList
          key={key}
          field={key}
          label={label}
          help={help}
          form={form}
          onChange={onChange}
        />
      ))}
      {(["publishedFrom", "publishedTo"] as const).map((key) => (
        <Field
          key={key}
          label={key === "publishedFrom" ? "Published from" : "Published to"}
          help="Optional publication date. Clearing removes this override; the backend resolves defaults."
        >
          {(id) => (
            <TextInput
              id={id}
              type="date"
              data-testid={`research-scope-${key}`}
              value={form[key]}
              onChange={(value) => onChange({ ...form, [key]: value })}
            />
          )}
        </Field>
      ))}
      {lists.slice(2).map(({ key, label, help }) => (
        <ScopeList
          key={key}
          field={key}
          label={label}
          help={help}
          form={form}
          onChange={onChange}
        />
      ))}
      <details className="flex flex-col text-sm text-ink">
        <summary className="cursor-pointer font-medium">
          Competitors · {form.competitors.length}
        </summary>
        <div data-testid="research-scope-competitors" className="mt-3 flex flex-col gap-3">
          <p className="text-xs text-muted">
            Optional operator-selected comparison vehicles, not findings. Each competitor needs a
            brand and model.
          </p>
          {form.competitors.map((competitor, index) => (
            <fieldset key={index} className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <legend className="px-1 text-xs text-muted">Competitor {index + 1}</legend>
              {(["brand", "model", "generation"] as const).map((key) => (
                <Field
                  key={key}
                  label={`${key === "brand" ? "Brand" : key === "model" ? "Model" : "Generation (optional)"} · competitor ${index + 1}`}
                >
                  {(id) => (
                    <TextInput
                      id={id}
                      data-testid={`research-competitor-${index}-${key}`}
                      value={competitor[key]}
                      onChange={(value) =>
                        onChange({
                          ...form,
                          competitors: form.competitors.map((item, i) =>
                            i === index ? { ...item, [key]: value } : item,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
              ))}
              <Button
                size="sm"
                aria-label={`Remove competitor ${index + 1}`}
                onClick={() =>
                  onChange({ ...form, competitors: form.competitors.filter((_, i) => i !== index) })
                }
              >
                Remove competitor
              </Button>
            </fieldset>
          ))}
          <Button
            size="sm"
            data-testid="research-competitor-add"
            onClick={() =>
              onChange({
                ...form,
                competitors: [...form.competitors, { brand: "", model: "", generation: "" }],
              })
            }
          >
            Add competitor
          </Button>
        </div>
      </details>
    </div>
  );
}

function ScopeList({
  field,
  label,
  help,
  form,
  onChange,
}: {
  field: ScopeListField;
  label: string;
  help: string;
  form: ResearchScopeForm;
  onChange: (form: ResearchScopeForm) => void;
}) {
  return (
    <Field label={label} help={help}>
      {(id) => (
        <TextArea
          id={id}
          data-testid={`research-scope-${field}`}
          rows={2}
          value={form[field]}
          onChange={(value) => onChange({ ...form, [field]: value })}
        />
      )}
    </Field>
  );
}
