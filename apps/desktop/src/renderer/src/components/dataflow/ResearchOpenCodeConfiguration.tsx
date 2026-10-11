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

type CategoryTab = "all" | "basis" | "depth" | "cli";

function getParamSpec(key: string): ParamSpec {
  const spec = BLOCK_SPECS.research_opencode.params.find((param) => param.key === key);
  if (!spec) throw new Error(`Missing spec for research_opencode param: ${key}`);
  return spec;
}

export function ResearchOpenCodeConfiguration({ block }: { block: WorkflowBlock }) {
  const [activeTab, setActiveTab] = useState<CategoryTab>("all");
  const [openSections, setOpenSections] = useState({
    basis: true,
    depth: true,
    cli: true,
  });
  const [agentError, setAgentError] = useState<string | null>(null);

  const llmSettings = useSettings((state) => state.settings.llm);
  const settingsScope = useSettings((state) => state.settings.defaultScope);

  const agentSpec = getParamSpec("agents");
  const questionSpec = getParamSpec("question");
  const sourcesSpec = getParamSpec("sources");
  const marketSpec = getParamSpec("market");
  const maxResultsSpec = getParamSpec("maxResults");
  const timeoutMsSpec = getParamSpec("timeoutMs");
  const workingDirSpec = getParamSpec("workingDir");
  const autoApproveSpec = getParamSpec("autoApprove");
  const installSkillSpec = getParamSpec("installSkill");

  const agents = Array.isArray(block.params.agents) ? (block.params.agents as string[]) : [];
  let existingAgentError: string | null = null;
  try {
    validateResearchAgents(block.params.agents);
  } catch (error) {
    existingAgentError = message(error);
  }

  const rawScope = typeof block.params.scopeJson === "string" ? block.params.scopeJson : "{}";
  const [draft, setDraft] = useState<ScopeDraft>(() => initialScopeDraft(rawScope));
  const [dirty, setDirty] = useState(false);

  const initial = useMemo(() => initialScopeDraft(rawScope), [rawScope]);
  if (initial.baseJson !== draft.baseJson) {
    setDraft(initial);
    setDirty(false);
  }

  const updateParam = (key: string, value: unknown) => {
    dataflowStore.getState().setParams(block.id, {
      ...block.params,
      [key]: value,
    });
  };

  const updateAgents = (next: readonly string[]) => {
    try {
      const validated = validateResearchAgents(next);
      setAgentError(null);
      updateParam("agents", validated);
    } catch (error) {
      setAgentError(message(error));
    }
  };

  const updateSocialMedia = (selection: SocialMediaSelection) => {
    try {
      const validated = selectSocialMedia(agents, selection);
      setAgentError(null);
      updateParam("agents", validated);
    } catch (error) {
      setAgentError(message(error));
    }
  };

  const switchMode = (mode: "form" | "json") => {
    if (mode === "form") {
      try {
        const form = scopeFormFromJson(draft.json);
        setDraft({ ...draft, form, mode, error: null });
      } catch (error) {
        setDraft({ ...draft, error: message(error) });
      }
    } else {
      setDraft({ ...draft, mode });
    }
  };

  const updateForm = (form: ResearchScopeForm) => {
    const json = scopeJsonFromForm(draft.baseJson, form);
    setDraft({ ...draft, form, json, error: null });
    setDirty(true);
  };

  const apply = () => {
    try {
      validateScopeJson(draft.json);
      updateParam("scopeJson", draft.json);
      setDirty(false);
      setDraft({ ...draft, baseJson: draft.json, error: null });
    } catch (error) {
      setDraft({ ...draft, error: message(error) });
    }
  };

  const toggleSection = (id: "basis" | "depth" | "cli") => {
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const activeModelDisplay =
    llmSettings.provider === "mock"
      ? "Offline Mock"
      : `${llmSettings.provider.toUpperCase()} (${llmSettings.model})`;

  const customLists: { key: ScopeListField; label: string; help: string }[] = [
    {
      key: "keywords",
      label: "Steering keywords",
      help: "One topic per line. High-priority terms that must appear in queries and matched evidence.",
    },
    {
      key: "urls",
      label: "Seed & sample URLs",
      help: "One URL per line. Specific articles, competitor comparisons or discussion threads to prioritize.",
    },
    {
      key: "languages",
      label: "Languages",
      help: "One language code per line (e.g. de, en, zh).",
    },
    {
      key: "markets",
      label: "Markets",
      help: "One market code per line (e.g. EU, US, CN).",
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* OpenCode Banner */}
      <div className="rounded-xl border border-brand/30 bg-brand/5 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-mono text-xs font-semibold text-brand">
            <span className="inline-block size-2 rounded-full bg-emerald-500 animate-pulse" />
            OPENCODE CLI AUTONOMOUS AGENT
          </span>
          <span className="rounded bg-panel px-2 py-0.5 font-mono text-[10px] text-muted border border-line">
            Model: {activeModelDisplay}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Runs an autonomous CLI subagent via <code className="text-ink">opencode run --auto</code>.
          Leverages <code className="text-ink">mattpocock/skills/research</code> and produces
          standard Excel workbooks (<code className="text-ink">research_*.xlsx</code>) streaming
          into ReqFlow.
        </p>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center justify-between border-b border-line pb-2">
        <span className="text-xs font-semibold tracking-wider text-muted uppercase">
          Kategorien
        </span>
        <div className="flex gap-1">
          {(
            [
              { id: "all", label: "Alle" },
              { id: "basis", label: "1. Basis" },
              { id: "depth", label: "2. Limits" },
              { id: "cli", label: "3. CLI & Scope" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setActiveTab(tab.id);
                if (tab.id !== "all") {
                  setOpenSections((prev) => ({ ...prev, [tab.id]: true }));
                }
              }}
              className={cx(
                "cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition",
                activeTab === tab.id
                  ? "bg-brand text-brand-contrast shadow-xs"
                  : "bg-panel text-muted hover:bg-panel-2 hover:text-ink",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Kategorie 1: Basis-Einstellungen */}
      <CategorySection
        id="basis"
        number={1}
        title="Basis-Einstellungen"
        subtitle="Agenten, Focus Question, Quellen & Markt"
        isOpen={openSections.basis}
        onToggle={() => toggleSection("basis")}
        hidden={activeTab !== "all" && activeTab !== "basis"}
      >
        <div className="flex flex-col gap-4">
          <Field
            label={agentSpec.label}
            help={agentSpec.help}
            error={agentError ?? existingAgentError}
          >
            {() => (
              <ChipSelect
                options={agentSpec.type === "multiselect" ? agentSpec.options : []}
                value={agents}
                onChange={updateAgents}
              />
            )}
          </Field>

          <Field
            label="Social media preset"
            help="Shortcut to quickly toggle social media sources (Reddit, YouTube, Instagram, TikTok, X)."
          >
            {(id) => (
              <select
                id={id}
                value={socialMediaSelection(agents)}
                onChange={(event) => updateSocialMedia(event.target.value as SocialMediaSelection)}
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

          <ParamField block={block} spec={questionSpec} />
          <ParamField block={block} spec={sourcesSpec} />
          <ParamField block={block} spec={marketSpec} />
        </div>
      </CategorySection>

      {/* Kategorie 2: Gründlichkeit & Limits */}
      <CategorySection
        id="depth"
        number={2}
        title="Gründlichkeit & Limits"
        subtitle="Max Findings, Process Timeout"
        isOpen={openSections.depth}
        onToggle={() => toggleSection("depth")}
        hidden={activeTab !== "all" && activeTab !== "depth"}
      >
        <div className="flex flex-col gap-4">
          <ParamField block={block} spec={maxResultsSpec} />
          <ParamField block={block} spec={timeoutMsSpec} />
        </div>
      </CategorySection>

      {/* Kategorie 3: OpenCode CLI & Scope Steering */}
      <CategorySection
        id="cli"
        number={3}
        title="CLI Parameter & Custom Steering"
        subtitle="Working Dir, Flags & Research Scope"
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
        isOpen={openSections.cli}
        onToggle={() => toggleSection("cli")}
        hidden={activeTab !== "all" && activeTab !== "cli"}
      >
        <div className="flex flex-col gap-4">
          <ParamField block={block} spec={workingDirSpec} />
          <ParamField block={block} spec={autoApproveSpec} />
          <ParamField block={block} spec={installSkillSpec} />

          <section
            data-testid="research-scope"
            aria-label="Research scope"
            className="flex flex-col gap-4 border-t border-line pt-4"
          >
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

                {/* Competitors list */}
                <details className="rounded-lg border border-line p-3">
                  <summary className="cursor-pointer text-xs font-semibold text-ink">
                    Competitors ({draft.form.competitors.length})
                  </summary>
                  <div className="mt-3 flex flex-col gap-3">
                    {draft.form.competitors.map((item, index) => (
                      <fieldset
                        key={index}
                        className="flex flex-col gap-2 rounded border border-line p-2 text-xs"
                      >
                        <legend className="px-1 text-muted">Competitor {index + 1}</legend>
                        {(["brand", "model", "generation"] as const).map((key) => (
                          <Field key={key} label={key.toUpperCase()}>
                            {(id) => (
                              <TextInput
                                id={id}
                                value={item[key]}
                                onChange={(value) =>
                                  updateForm({
                                    ...draft.form!,
                                    competitors: draft.form!.competitors.map((c, i) =>
                                      i === index ? { ...c, [key]: value } : c,
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
                help="Use {} for defaults with no overrides. Custom JSON steering applied directly to OpenCode prompts."
              >
                {(id) => (
                  <TextArea
                    id={id}
                    data-testid="research-scope-json"
                    rows={10}
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
        </div>
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

      {isOpen && <div className="border-t border-line/60 bg-panel/50 p-4">{children}</div>}
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
