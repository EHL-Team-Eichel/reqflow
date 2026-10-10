import { describe, expect, it, vi } from "vitest";
import React, { createElement, type ButtonHTMLAttributes, type InputHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_RESEARCH_APIS,
  DEFAULT_SETTINGS,
  RESEARCH_PROVIDER_IDS,
  ResearchProviderStatus,
  type ReqflowApi,
  type ResearchProviderId,
  type SecretStatus,
  type Settings,
} from "@reqflow/core";
import { ReqflowError } from "../../../lib/bridge-client";
import { createSettingsStore } from "../../../lib/settings-store";
import { settingsStore, useSettings } from "../../../lib/settings";
import { Select } from "../../ui/controls";
import { AiSection } from "./AiSection";
import {
  CONNECTION_LABELS,
  RESEARCH_PROVIDER_CARDS,
  createResearchSettingsController,
  nonEmptySecretDraft,
  settingsErrorMessage,
  validateRedditUserAgent,
} from "./ResearchApisSection.helpers";
import { ConnectionDetails, CredentialInput, ResearchApisSection } from "./ResearchApisSection";

// The repo has no DOM test package or Vitest renderer aliases. Keep shared controls mocked
// at their component boundary; render the real section/credential markup with React DOM.
vi.mock("../../ui/Button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
    createElement("button", props),
}));
vi.mock("../../ui/controls", () => ({
  TextInput: ({
    onChange: _onChange,
    ...props
  }: Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
    onChange: (value: string) => void;
  }) => createElement("input", { ...props, onChange: () => {} }),
  Select: vi.fn(
    ({
      options,
      value,
      id,
      onChange,
    }: {
      options: readonly { value: string; label: string }[];
      value: string;
      id?: string;
      onChange: (value: string) => void;
    }) =>
      createElement(
        "select",
        {
          id,
          value,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
        },
        options.map((option) =>
          createElement("option", { key: option.value, value: option.value }, option.label),
        ),
      ),
  ),
  Toggle: () => null,
  NumberInput: () => null,
  Slider: () => null,
  TextArea: () => null,
  ValidatedTextInput: () => null,
}));
vi.mock("../../../lib/api", () => ({ api: {} }));
vi.mock("../../../lib/settings", () => ({
  settingsStore: { getState: vi.fn() },
  useSettings: vi.fn(),
}));
// Vitest does not load the desktop React Vite plugin; support its classic JSX transform.
vi.stubGlobal("React", React);

const status = (id: ResearchProviderId = "firecrawl") =>
  ResearchProviderStatus.parse({
    id,
    config: DEFAULT_RESEARCH_APIS[id],
    credentialsConfigured: {},
    connection: { state: "untested", message: "No connection test has run." },
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(initial = RESEARCH_PROVIDER_IDS.map((id) => status(id))) {
  const providers = vi.fn<ReqflowApi["research"]["providers"]>().mockResolvedValue(initial);
  const configure = vi
    .fn<ReqflowApi["research"]["configure"]>()
    .mockImplementation(async (id, config) => ({ ...status(id), config }));
  const test = vi.fn<ReqflowApi["research"]["test"]>().mockResolvedValue(status());
  const setSecret = vi
    .fn<ReqflowApi["settings"]["setSecret"]>()
    .mockResolvedValue({} as SecretStatus);
  const reloadSettings = vi.fn<() => Promise<void>>().mockResolvedValue();
  const controller = createResearchSettingsController(
    { research: { providers, configure, test }, settings: { setSecret } },
    reloadSettings,
  );
  controller.activate();
  return { controller, providers, configure, test, setSecret, reloadSettings };
}

describe("Research API presentation contract", () => {
  const renderAi = (provider: Settings["research"]["provider"] = "off") => {
    const store = createSettingsStore({
      settings: {
        get: vi.fn(),
        save: vi.fn(async (input: Settings) => input),
        secrets: vi.fn(),
        setSecret: vi.fn(),
        testSetup: vi.fn(),
      },
    });
    const settings = { ...DEFAULT_SETTINGS, research: { ...DEFAULT_SETTINGS.research, provider } };
    store.setState({ settings });
    const state = store.getState();
    vi.mocked(useSettings).mockImplementation((selector) => selector(state));
    vi.mocked(settingsStore.getState).mockReturnValue(state);
    vi.mocked(Select).mockClear();
    const html = renderToStaticMarkup(createElement(AiSection));
    const selection = vi
      .mocked(Select)
      .mock.calls.find(([props]) => props.id === "web-research-provider")?.[0];
    return { html, selection, store };
  };

  it("offers explicit Off, recommended Firecrawl and alternative Tavily web selection", () => {
    const { html, selection } = renderAi();
    expect(selection?.options.map((option) => option.value)).toEqual([
      "off",
      "firecrawl",
      "tavily",
    ]);
    expect(html).toContain("Firecrawl (recommended)");
    expect(html).toContain("Off (no web search)");
    expect(html).toContain("Other research providers are controlled independently");
    expect(html).toContain("Anthropic key");
    expect(html).toContain("off by default");
    expect(html).toContain("paid model calls");
    expect(html).toContain("cannot enable providers");
  });

  it("labels an existing legacy Claude web value as unsupported but never offers it for new selection", () => {
    const legacy = renderAi("anthropic_web_search");
    expect(legacy.html).toContain("Claude web search (legacy · unsupported)");
    expect(legacy.selection?.value).toBe("anthropic_web_search");
    expect(renderAi("firecrawl").selection?.options.map((option) => option.value)).not.toContain(
      "anthropic_web_search",
    );
  });

  it("validates web selection and changes only the provider, not API enablement or other settings", async () => {
    vi.useFakeTimers();
    try {
      const { selection, store } = renderAi("anthropic_web_search");
      expect(selection).toBeDefined();
      selection!.onChange("not-a-provider");
      expect(store.getState().settings.research.provider).toBe("anthropic_web_search");
      selection!.onChange("firecrawl");
      expect(store.getState().settings).toEqual({
        ...DEFAULT_SETTINGS,
        research: { ...DEFAULT_SETTINGS.research, provider: "firecrawl" },
      });
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(Object.keys(CONNECTION_LABELS) as (keyof typeof CONNECTION_LABELS)[])(
    "renders report code %s with its main message, capabilities, limitations, and test time",
    (state) => {
      const report = {
        state,
        message: "Sanitized provider message",
        testedAt: "2026-10-10T10:00:00.000Z",
        capabilities: ["Recent search only"],
        limitations: ["No archive permission"],
      };
      const html = renderToStaticMarkup(createElement(ConnectionDetails, { report }));
      expect(html).toContain(`<code class="break-all text-xs text-muted">${state}</code>`);
      expect(html).toContain(CONNECTION_LABELS[state]);
      expect(html).toContain(report.message);
      expect(html).toContain(report.capabilities[0]);
      expect(html).toContain(report.limitations[0]);
      expect(html).toContain(`dateTime="${report.testedAt}"`);
    },
  );

  it("renders all nine grouped provider cards before IPC without inventing success", () => {
    const html = renderToStaticMarkup(createElement(ResearchApisSection));
    expect(html).toContain("Research APIs &amp; Zugänge");
    expect(html.match(/data-testid="research-provider-/g)).toHaveLength(9);
    expect(html).toContain("Web search");
    expect(html).toContain("Social &amp; community");
    expect(html).toContain("Studies &amp; documents");
    expect(html).toContain("Loading provider status");
    expect(html).not.toContain("Connection test successful");
    expect(html.match(/target="_blank"/g)).toHaveLength(8);
  });

  it("renders a configured credential with an empty masked field, disabled blank Save, and explicit Remove", () => {
    const html = renderToStaticMarkup(
      createElement(CredentialInput, {
        id: "firecrawl_api_key",
        label: "Firecrawl API key",
        configured: true,
        draft: "",
        disabled: false,
        onDraft: vi.fn(),
        onSave: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('value=""');
    expect(html).toMatch(/<button[^>]*aria-label="Save Firecrawl API key"[^>]*disabled=""/);
    expect(html).toContain('aria-label="Remove saved Firecrawl API key"');
    expect(html).toContain("Configured · not a connection test");
    expect(html).toContain('for="firecrawl_api_key"');
    expect(html).toContain('aria-describedby="firecrawl_api_key-help"');
  });

  it("disables the masked input and both explicit actions while pending", () => {
    const html = renderToStaticMarkup(
      createElement(CredentialInput, {
        id: "anthropic_api_key",
        label: "Anthropic API key",
        configured: true,
        draft: "synthetic-value",
        disabled: true,
        onDraft: vi.fn(),
        onSave: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain('type="password"');
  });

  it("does not offer Remove for an unset optional credential", () => {
    const html = renderToStaticMarkup(
      createElement(CredentialInput, {
        id: "openalex_api_key",
        label: "OpenAlex API key",
        optional: true,
        configured: false,
        draft: "synthetic-value",
        disabled: false,
        onDraft: vi.fn(),
        onSave: vi.fn(),
        onRemove: vi.fn(),
      }),
    );
    expect(html).toContain("(optional)");
    expect(html).toContain("Not set");
    expect(html).not.toContain("Remove saved");
  });

  it("covers every provider exactly once and uses the final credential names", () => {
    expect(RESEARCH_PROVIDER_CARDS.map((card) => card.id).sort()).toEqual(
      [...RESEARCH_PROVIDER_IDS].sort(),
    );
    expect(
      RESEARCH_PROVIDER_CARDS.find((card) => card.id === "reddit")?.credentials.map(
        (credential) => credential.name,
      ),
    ).toEqual(["reddit_client_id", "reddit_client_secret", "reddit_refresh_token"]);
    expect(
      RESEARCH_PROVIDER_CARDS.find((card) => card.id === "openalex")?.credentials[0]?.optional,
    ).toBe(true);
    for (const id of ["eurostat", "local_documents"]) {
      expect(RESEARCH_PROVIDER_CARDS.find((card) => card.id === id)?.credentials).toEqual([]);
    }
    expect(
      RESEARCH_PROVIDER_CARDS.filter((card) => card.docs).every((card) =>
        card.docs?.startsWith("https://"),
      ),
    ).toBe(true);
  });

  it("labels every ConnectionReport code without confusing stored credentials with success", () => {
    expect(Object.keys(CONNECTION_LABELS).sort()).toEqual(
      [
        "not_configured",
        "untested",
        "success",
        "invalid_credentials",
        "permission_required",
        "rate_limited",
        "unreachable",
        "unsupported",
      ].sort(),
    );
    expect(CONNECTION_LABELS.untested).not.toBe(CONNECTION_LABELS.success);
  });

  it("requires a meaningful Reddit user-agent without echoing invalid input", () => {
    expect(validateRedditUserAgent("desktop:ReqFlow:0.1 (by /u/example_pm)")).toBeNull();
    expect(validateRedditUserAgent("generic-client")).toBeTruthy();
    expect(validateRedditUserAgent("x".repeat(201))).toBeTruthy();
  });

  it("only shows sanitized main errors, never raw objects or arbitrary Error messages", () => {
    expect(
      settingsErrorMessage(
        new ReqflowError("unreachable", "Provider unavailable", { private: "not for display" }),
        "Fallback",
      ),
    ).toBe("Provider unavailable");
    expect(settingsErrorMessage({ message: "unsafe" }, "Fallback")).toBe("Fallback");
    expect(settingsErrorMessage(new Error("unsafe"), "Fallback")).toBe("Fallback");
    expect(nonEmptySecretDraft(" \n\t ")).toBeNull();
    expect(nonEmptySecretDraft(" synthetic-value ")).toBe("synthetic-value");
  });
});

describe("Research Settings controller", () => {
  it("only loads main statuses on mount; no tests, configuration, or activation", async () => {
    const { controller, providers, configure, test, setSecret } = setup();
    expect(controller.getSnapshot().statuses).toBeNull();
    await controller.refresh();
    expect(controller.getSnapshot().statuses?.map((provider) => provider.id)).toEqual(
      RESEARCH_PROVIDER_IDS,
    );
    expect(providers).toHaveBeenCalledOnce();
    expect(configure).not.toHaveBeenCalled();
    expect(test).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
    expect(controller.getSnapshot().drafts).toEqual({});
  });

  it.each(["", "  ", "\n\t"])("blank Save (%j) cannot delete or submit a secret", async (draft) => {
    const { controller, setSecret } = setup();
    await controller.refresh();
    controller.setDraft("firecrawl_api_key", draft);
    await controller.saveSecret("firecrawl_api_key");
    expect(setSecret).not.toHaveBeenCalled();
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it("clears the draft after a successful save, then reloads actual statuses without enabling/testing", async () => {
    const { controller, providers, setSecret, configure, test } = setup();
    await controller.refresh();
    const saved = status();
    saved.credentialsConfigured.firecrawl_api_key = true;
    providers.mockResolvedValueOnce([saved]);
    controller.setDraft("firecrawl_api_key", " synthetic-value ");
    await controller.saveSecret("firecrawl_api_key");
    expect(setSecret).toHaveBeenCalledExactlyOnceWith("firecrawl_api_key", "synthetic-value");
    expect(controller.getSnapshot().drafts.firecrawl_api_key ?? "").toBe("");
    expect(providers).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().statuses?.[0]?.credentialsConfigured.firecrawl_api_key).toBe(
      true,
    );
    expect(controller.getSnapshot().statuses?.[0]?.connection.state).toBe("untested");
    expect(configure).not.toHaveBeenCalled();
    expect(test).not.toHaveBeenCalled();
  });

  it("clears a committed credential even if reloading statuses fails", async () => {
    const { controller, providers } = setup();
    await controller.refresh();
    providers.mockRejectedValueOnce(new ReqflowError("unreachable", "Status refresh unavailable"));
    controller.setDraft("firecrawl_api_key", "synthetic-value");
    await controller.saveSecret("firecrawl_api_key");
    expect(controller.getSnapshot().drafts.firecrawl_api_key ?? "").toBe("");
    expect(controller.getSnapshot().notice).toContain("saved");
    expect(controller.getSnapshot().error).toBe("Status refresh unavailable");
  });

  it("never uses a credential from an IPC response as a draft or provider status", async () => {
    const { controller, setSecret } = setup();
    await controller.refresh();
    controller.setDraft("firecrawl_api_key", "submitted-synthetic-value");
    setSecret.mockResolvedValueOnce({ credential: "unexpected-returned-credential" } as never);
    await controller.saveSecret("firecrawl_api_key");

    const snapshot = JSON.stringify(controller.getSnapshot());
    expect(snapshot).not.toContain("submitted-synthetic-value");
    expect(snapshot).not.toContain("unexpected-returned-credential");
  });

  it("clears a failed save draft, without echoing the error payload", async () => {
    const { controller, setSecret } = setup();
    await controller.refresh();
    setSecret.mockRejectedValueOnce(new Error("unsafe provider response"));
    controller.setDraft("firecrawl_api_key", "synthetic-value");
    await controller.saveSecret("firecrawl_api_key");
    expect(controller.getSnapshot().drafts.firecrawl_api_key).toBeUndefined();
    expect(controller.getSnapshot().error).not.toContain("unsafe");
  });

  it("clears credential drafts on a failed removal without leaking the response", async () => {
    const configured = status();
    configured.credentialsConfigured.firecrawl_api_key = true;
    const { controller, setSecret } = setup([configured]);
    await controller.refresh();
    controller.setDraft("firecrawl_api_key", "synthetic-value");
    controller.setDraft("youtube_api_key", "other-synthetic-value");
    setSecret.mockRejectedValueOnce(new Error("unsafe response including credential"));
    await controller.removeSecret("firecrawl_api_key");

    expect(setSecret).toHaveBeenCalledExactlyOnceWith("firecrawl_api_key", null);
    expect(controller.getSnapshot().drafts).toEqual({});
    expect(controller.getSnapshot().error).not.toContain("credential");
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it("only explicit Remove of a configured credential sends null and reloads statuses", async () => {
    const configured = status();
    configured.credentialsConfigured.firecrawl_api_key = true;
    const { controller, providers, setSecret } = setup([configured]);
    await controller.refresh();
    await controller.removeSecret("youtube_api_key");
    expect(setSecret).not.toHaveBeenCalled();
    providers.mockResolvedValueOnce([status()]);
    controller.setDraft("firecrawl_api_key", "discard-this-draft");
    await controller.removeSecret("firecrawl_api_key");
    expect(setSecret).toHaveBeenCalledExactlyOnceWith("firecrawl_api_key", null);
    expect(controller.getSnapshot().drafts.firecrawl_api_key).toBe("");
    expect(providers).toHaveBeenCalledTimes(2);
    expect(
      controller.getSnapshot().statuses?.[0]?.credentialsConfigured.firecrawl_api_key,
    ).toBeUndefined();
  });

  it("persists a config patch with all other fields intact and awaits store reload", async () => {
    const { controller, configure, reloadSettings } = setup();
    await controller.refresh();
    const reloaded = deferred<void>();
    reloadSettings.mockReturnValueOnce(reloaded.promise);
    const saving = controller.configure("apify", { approval: "granted" });
    await vi.waitFor(() => expect(reloadSettings).toHaveBeenCalledOnce());
    expect(configure).toHaveBeenCalledExactlyOnceWith("apify", {
      ...DEFAULT_RESEARCH_APIS.apify,
      approval: "granted",
    });
    expect(controller.getSnapshot().pending).not.toBeNull();
    expect(
      controller.getSnapshot().statuses?.find((provider) => provider.id === "apify")?.config
        .enabled,
    ).toBe(false);
    reloaded.resolve();
    await saving;
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it("persists pending theme, AI model and web selection alongside provider configuration", async () => {
    vi.useFakeTimers();
    try {
      let persisted = structuredClone(DEFAULT_SETTINGS);
      const get = vi.fn(async () => structuredClone(persisted));
      // Match main's contract: configure alone owns APIs, and settings.save ignores stale APIs.
      const save = vi.fn(async (input: Settings) => {
        persisted = {
          ...structuredClone(input),
          research: { ...input.research, apis: persisted.research.apis },
        };
        return structuredClone(persisted);
      });
      const store = createSettingsStore({
        settings: { get, save, secrets: vi.fn(), setSecret: vi.fn(), testSetup: vi.fn() },
      });
      const configure = vi
        .fn<ReqflowApi["research"]["configure"]>()
        .mockImplementation(async (id, config) => {
          persisted.research.apis[id] = config;
          return { ...status(id), config };
        });
      const controller = createResearchSettingsController(
        {
          research: {
            providers: async () => RESEARCH_PROVIDER_IDS.map((id) => status(id)),
            configure,
            test: vi.fn(),
          },
          settings: { setSecret: vi.fn() },
        },
        () => store.getState().reloadResearchApis(),
      );
      controller.activate();
      await store.getState().load();
      await controller.refresh();
      store.getState().update("app", { theme: "dark" });
      store.getState().update("llm", { provider: "anthropic", model: "custom-model" });
      store.getState().update("research", { provider: "firecrawl" });
      await vi.advanceTimersByTimeAsync(200);

      await controller.configure("firecrawl", { enabled: true });

      expect(controller.getSnapshot().error).toBeNull();
      expect(store.getState().settings).toMatchObject({
        app: { theme: "dark" },
        llm: { provider: "anthropic", model: "custom-model" },
        research: { provider: "firecrawl", apis: { firecrawl: { enabled: true } } },
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(save).toHaveBeenCalledOnce();
      expect(persisted).toEqual(store.getState().settings);
      expect(persisted.app.theme).toBe("dark");
      expect(persisted.research.apis.firecrawl.enabled).toBe(true);
      controller.deactivate();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed provider reconciliation while retaining the persisted provider status", async () => {
    const { controller, reloadSettings } = setup();
    await controller.refresh();
    controller.setDraft("firecrawl_api_key", "synthetic-value");
    reloadSettings.mockRejectedValueOnce(new ReqflowError("unreachable", "Settings unavailable"));
    await controller.configure("firecrawl", { enabled: true });

    expect(controller.getSnapshot().error).toBe("Settings unavailable");
    expect(
      controller.getSnapshot().statuses?.find((item) => item.id === "firecrawl")?.config.enabled,
    ).toBe(true);
    expect(controller.getSnapshot().drafts).toEqual({});
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it("rejects actors outside the fixed allowlist without changing persisted config", async () => {
    const { controller, configure } = setup();
    await controller.refresh();
    await controller.configure("apify", { allowedActors: ["unknown/actor" as never] });
    expect(configure).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toBeTruthy();
  });

  it("shows the returned test report exactly, with no automatic approval or activation", async () => {
    const { controller, test, configure } = setup();
    await controller.refresh();
    const tested = status("reddit");
    tested.connection = {
      state: "permission_required",
      message: "Approval required",
      capabilities: [],
      limitations: ["No collection access"],
      testedAt: "2026-10-10T10:00:00.000Z",
    };
    test.mockResolvedValueOnce(tested);
    await controller.test("reddit");
    expect(controller.getSnapshot().statuses?.find((provider) => provider.id === "reddit")).toEqual(
      tested,
    );
    expect(configure).not.toHaveBeenCalled();
  });

  it("blocks duplicate actions and draft edits while an operation is pending", async () => {
    const { controller, setSecret, test } = setup();
    await controller.refresh();
    const saving = deferred<SecretStatus>();
    setSecret.mockReturnValueOnce(saving.promise);
    controller.setDraft("firecrawl_api_key", "synthetic-value");
    const first = controller.saveSecret("firecrawl_api_key");
    controller.setDraft("firecrawl_api_key", "newer-value");
    await controller.saveSecret("firecrawl_api_key");
    await controller.test("youtube");
    expect(setSecret).toHaveBeenCalledOnce();
    expect(test).not.toHaveBeenCalled();
    expect(controller.getSnapshot().drafts.firecrawl_api_key).toBe("");
    saving.resolve({} as SecretStatus);
    await first;
  });

  it("ignores stale loads after unmount/remount and clears transient drafts", async () => {
    const { controller, providers } = setup();
    const stale = deferred<ResearchProviderStatus[]>();
    providers.mockReturnValueOnce(stale.promise);
    const first = controller.refresh();
    controller.deactivate();
    controller.activate();
    providers.mockResolvedValueOnce([status("eurostat")]);
    await controller.refresh();
    stale.resolve([status("firecrawl")]);
    await first;
    expect(controller.getSnapshot().statuses?.[0]?.id).toBe("eurostat");
    controller.setDraft("firecrawl_api_key", "synthetic-value");
    controller.deactivate();
    expect(controller.getSnapshot().drafts).toEqual({});
  });

  it("still reloads persisted settings after configure completes on an unmounted section", async () => {
    const { controller, configure, reloadSettings } = setup();
    await controller.refresh();
    const response = deferred<ResearchProviderStatus>();
    configure.mockReturnValueOnce(response.promise);
    const saving = controller.configure("x", { xSearchMode: "full_archive" });
    controller.deactivate();
    response.resolve({
      ...status("x"),
      config: { ...DEFAULT_RESEARCH_APIS.x, xSearchMode: "full_archive" },
    });
    await saving;
    expect(reloadSettings).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a stale credential %s after remount without clearing a new draft",
    async (outcome) => {
      const { controller, setSecret, providers } = setup();
      await controller.refresh();
      const oldResponse = deferred<SecretStatus>();
      setSecret.mockReturnValueOnce(oldResponse.promise);
      controller.setDraft("firecrawl_api_key", "old-synthetic-value");
      const oldSave = controller.saveSecret("firecrawl_api_key");
      controller.deactivate();
      controller.activate();
      await controller.refresh();
      controller.setDraft("firecrawl_api_key", "new-synthetic-value");
      if (outcome === "resolve") oldResponse.resolve({} as SecretStatus);
      else oldResponse.reject(new Error("unsafe old error"));
      await oldSave;

      expect(controller.getSnapshot().drafts.firecrawl_api_key).toBe("new-synthetic-value");
      expect(controller.getSnapshot().error).toBeNull();
      expect(controller.getSnapshot().notice).toBeNull();
      expect(controller.getSnapshot().pending).toBeNull();
      expect(providers).toHaveBeenCalledTimes(2);
    },
  );
});
