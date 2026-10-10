import { z } from "zod";
import { AGENT_ROLES, AgentRole } from "./reasoning";
import { ProductScope } from "./scope";
import { PriorityThresholds, ScoreWeights } from "./scoring";
import { ResearchApiSettings, DEFAULT_RESEARCH_APIS } from "./research";

/** "mock" returns canned, schema-valid output so the app runs offline and in tests. */
export const LlmProvider = z.enum(["anthropic", "openai", "google", "mock"]);
export type LlmProvider = z.infer<typeof LlmProvider>;

export const LiveLlmProvider = z.enum(["anthropic", "openai", "google"]);
export type LiveLlmProvider = z.infer<typeof LiveLlmProvider>;
export const LlmModels = z.object({
  model: z.string().trim().min(1).max(200),
  fastModel: z.string().trim().min(1).max(200),
});
export type LlmModels = z.infer<typeof LlmModels>;
export const LLM_MODEL_DEFAULTS: Record<LiveLlmProvider, LlmModels> = {
  anthropic: { model: "claude-opus-5-5", fastModel: "claude-haiku-5-5" },
  openai: { model: "gpt-4.1-2025-04-14", fastModel: "gpt-4.1-mini-2025-04-14" },
  google: { model: "gemini-3.8-flash", fastModel: "gemini-3.5-flash-lite" },
};
export const LLM_SECRET_NAMES = {
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
  google: "google_api_key",
} as const;

export const ResearchProvider = z.enum(["firecrawl", "anthropic_web_search", "tavily", "off"]);
export type ResearchProvider = z.infer<typeof ResearchProvider>;

export const ThemePreference = z.enum(["system", "light", "dark"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

/** Language of AI-written text (findings, requirements). The UI itself is English. */
export const OutputLanguage = z.enum(["en", "de"]);
export type OutputLanguage = z.infer<typeof OutputLanguage>;

export const MemberRole = z.enum(["owner", "editor", "viewer"]);
export type MemberRole = z.infer<typeof MemberRole>;

/** A teammate. "invited" until they join; sending invitations needs the sync backend. */
export const TeamMember = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  email: z.email(),
  role: MemberRole,
  status: z.enum(["active", "invited"]),
});
export type TeamMember = z.infer<typeof TeamMember>;

/** Where shared workflows and decisions live: only this machine, a shared folder, or a Git repo. */
export const SharingMode = z.enum(["local", "shared_folder", "git"]);
export type SharingMode = z.infer<typeof SharingMode>;

/**
 * An API the Add to Car agents can use (Settings → AI → API setups). Its key is a secret named
 * `setup:<id>` in the OS keychain, never part of the settings.
 * - anthropic: Claude Messages API · openai / gemini / openai_compatible: Chat Completions API
 *   (OpenRouter, Azure, Ollama, LM Studio, … via base URL) · jev: TypeSafe's decision model,
 *   judge only · mock: offline, no AI.
 */
export const ApiProvider = z.enum([
  "anthropic",
  "openai",
  "gemini",
  "openai_compatible",
  "jev",
  "mock",
]);
export type ApiProvider = z.infer<typeof ApiProvider>;

export const API_PROVIDER_INFO: Record<
  ApiProvider,
  {
    label: string;
    baseUrl: string; // default endpoint; "" = must be entered
    needsKey: boolean;
    /** Can write (every agent role). Jev only answers the judge's typed questions. */
    writes: boolean;
  }
> = {
  anthropic: {
    label: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com",
    needsKey: true,
    writes: true,
  },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true, writes: true },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    needsKey: true,
    writes: true,
  },
  openai_compatible: {
    label: "OpenAI-compatible (OpenRouter, Azure, Ollama, …)",
    baseUrl: "",
    needsKey: false,
    writes: true,
  },
  jev: {
    label: "TypeSafe Jev (judge only)",
    baseUrl: "https://api.typesafe.ai/v1",
    needsKey: true,
    writes: false,
  },
  mock: { label: "Mock (offline, no AI)", baseUrl: "", needsKey: false, writes: true },
};

/** How hard reasoning models think before answering (extended thinking / reasoning effort). */
export const ReasoningEffort = z.enum(["off", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const ApiSetup = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Use lowercase letters, digits and dashes"),
    name: z.string().trim().min(1, "Give the setup a name").max(60),
    provider: ApiProvider,
    baseUrl: z
      .string()
      .trim()
      .max(300)
      .refine(
        (v) => v === "" || /^https?:\/\/\S+$/.test(v),
        "Enter an http(s) URL or leave it empty",
      ),
    model: z.string().trim().max(120), // quality model: synthesis, drafting, critique
    fastModel: z.string().trim().max(120), // bulk model: reading every item; "" = the quality model
    effort: ReasoningEffort,
    temperature: z.number().min(0).max(1),
    maxParallel: z.number().int().min(1).max(16), // concurrent calls; lower it on rate limits
  })
  .refine((s) => s.provider === "mock" || s.model.length > 0, {
    path: ["model"],
    message: "Enter the model to use",
  })
  .refine((s) => s.provider !== "openai_compatible" || s.baseUrl.length > 0, {
    path: ["baseUrl"],
    message: "OpenAI-compatible setups need a base URL",
  });
export type ApiSetup = z.infer<typeof ApiSetup>;

/** "default" = the provider and models above (Settings → AI); otherwise an ApiSetup id. */
export const DEFAULT_SETUP = "default";

export const AgentSettings = z
  .object({
    setups: z
      .array(ApiSetup)
      .max(12)
      .refine((xs) => new Set(xs.map((x) => x.id)).size === xs.length, "Setup ids must be unique")
      .refine(
        (xs) => new Set(xs.map((x) => x.name.toLowerCase())).size === xs.length,
        "Two setups have the same name",
      ),
    roles: z.object(
      Object.fromEntries(AGENT_ROLES.map((r) => [r, z.string().min(1)])) as Record<
        AgentRole,
        z.ZodString
      >,
    ),
  })
  .superRefine((agents, ctx) => {
    for (const role of AGENT_ROLES) {
      const id = agents.roles[role];
      if (id === DEFAULT_SETUP) continue;
      const setup = agents.setups.find((s) => s.id === id);
      if (!setup) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", role],
          message: "That API setup no longer exists",
        });
      } else if (role !== "judge" && !API_PROVIDER_INFO[setup.provider].writes) {
        ctx.addIssue({
          code: "custom",
          path: ["roles", role],
          message: `${API_PROVIDER_INFO[setup.provider].label} can only be the judge`,
        });
      }
    }
  });
export type AgentSettings = z.infer<typeof AgentSettings>;

/**
 * Everything the Settings page edits. API keys are NOT settings — they are stored encrypted in the
 * OS keychain by the main process (`settings.setSecret`); the UI only learns whether one is configured.
 */
export const Settings = z.object({
  app: z.object({
    theme: ThemePreference,
    snapToGrid: z.boolean(), // workplace
    showMinimap: z.boolean(), // workplace
    confirmBeforeDelete: z.boolean(),
  }),
  llm: z.object({
    provider: LlmProvider,
    model: z.string().min(1), // quality tier: clustering, derivation, challenge answers
    fastModel: z.string().min(1), // bulk tier: per-record signal extraction
    temperature: z.number().min(0).max(1),
    outputLanguage: OutputLanguage,
    /** Remember each provider's custom models; old settings without profiles remain valid. */
    modelProfiles: z.partialRecord(LiveLlmProvider, LlmModels).optional(),
  }),
  research: z.object({
    provider: ResearchProvider,
    maxResultsPerQuery: z.number().int().min(1).max(50),
    allowedDomains: z.array(z.string()), // empty = any
    blockedDomains: z.array(z.string()),
    apis: ResearchApiSettings,
  }),
  scoring: z.object({
    weights: ScoreWeights,
    thresholds: PriorityThresholds,
  }),
  review: z.object({
    // The prototype has no login: this identity is the human actor in the audit trail.
    reviewer: z.object({
      userId: z.string().min(1),
      name: z.string().min(1),
      role: z.string().min(1),
    }),
  }),
  /** API setups for the Add to Car agents, and which one each agent role uses. */
  agents: AgentSettings,
  /** The global vehicle and market. Blocks set to "From Settings" use these. */
  defaultScope: ProductScope,
  collaboration: z.object({
    members: z
      .array(TeamMember)
      .refine(
        (ms) => new Set(ms.map((m) => m.email.toLowerCase())).size === ms.length,
        "This person is already on the team",
      ),
    sharing: SharingMode,
    sharedLocation: z.string().max(500), // folder path or Git URL; empty while sharing is "local"
    notifyOnReview: z.boolean(), // tell teammates when a HIL block waits for them
    requireSecondApproval: z.boolean(), // four-eyes rule for approving requirements
  }),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  app: {
    theme: "system",
    snapToGrid: true,
    showMinimap: false,
    confirmBeforeDelete: true,
  },
  llm: {
    provider: "mock",
    model: "claude-opus-5-5",
    fastModel: "claude-haiku-5-5",
    temperature: 0.2,
    outputLanguage: "en",
  },
  research: {
    provider: "off",
    maxResultsPerQuery: 8,
    allowedDomains: [],
    blockedDomains: [],
    apis: DEFAULT_RESEARCH_APIS,
  },
  scoring: {
    weights: {
      customer_impact: 3,
      evidence_strength: 2,
      competitive_gap: 2,
      trend_momentum: 2,
      brand_fit: 1,
      ease: 1,
    },
    thresholds: { must: 70, should: 50, could: 30 },
  },
  review: {
    reviewer: { userId: "pm-demo", name: "Demo PM", role: "Product Manager" },
  },
  agents: {
    setups: [],
    roles: {
      context: DEFAULT_SETUP,
      analyst: DEFAULT_SETUP,
      synthesizer: DEFAULT_SETUP,
      architect: DEFAULT_SETUP,
      critic: DEFAULT_SETUP,
      judge: DEFAULT_SETUP,
    },
  },
  defaultScope: {
    vehicleLine: "1 Series",
    derivative: "5-door",
    vehicleCode: "F70",
    market: "EU",
    horizonYears: 5,
  },
  collaboration: {
    members: [],
    sharing: "local",
    sharedLocation: "",
    notifyOnReview: true,
    requireSecondApproval: false,
  },
};
