import {
  ResearchProviderConfig,
  ResearchProviderStatus,
  type ConnectionReport,
  type ReqflowApi,
  type ResearchProviderId,
  type SecretName,
} from "@reqflow/core";
import { ReqflowError } from "../../../lib/bridge-client";

export interface CredentialDefinition {
  name: SecretName;
  label: string;
  optional?: boolean;
}

export interface ProviderCardDefinition {
  id: ResearchProviderId;
  label: string;
  group: "Web search" | "Social & community" | "Studies & documents";
  description: string;
  docs?: string;
  credentials: readonly CredentialDefinition[];
}

export const RESEARCH_PROVIDER_CARDS: readonly ProviderCardDefinition[] = [
  {
    id: "firecrawl",
    label: "Firecrawl",
    group: "Web search",
    description: "Web search and page extraction for reviews, competitors, and trends.",
    docs: "https://docs.firecrawl.dev/",
    credentials: [{ name: "firecrawl_api_key", label: "Firecrawl API key" }],
  },
  {
    id: "tavily",
    label: "Tavily · alternative",
    group: "Web search",
    description:
      "Alternative web search access. Saving a key does not change the selected search provider.",
    docs: "https://docs.tavily.com/",
    credentials: [{ name: "tavily_api_key", label: "Tavily API key" }],
  },
  {
    id: "youtube",
    label: "YouTube",
    group: "Social & community",
    description:
      "YouTube Data API access. Available content and transcripts depend on the provider's capabilities.",
    docs: "https://developers.google.com/youtube/v3/getting-started",
    credentials: [{ name: "youtube_api_key", label: "YouTube API key" }],
  },
  {
    id: "apify",
    label: "Apify · Instagram & TikTok",
    group: "Social & community",
    description:
      "Access through explicitly allowed actors. Platform approval and actor selection are separate from connection testing.",
    docs: "https://docs.apify.com/platform/integrations/api",
    credentials: [{ name: "apify_api_token", label: "Apify API token" }],
  },
  {
    id: "x",
    label: "X",
    group: "Social & community",
    description:
      "Recent or full-archive post search. Your X plan must permit the selected search mode.",
    docs: "https://docs.x.com/x-api/posts/search/introduction",
    credentials: [{ name: "x_bearer_token", label: "X bearer token" }],
  },
  {
    id: "reddit",
    label: "Reddit",
    group: "Social & community",
    description:
      "OAuth access for approved research clients. A successful test does not grant Reddit's required approval.",
    docs: "https://www.reddit.com/wiki/api/",
    credentials: [
      { name: "reddit_client_id", label: "Reddit client ID" },
      { name: "reddit_client_secret", label: "Reddit client secret" },
      { name: "reddit_refresh_token", label: "Reddit refresh token" },
    ],
  },
  {
    id: "openalex",
    label: "OpenAlex",
    group: "Studies & documents",
    description:
      "Scholarly metadata and study discovery. The optional key can affect access and quotas; the test reports actual capabilities.",
    docs: "https://docs.openalex.org/how-to-use-the-api/api-overview",
    credentials: [{ name: "openalex_api_key", label: "OpenAlex API key", optional: true }],
  },
  {
    id: "eurostat",
    label: "Eurostat",
    group: "Studies & documents",
    description:
      "Public EU statistics. No API key required; select datasets in the research workflow.",
    docs: "https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-introduction",
    credentials: [],
  },
  {
    id: "local_documents",
    label: "Local documents",
    group: "Studies & documents",
    description:
      "Previously imported, selected documents. No API key or external connection required. Import and select documents in Data Flow.",
    credentials: [],
  },
];

export const CONNECTION_LABELS: Record<ConnectionReport["state"], string> = {
  not_configured: "Access not configured",
  untested: "Not tested",
  success: "Connection test successful",
  invalid_credentials: "Invalid credentials",
  permission_required: "Permission required",
  rate_limited: "Rate limited",
  unreachable: "Provider unreachable",
  unsupported: "Not supported",
};

/** Only structured IPC errors carry messages sanitized by main. Never stringify payloads. */
export function settingsErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ReqflowError && error.message ? error.message : fallback;
}

/** A blank Save is a no-op, never the null used by explicit Remove. */
export function nonEmptySecretDraft(draft: string): string | null {
  return draft.trim() || null;
}

export function validateRedditUserAgent(draft: string): string | null {
  const value = draft.trim();
  if (value.length < 10 || value.length > 200) return "Use 10–200 characters for the user-agent.";
  if (!/^[^\s:]+:[^\s:]+:[^\s]+ \(by \/u\/[A-Za-z0-9_-]+\)$/.test(value)) {
    return "Use platform:app:version (by /u/your_reddit_username), identifying your approved client.";
  }
  return null;
}

interface ResearchSettingsSnapshot {
  statuses: ResearchProviderStatus[] | null;
  drafts: Partial<Record<SecretName, string>>;
  pending: string | null;
  error: string | null;
  notice: string | null;
}

type ResearchSettingsClient = {
  research: Pick<ReqflowApi["research"], "providers" | "configure" | "test">;
  settings: Pick<ReqflowApi["settings"], "setSecret">;
};

/** One operation at a time: whole-list refreshes cannot overwrite a concurrent mutation. */
export function createResearchSettingsController(
  client: ResearchSettingsClient,
  reloadResearchApis: () => Promise<void>,
) {
  let snapshot: ResearchSettingsSnapshot = {
    statuses: null,
    drafts: {},
    pending: null,
    error: null,
    notice: null,
  };
  let active = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  const current = (token: number) => active && generation === token;
  const publish = (patch: Partial<ResearchSettingsSnapshot>, token = generation) => {
    if (!current(token)) return;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const readStatuses = async (token: number) => {
    const statuses = ResearchProviderStatus.array().parse(await client.research.providers());
    publish({ statuses }, token);
  };
  const replaceStatus = (id: ResearchProviderId, input: ResearchProviderStatus, token: number) => {
    const status = ResearchProviderStatus.parse(input);
    if (status.id !== id) throw new Error("Unexpected provider response");
    publish(
      { statuses: snapshot.statuses?.map((item) => (item.id === id ? status : item)) ?? null },
      token,
    );
  };
  const run = async (pending: string, work: (token: number) => Promise<void>) => {
    if (!active || snapshot.pending) return;
    const token = generation;
    publish({ pending, error: null, notice: null }, token);
    try {
      await work(token);
    } catch (error) {
      publish(
        {
          drafts: {},
          error: settingsErrorMessage(
            error,
            "The action could not be completed. Retry or reload the provider status.",
          ),
        },
        token,
      );
    } finally {
      publish({ pending: null }, token);
    }
  };
  const configured = (name: SecretName) =>
    snapshot.statuses?.some((status) => status.credentialsConfigured[name] === true) === true;

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate() {
      active = true;
      generation++;
    },
    deactivate() {
      active = false;
      generation++;
      // Discard credential drafts even when React replays effects in StrictMode.
      snapshot = { ...snapshot, drafts: {}, pending: null };
    },
    refresh: () => run("Loading provider status…", readStatuses),
    setDraft(name: SecretName, draft: string) {
      if (active && !snapshot.pending) publish({ drafts: { ...snapshot.drafts, [name]: draft } });
    },
    saveSecret(name: SecretName) {
      const value = nonEmptySecretDraft(snapshot.drafts[name] ?? "");
      if (value === null) return Promise.resolve();
      return run("Saving credential…", async (token) => {
        publish({ drafts: { ...snapshot.drafts, [name]: "" } }, token);
        await client.settings.setSecret(name, value);
        publish(
          {
            drafts: { ...snapshot.drafts, [name]: "" },
            notice: "Credential saved. The provider was not enabled or tested.",
          },
          token,
        );
        if (current(token)) await readStatuses(token);
      });
    },
    removeSecret(name: SecretName) {
      if (!configured(name)) return Promise.resolve();
      return run("Removing credential…", async (token) => {
        publish({ drafts: { ...snapshot.drafts, [name]: "" } }, token);
        await client.settings.setSecret(name, null);
        publish(
          {
            drafts: { ...snapshot.drafts, [name]: "" },
            notice:
              "Saved credential removed. Environment credentials, if present, may still be configured.",
          },
          token,
        );
        if (current(token)) await readStatuses(token);
      });
    },
    configure(id: ResearchProviderId, patch: Partial<ResearchProviderConfig>) {
      const status = snapshot.statuses?.find((item) => item.id === id);
      if (!status) return Promise.resolve();
      return run("Saving provider settings…", async (token) => {
        const config = ResearchProviderConfig.parse({ ...status.config, ...patch });
        if (patch.redditUserAgent !== undefined && validateRedditUserAgent(patch.redditUserAgent)) {
          throw new Error("Invalid user-agent");
        }
        const updated = await client.research.configure(id, config);
        try {
          replaceStatus(id, updated, token);
          publish({ notice: "Provider settings saved. No research was started." }, token);
        } finally {
          // Reconcile only main-owned APIs, including after unmount. Do not replace
          // dirty general settings or cancel the store's pending autosave.
          await reloadResearchApis();
        }
      });
    },
    test(id: ResearchProviderId) {
      if (!snapshot.statuses?.some((status) => status.id === id)) return Promise.resolve();
      return run("Testing connection…", async (token) => {
        replaceStatus(id, await client.research.test(id), token);
      });
    },
  };
}

export type ResearchSettingsController = ReturnType<typeof createResearchSettingsController>;
