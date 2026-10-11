import { BLOCK_SPECS, ResearchScope, type ParamSpec, type WorkflowBlock } from "@reqflow/core";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { ChipSelect, TextArea, TextInput } from "@/components/ui/controls";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/ui/icons";
import { cx } from "@/lib/cx";
import { useSettings } from "@/lib/settings";
import { ParamField } from "./ParamField";
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
const scopeDefaults = ResearchScope.parse({});

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
    return { baseJson: json, json, form: null, mode: "json", error: message(error) };
  }
}

type CategoryTab = "all" | "basis" | "depth" | "custom";

function getParamSpec(key: string): ParamSpec {
  const spec = BLOCK_SPECS.research.params.find((param) => param.key === key);
  if (!spec) throw new Error(`Missing spec for research param: ${key}`);
  return spec;
}

export function ResearchConfiguration({ block }: { block: WorkflowBlock }) {
  const [activeTab, setActiveTab] = useState<CategoryTab>("all");
  const [openSections, setOpenSections] = useState({
    basis: true,
    depth: true,
    custom: true,
  });
  const [agentError, setAgentError] = useState<string | null>(null);

  const settingsScope = useSettings((state) => state.settings.defaultScope);
  const agentSpec = getParamSpec("agents");
  const questionSpec = getParamSpec("question");
  const sourcesSpec = getParamSpec("sources");
  const marketSpec = getParamSpec("market");
  const maxResultsSpec = getParamSpec("maxResults");
  const concurrencySpec = getParamSpec("concurrency");
  const maxAgeMonthsSpec = getParamSpec("maxAgeMonths");
  const maxRequestsSpec = getParamSpec("maxRequests");
  const timeoutMsSpec = getParamSpec("timeoutMs");
  const maxDocumentPagesSpec = getParamSpec("maxDocumentPages");
  const queryPlanningSpec = getParamSpec("queryPlanning");
  const documentSpec = getParamSpec("document");

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

  const initial = useMemo(() => initialScopeDraft(scopeJson), [scopeJson]);
  const [draft, setDraft] = useState(initial);
  const dirty =
    draft.json !== scopeJson || JSON.stringify(draft.form) !== JSON.stringify(initial.form);

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
      const error = commit("scopeJson", json);
      if (error) setDraft({ ...draft, error });
      else setDraft({ ...initialScopeDraft(json), mode: draft.mode });
    } catch (error) {
      setDraft({ ...draft, error: message(error) });
    }
  };

  const updateForm = (form: ResearchScopeForm) => setDraft({ ...draft, form, error: null });

  const toggleSection = (section: "basis" | "depth" | "custom") => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const selectTab = (tab: CategoryTab) => {
    setActiveTab(tab);
    if (tab === "basis") setOpenSections((prev) => ({ ...prev, basis: true }));
    if (tab === "depth") setOpenSections((prev) => ({ ...prev, depth: true }));
    if (tab === "custom") setOpenSections((prev) => ({ ...prev, custom: true }));
  };

  const textFields: { key: ScopeTextField; label: string; help?: string; placeholder?: string }[] =
    [
      {
        key: "brand",
        label: "Brand override",
        placeholder: `${scopeDefaults.brand} (default)`,
        help: `Leave blank to use ${scopeDefaults.brand}.`,
      },
      {
        key: "model",
        label: "Model override",
        placeholder: `From Settings: ${settingsScope.vehicleLine}`,
        help: `Leave blank to use From Settings: ${settingsScope.vehicleLine}. No model default is saved into this block.`,
      },
      {
        key: "currentGeneration",
        label: "Current generation",
        placeholder: "e.g. F70",
        help: "Leave blank to keep the current generation unspecified; there is no default.",
      },
      {
        key: "previousGeneration",
        label: "Previous generation",
        placeholder: "e.g. F40",
        help: "Leave blank to keep the previous generation unspecified; there is no default.",
      },
      {
        key: "derivative",
        label: "Derivative override",
        placeholder: settingsScope.derivative
          ? `From Settings: ${settingsScope.derivative}`
          : "Optional; no default",
        help: settingsScope.derivative
          ? `Leave blank to use From Settings: ${settingsScope.derivative}.`
          : "Leave blank to keep the derivative unspecified; Settings has no default derivative.",
      },
      {
        key: "propulsion",
        label: "Propulsion",
        placeholder: "e.g. ICE, PHEV or BEV",
        help: "Leave blank to keep propulsion unspecified; there is no default.",
      },
      {
        key: "modelYear",
        label: "Model year",
        placeholder: "e.g. 2026",
        help: "Leave blank to keep the model year unspecified; there is no default.",
      },
    ];

  const vehicleLists: { key: ScopeListField; label: string; help: string }[] = [
    {
      key: "markets",
      label: "Markets",
      help: `One per line. Blank keeps backend fallback: ${fallbackMarket}. This does not attribute returned sources to these markets.`,
    },
    {
      key: "languages",
      label: "Languages",
      help: `One language/code per line. Blank uses ${scopeDefaults.languages.join(", ")}. Unknown source language remains unknown.`,
    },
  ];

  const customLists: { key: ScopeListField; label: string; help: string }[] = [
    {
      key: "keywords",
      label: "Keywords",
      help: "One phrase per line. Blank adds no extra keywords; agents still use their standard scope-based queries. Commas within a phrase are preserved.",
    },
    {
      key: "urls",
      label: "Source URLs",
      help: "One complete URL per line. Blank supplies no explicit URLs; search agents discover sources normally. URLs are collection inputs, not verified evidence. Never include credentials.",
    },
  ];

  return (
    <div data-testid="research-configuration" className="flex flex-col gap-4">
      {/* Category quick-navigation tabs */}
      <nav
        aria-label="Research categories"
        className="flex items-center gap-1 rounded-lg border border-line bg-panel-2 p-1 text-xs"
      >
        <button
          type="button"
          onClick={() => selectTab("all")}
          className={cx(
            "flex-1 rounded-md px-2 py-1 font-medium transition cursor-pointer text-center",
            activeTab === "all" ? "bg-panel text-ink shadow-xs" : "text-muted hover:text-ink",
          )}
        >
          Alle
        </button>
        <button
          type="button"
          onClick={() => selectTab("basis")}
          className={cx(
            "flex-1 rounded-md px-2 py-1 font-medium transition cursor-pointer text-center",
            activeTab === "basis" ? "bg-panel text-ink shadow-xs" : "text-muted hover:text-ink",
          )}
        >
          1. Basis
        </button>
        <button
          type="button"
          onClick={() => selectTab("depth")}
          className={cx(
            "flex-1 rounded-md px-2 py-1 font-medium transition cursor-pointer text-center",
            activeTab === "depth" ? "bg-panel text-ink shadow-xs" : "text-muted hover:text-ink",
          )}
        >
          2. Tiefe
        </button>
        <button
          type="button"
          onClick={() => selectTab("custom")}
          className={cx(
            "relative flex-1 rounded-md px-2 py-1 font-medium transition cursor-pointer text-center",
            activeTab === "custom" ? "bg-panel text-ink shadow-xs" : "text-muted hover:text-ink",
          )}
        >
          3. Custom
          {dirty && (
            <span
              title="Unapplied scope draft"
              className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand"
            />
          )}
        </button>
      </nav>

      {/* Kategorie 1: Standard / Basis */}
      <CategorySection
        id="basis"
        number={1}
        title="Standard & Basis"
        subtitle="Forschungsfrage, Quellen & Fahrzeug"
        badge={
          <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-xs text-muted">
            {agents.length} Agenten
          </span>
        }
        isOpen={openSections.basis}
        onToggle={() => toggleSection("basis")}
        hidden={activeTab !== "all" && activeTab !== "basis"}
      >
        <div className="flex flex-col gap-4">
          {/* Forschungsfrage */}
          <ParamField block={block} spec={questionSpec} />

          {/* Quellen & Agenten */}
          <div className="flex flex-col gap-3 border-t border-line/60 pt-3">
            <h5 className="text-xs font-semibold tracking-wider text-muted uppercase">
              Quellen & Agenten
            </h5>
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
                      changeAgents(
                        selectSocialMedia(agents, event.target.value as SocialMediaSelection),
                      );
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
              Research agents select collectors. Selecting agents never enables a provider or grants
              permission. Configure authorized access in Settings.
            </p>
            <details className="text-xs text-muted">
              <summary className="cursor-pointer font-medium hover:text-ink">
                Legacy “Look at” categories
              </summary>
              <div className="mt-2">
                <ParamField
                  block={block}
                  spec={{
                    ...sourcesSpec,
                    label: "Look at (legacy)",
                    help: "Legacy source categories. Research agents above select the actual collectors.",
                  }}
                />
              </div>
            </details>
          </div>

          {/* Fahrzeug & Märkte */}
          <div className="flex flex-col gap-3 border-t border-line/60 pt-3">
            <h5 className="text-xs font-semibold tracking-wider text-muted uppercase">
              Fahrzeug & Märkte
            </h5>
            <ParamField
              block={block}
              spec={{
                ...marketSpec,
                label: "Fallback market (legacy)",
                help: "Used only when the Research scope has no Markets override. The scope form writes only scopeJson.",
              }}
            />
            {draft.mode === "form" && draft.form ? (
              <>
                {textFields.map(({ key, label, help, placeholder }) => (
                  <Field key={key} label={label} help={help}>
                    {(id) => (
                      <TextInput
                        id={id}
                        data-testid={`research-scope-${key}`}
                        value={draft.form![key]}
                        placeholder={placeholder}
                        onChange={(value) => updateForm({ ...draft.form!, [key]: value })}
                      />
                    )}
                  </Field>
                ))}
                {vehicleLists.map(({ key, label, help }) => (
                  <Field key={key} label={label} help={help}>
                    {(id) => (
                      <TextArea
                        id={id}
                        data-testid={`research-scope-${key}`}
                        rows={2}
                        value={draft.form![key]}
                        onChange={(value) => updateForm({ ...draft.form!, [key]: value })}
                      />
                    )}
                  </Field>
                ))}
              </>
            ) : (
              <div className="rounded-lg border border-line bg-panel-2 p-2.5 text-xs text-muted">
                Advanced JSON-Modus ist aktiv. Fahrzeug- und Markt-Filter werden über das JSON in
                Kategorie 3 gesteuert.
              </div>
            )}
          </div>
        </div>
      </CategorySection>

      {/* Kategorie 2: Gründlichkeit & Tiefe */}
      <CategorySection
        id="depth"
        number={2}
        title="Gründlichkeit & Tiefe"
        subtitle="Ergebnisse, Zeitspanne, Limits & Dokumente"
        badge={
          <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-xs text-muted">
            {Number(block.params.maxResults ?? 10)} Ergeb. · {Number(block.params.concurrency ?? 3)}{" "}
            parallel
          </span>
        }
        isOpen={openSections.depth}
        onToggle={() => toggleSection("depth")}
        hidden={activeTab !== "all" && activeTab !== "depth"}
      >
        <div className="flex flex-col gap-4">
          {/* Ergebnisse & Parallelität */}
          <div className="flex flex-col gap-3">
            <h5 className="text-xs font-semibold tracking-wider text-muted uppercase">
              Ergebnisse & Parallelität
            </h5>
            <ParamField block={block} spec={maxResultsSpec} />
            <ParamField block={block} spec={concurrencySpec} />
          </div>

          {/* Zeitspanne & Publikationsfilter */}
          <div className="flex flex-col gap-3 border-t border-line/60 pt-3">
            <h5 className="text-xs font-semibold tracking-wider text-muted uppercase">
              Zeitspanne & Publikationsfilter
            </h5>
            <ParamField block={block} spec={maxAgeMonthsSpec} />
            {draft.mode === "form" && draft.form ? (
              <>
                {(["publishedFrom", "publishedTo"] as const).map((key) => (
                  <Field
                    key={key}
                    label={key === "publishedFrom" ? "Published from" : "Published to"}
                    help={
                      key === "publishedFrom"
                        ? `Leave blank to use Max. age: ${Number(block.params.maxAgeMonths ?? 24)} months before the run date.`
                        : "Leave blank for no publication end-date restriction; there is no default."
                    }
                  >
                    {(id) => (
                      <TextInput
                        id={id}
                        type="date"
                        data-testid={`research-scope-${key}`}
                        value={draft.form![key]}
                        onChange={(value) => updateForm({ ...draft.form!, [key]: value })}
                      />
                    )}
                  </Field>
                ))}
              </>
            ) : null}
          </div>

          {/* Limits & Timeouts */}
          <div className="flex flex-col gap-3 border-t border-line/60 pt-3">
            <h5 className="text-xs font-semibold tracking-wider text-muted uppercase">
              Limits & Timeouts
            </h5>
            <ParamField block={block} spec={maxRequestsSpec} />
            <ParamField block={block} spec={timeoutMsSpec} />
            <ParamField block={block} spec={maxDocumentPagesSpec} />
          </div>

          {/* Modell & Dokumente */}
          <div className="flex flex-col gap-3 border-t border-line/60 pt-3">
            <h5 className="text-xs font-semibold tracking-wider text-muted uppercase">
              Query-Planung & Dokumente
            </h5>
            <ParamField block={block} spec={queryPlanningSpec} />
            <ParamField block={block} spec={documentSpec} />
          </div>
        </div>
      </CategorySection>

      {/* Kategorie 3: Custom Prompt & Feineinstellung */}
      <CategorySection
        id="custom"
        number={3}
        title="Custom Prompt & Feineinstellung"
        subtitle="Keywords, URLs, Wettbewerber, JSON & Actions"
        badge={
          dirty ? (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-500">
              Entwurf
            </span>
          ) : (
            <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-xs text-muted">
              Synchronisiert
            </span>
          )
        }
        isOpen={openSections.custom}
        onToggle={() => toggleSection("custom")}
        hidden={activeTab !== "all" && activeTab !== "custom"}
      >
        <section
          data-testid="research-scope"
          aria-label="Research scope"
          className="flex flex-col gap-4"
        >
          {/* Mode Switcher */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold tracking-wider text-muted uppercase">
              Scope-Modus
            </span>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant={draft.mode === "form" ? "primary" : "secondary"}
                aria-pressed={draft.mode === "form"}
                data-testid="research-scope-form-toggle"
                onClick={() => switchMode("form")}
              >
                Scope form
              </Button>
              <Button
                size="sm"
                variant={draft.mode === "json" ? "primary" : "secondary"}
                aria-pressed={draft.mode === "json"}
                data-testid="research-scope-advanced-toggle"
                onClick={() => switchMode("json")}
              >
                Advanced JSON
              </Button>
            </div>
          </div>

          {draft.mode === "form" && draft.form ? (
            <>
              {customLists.map(({ key, label, help }) => (
                <ScopeList
                  key={key}
                  field={key}
                  label={label}
                  help={help}
                  form={draft.form!}
                  onChange={updateForm}
                />
              ))}

              <details
                className="flex flex-col text-sm text-ink"
                open={draft.form.competitors.length > 0}
              >
                <summary className="cursor-pointer font-medium hover:text-brand">
                  Competitors · {draft.form.competitors.length}
                </summary>
                <div data-testid="research-scope-competitors" className="mt-3 flex flex-col gap-3">
                  <p className="text-xs text-muted">
                    Optional operator-selected comparison vehicles. If left empty, Research agents
                    autonomously identify direct segment competitors based on the vehicle model and
                    market context.
                  </p>
                  {draft.form.competitors.map((competitor, index) => (
                    <fieldset
                      key={index}
                      className="flex flex-col gap-2 rounded-lg border border-line p-3"
                    >
                      <legend className="px-1 text-xs text-muted">Competitor {index + 1}</legend>
                      {(["brand", "model", "generation"] as const).map((key) => (
                        <Field
                          key={key}
                          label={`${key === "brand" ? "Brand" : key === "model" ? "Model" : "Generation (optional)"} · competitor ${index + 1}`}
                          help={
                            key === "generation"
                              ? "Leave blank to keep this competitor's generation unspecified; there is no default."
                              : "Required for an added competitor; there is no default. Remove the competitor to omit it."
                          }
                        >
                          {(id) => (
                            <TextInput
                              id={id}
                              data-testid={`research-competitor-${index}-${key}`}
                              value={competitor[key]}
                              onChange={(value) =>
                                updateForm({
                                  ...draft.form!,
                                  competitors: draft.form!.competitors.map((item, i) =>
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
                          updateForm({
                            ...draft.form!,
                            competitors: draft.form!.competitors.filter((_, i) => i !== index),
                          })
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
                      updateForm({
                        ...draft.form!,
                        competitors: [
                          ...draft.form!.competitors,
                          { brand: "", model: "", generation: "" },
                        ],
                      })
                    }
                  >
                    Add competitor
                  </Button>
                </div>
              </details>
            </>
          ) : (
            <Field
              label="Advanced research scope (JSON)"
              help="Use {} for defaults with no overrides; empty text is not valid JSON. Documents, Eurostat datasets, domains, questions and horizon remain supported. Unknown/invalid fields are kept visible but must pass ResearchScope before acceptance."
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
            <p
              data-testid="research-scope-error"
              role="alert"
              className="text-xs font-medium text-danger"
            >
              {draft.error}
            </p>
          )}
          {dirty && (
            <p role="status" className="text-xs font-medium text-amber-500">
              Scope draft not applied. Apply scope before starting a run.
            </p>
          )}

          <div className="flex flex-wrap gap-2 border-t border-line pt-2">
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
      </CategorySection>
    </div>
  );
}

function CategorySection({
  id,
  number,
  title,
  subtitle,
  badge,
  isOpen,
  onToggle,
  hidden,
  children,
}: {
  id: string;
  number: number;
  title: string;
  subtitle: string;
  badge?: React.ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  hidden?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={`research-category-${id}`}
      className={cx(
        "flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-xs transition-all",
        hidden && "hidden",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-3 text-left transition select-none hover:bg-panel-2"
        aria-expanded={isOpen}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-brand/10 text-xs font-bold text-brand">
            {number}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink leading-tight">{title}</div>
            <div className="mt-0.5 truncate text-xs text-muted leading-tight">{subtitle}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {badge}
          <span className="text-muted">
            {isOpen ? (
              <ChevronDownIcon className="size-4" />
            ) : (
              <ChevronRightIcon className="size-4" />
            )}
          </span>
        </div>
      </button>
      <div
        className={cx(
          "flex flex-col gap-4 border-t border-line/60 bg-panel p-3.5",
          !isOpen && "hidden",
        )}
      >
        {children}
      </div>
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
