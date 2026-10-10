import { z } from "zod";
import { ProductScope } from "./scope";
import { PriorityThresholds, ScoreWeights } from "./scoring";

/** "mock" returns canned, schema-valid output so the app runs offline and in tests. */
export const LlmProvider = z.enum(["anthropic", "mock"]);
export type LlmProvider = z.infer<typeof LlmProvider>;

export const ResearchProvider = z.enum(["anthropic_web_search", "tavily", "off"]);
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
  }),
  research: z.object({
    provider: ResearchProvider,
    maxResultsPerQuery: z.number().int().min(1).max(50),
    allowedDomains: z.array(z.string()), // empty = any
    blockedDomains: z.array(z.string()),
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
