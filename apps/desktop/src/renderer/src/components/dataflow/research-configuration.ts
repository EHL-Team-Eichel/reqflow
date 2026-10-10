import { ResearchRequest, ResearchScope, type ResearchAgentId } from "@reqflow/core";

export const SOCIAL_AGENT_IDS = [
  "reddit",
  "youtube",
  "instagram",
  "tiktok",
  "x",
] as const satisfies readonly ResearchAgentId[];

export type SocialMediaSelection = (typeof SOCIAL_AGENT_IDS)[number] | "none" | "all" | "custom";

export const SOCIAL_MEDIA_OPTIONS: readonly { value: SocialMediaSelection; label: string }[] = [
  { value: "none", label: "None" },
  { value: "reddit", label: "Reddit" },
  { value: "youtube", label: "YouTube" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "x", label: "X" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

const socialIds = new Set<string>(SOCIAL_AGENT_IDS);

export function validateResearchAgents(value: unknown): ResearchAgentId[] {
  if (Array.isArray(value) && value.length === 0) {
    throw new Error("Select at least one research agent.");
  }
  const agents = ResearchRequest.shape.agents.parse(value);
  if (new Set(agents).size !== agents.length) {
    throw new Error("Each research agent may be selected only once.");
  }
  return agents;
}

/** This is a projection of agents, never another persisted parameter. */
export function socialMediaSelection(agents: readonly string[]): SocialMediaSelection {
  const selected = SOCIAL_AGENT_IDS.filter((id) => agents.includes(id));
  if (selected.length === 0) return "none";
  if (selected.length === SOCIAL_AGENT_IDS.length) return "all";
  return selected.length === 1 ? selected[0]! : "custom";
}

export function selectSocialMedia(
  agents: readonly string[],
  selection: SocialMediaSelection,
): ResearchAgentId[] {
  // Custom is a request to use the existing chips, not a predefined replacement set.
  if (selection === "custom") return validateResearchAgents(agents);
  const social = selection === "all" ? SOCIAL_AGENT_IDS : selection === "none" ? [] : [selection];
  return validateResearchAgents([...agents.filter((id) => !socialIds.has(id)), ...social]);
}

const TEXT_FIELDS = [
  "brand",
  "model",
  "currentGeneration",
  "previousGeneration",
  "derivative",
  "propulsion",
  "modelYear",
  "publishedFrom",
  "publishedTo",
] as const;
const LIST_FIELDS = ["markets", "languages", "keywords", "urls"] as const;
export type ScopeTextField = (typeof TEXT_FIELDS)[number];
export type ScopeListField = (typeof LIST_FIELDS)[number];
export type CompetitorFields = { brand: string; model: string; generation: string };
export type ResearchScopeForm = Record<ScopeTextField | ScopeListField, string> & {
  competitors: CompetitorFields[];
};

/** Validate the shared contract, but retain the sparse input rather than materializing defaults. */
export function readScopeJson(value: unknown): Record<string, unknown> {
  const json = value === undefined ? "{}" : value;
  if (typeof json !== "string") throw new Error("Advanced research scope must be a JSON string.");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("Advanced research scope must be valid JSON. Your text has not been replaced.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Advanced research scope must be a JSON object.");
  }
  const parsed = ResearchScope.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.length ? issue.path.join(".") : "Research scope"}: ${issue.message}`,
        )
        .join("; "),
    );
  }
  return raw as Record<string, unknown>;
}

export function validateScopeJson(json: string): string {
  readScopeJson(json);
  return json;
}

function formFromScope(scope: Record<string, unknown>): ResearchScopeForm {
  const fields = Object.fromEntries([
    ...TEXT_FIELDS.map((key) => [key, scope[key] ?? ""]),
    ...LIST_FIELDS.map((key) => [key, (scope[key] as string[] | undefined)?.join("\n") ?? ""]),
  ]) as Record<ScopeTextField | ScopeListField, string>;
  const competitors = scope.competitors as Partial<CompetitorFields>[] | undefined;
  return {
    ...fields,
    competitors: (competitors ?? []).map((competitor) => ({
      brand: competitor.brand ?? "",
      model: competitor.model ?? "",
      generation: competitor.generation ?? "",
    })),
  };
}

export function scopeFormFromJson(json: string): ResearchScopeForm {
  return formFromScope(readScopeJson(json));
}

/** Patch only edited form fields. Fields outside the form remain byte-for-value intact. */
export function scopeJsonFromForm(json: string, form: ResearchScopeForm): string {
  const original = readScopeJson(json);
  const before = formFromScope(original);
  const next = { ...original };
  for (const key of TEXT_FIELDS) {
    if (form[key] === before[key]) continue;
    const value = form[key].trim();
    if (value) next[key] = value;
    else delete next[key];
  }
  for (const key of LIST_FIELDS) {
    if (form[key] === before[key]) continue;
    const value = form[key]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (value.length) next[key] = value;
    else delete next[key];
  }
  if (JSON.stringify(form.competitors) !== JSON.stringify(before.competitors)) {
    if (form.competitors.length) {
      next.competitors = form.competitors.map((competitor) => ({
        brand: competitor.brand.trim(),
        model: competitor.model.trim(),
        ...(competitor.generation.trim() ? { generation: competitor.generation.trim() } : {}),
      }));
    } else delete next.competitors;
  }
  return validateScopeJson(JSON.stringify(next, null, 2));
}
