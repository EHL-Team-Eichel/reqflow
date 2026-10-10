import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  LLM_MODEL_DEFAULTS,
  LLM_SECRET_NAMES,
  SECRET_NAMES,
  Settings,
  type LiveLlmProvider,
  type ReqflowApi,
  type SecretStatus,
} from "@reqflow/core";
import { ReqflowError } from "../../../lib/bridge-client";
import {
  createAiCredentialsController,
  modelPresets,
  modelValidationError,
  switchLlmProvider,
  temperatureHelp,
} from "./AiSection.helpers";

const liveProviders: LiveLlmProvider[] = ["anthropic", "openai", "google"];
const llm = (provider: LiveLlmProvider = "anthropic") => ({
  ...DEFAULT_SETTINGS.llm,
  provider,
  ...LLM_MODEL_DEFAULTS[provider],
});
const statuses = (configured?: keyof SecretStatus, source: "keychain" | "env" = "keychain") =>
  Object.fromEntries(
    SECRET_NAMES.map((name) => [
      name,
      { configured: name === configured, source: name === configured ? source : null },
    ]),
  ) as Record<import("@reqflow/core").SecretName, import("@reqflow/core").SecretState>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(provider: LiveLlmProvider | "mock" = "anthropic", initial = statuses()) {
  const secrets = vi.fn<ReqflowApi["settings"]["secrets"]>().mockResolvedValue(initial);
  const setSecret = vi.fn<ReqflowApi["settings"]["setSecret"]>().mockResolvedValue(initial);
  const controller = createAiCredentialsController({ settings: { secrets, setSecret } }, provider);
  controller.activate();
  return { controller, secrets, setSecret };
}

describe("AI provider model profiles", () => {
  it.each(liveProviders)(
    "uses shared safe defaults when switching to %s without profiles",
    (provider) => {
      const next = switchLlmProvider(DEFAULT_SETTINGS.llm, provider);
      expect(next).toEqual({ ...DEFAULT_SETTINGS.llm, provider, ...LLM_MODEL_DEFAULTS[provider] });
      expect(Settings.parse({ ...DEFAULT_SETTINGS, llm: next }).llm).toEqual(next);
    },
  );

  it("migrates old custom Anthropic settings lazily and preserves canonical runtime fields", () => {
    const old = { ...llm(), model: "claude-custom-quality", fastModel: "claude-custom-fast" };
    const openai = switchLlmProvider(old, "openai");
    expect(old).not.toHaveProperty("modelProfiles");
    expect(openai.modelProfiles?.anthropic).toEqual({ model: old.model, fastModel: old.fastModel });
    expect(openai.model).toBe(LLM_MODEL_DEFAULTS.openai.model);
    expect(openai.fastModel).toBe(LLM_MODEL_DEFAULTS.openai.fastModel);
    expect(switchLlmProvider(openai, "anthropic")).toMatchObject(old);
  });

  it("round-trips custom IDs across all providers, retaining temperature and language", () => {
    let current: Settings["llm"] = {
      ...llm(),
      model: "claude-custom",
      fastModel: "claude-small",
      outputLanguage: "de",
    };
    current = {
      ...switchLlmProvider(current, "openai"),
      model: "gpt-custom",
      fastModel: "o4-mini-custom",
    };
    current = {
      ...switchLlmProvider(current, "google"),
      model: "gemini-custom",
      fastModel: "gemini-small",
    };
    current = switchLlmProvider(current, "anthropic");
    expect(current).toMatchObject({
      model: "claude-custom",
      fastModel: "claude-small",
      outputLanguage: "de",
      temperature: 0.2,
    });
    expect(switchLlmProvider(current, "openai")).toMatchObject({
      model: "gpt-custom",
      fastModel: "o4-mini-custom",
    });
    expect(switchLlmProvider(current, "google")).toMatchObject({
      model: "gemini-custom",
      fastModel: "gemini-small",
    });
  });

  it("treats edited canonical fields as authoritative over an older active profile", () => {
    const current = {
      ...llm(),
      model: "claude-edited",
      modelProfiles: { anthropic: LLM_MODEL_DEFAULTS.anthropic },
    };
    const next = switchLlmProvider(current, "google");
    expect(next.modelProfiles?.anthropic?.model).toBe("claude-edited");
    expect(current.modelProfiles.anthropic).toEqual(LLM_MODEL_DEFAULTS.anthropic);
    expect(switchLlmProvider(current, "anthropic")).toBe(current);
  });

  it("uses safe defaults for a remembered profile with a known foreign provider model", () => {
    const current = {
      ...llm(),
      modelProfiles: { google: { model: "gpt-foreign", fastModel: "gemini-custom" } },
    };
    expect(switchLlmProvider(current, "google")).toMatchObject(LLM_MODEL_DEFAULTS.google);
  });

  it("keeps mock inert and never assigns its inherited models to a live provider profile", () => {
    const mock = switchLlmProvider({ ...llm("openai"), model: "gpt-custom" }, "mock");
    expect(mock.provider).toBe("mock");
    expect(mock.model).toBe("gpt-custom");
    expect(mock.modelProfiles?.openai?.model).toBe("gpt-custom");
    expect(mock.modelProfiles).not.toHaveProperty("mock");
    expect(switchLlmProvider(mock, "google")).toMatchObject(LLM_MODEL_DEFAULTS.google);
    expect(switchLlmProvider(mock, "openai").model).toBe("gpt-custom");
  });

  it.each(liveProviders)(
    "offers only %s defaults as presets, without guessing account availability",
    (provider) => {
      expect(modelPresets(provider).map((option) => option.value)).toEqual([
        LLM_MODEL_DEFAULTS[provider].model,
        LLM_MODEL_DEFAULTS[provider].fastModel,
      ]);
      expect(modelPresets("mock")).toEqual([]);
    },
  );
});

describe("AI model validation and temperature help", () => {
  it.each([
    ["anthropic", "gpt-4.1"],
    ["anthropic", "gemini-3.8-flash"],
    ["openai", "claude-opus-5-5"],
    ["openai", "gemini-3.8-flash"],
    ["google", "gpt-4.1"],
    ["google", "o3-mini"],
    ["google", "claude-opus-5-5"],
  ] as const)("rejects known foreign %s model %s", (provider, model) => {
    expect(modelValidationError(provider, model)).toContain("provider");
  });

  it("rejects blank, oversized and whitespace-containing model IDs without echoing input", () => {
    for (const model of ["", " \n ", "x".repeat(201), "gpt custom"]) {
      expect(modelValidationError("openai", model)).toBeTruthy();
    }
    expect(modelValidationError("openai", " custom-model-id ")).toBeNull();
    expect(modelValidationError("google", "gemini-3.8-flash")).toBeNull();
    expect(modelValidationError("mock", "claude-opus-5-5")).toBeNull();
  });

  it("explains reasoning temperature restrictions without changing saved temperature", () => {
    const current = { ...llm("openai"), model: "o3", temperature: 0.2 };
    expect(temperatureHelp(current)).toContain("temperature");
    expect(temperatureHelp(current)).toContain("omits");
    expect(temperatureHelp({ ...current, model: "gpt-5", fastModel: "gpt-5-mini" })).toContain(
      "omits",
    );
    expect(temperatureHelp(llm("google"))).toContain("provider");
    expect(temperatureHelp(DEFAULT_SETTINGS.llm)).toContain("offline");
    expect(current.temperature).toBe(0.2);
  });
});

describe("AI selected-provider credential lifecycle", () => {
  it.each(liveProviders)(
    "saves only the selected %s credential and clears drafts before submit",
    async (provider) => {
      const { controller, secrets, setSecret } = setup(provider);
      await controller.refresh();
      const response = deferred<SecretStatus>();
      setSecret.mockReturnValueOnce(response.promise);
      controller.setDraft(" synthetic-value ");
      const saving = controller.saveSecret();
      expect(controller.getSnapshot().draft).toBe("");
      expect(setSecret).toHaveBeenCalledExactlyOnceWith(
        LLM_SECRET_NAMES[provider],
        "synthetic-value",
      );
      controller.setDraft("cannot-edit-while-pending");
      await controller.saveSecret();
      expect(setSecret).toHaveBeenCalledOnce();
      response.resolve(statuses(LLM_SECRET_NAMES[provider]));
      secrets.mockResolvedValueOnce(statuses(LLM_SECRET_NAMES[provider]));
      await saving;
      expect(controller.getSnapshot().secrets?.[LLM_SECRET_NAMES[provider]].configured).toBe(true);
      expect(controller.getSnapshot().draft).toBe("");
      expect(secrets).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["", "  ", "\n\t"])("blank Save (%j) never writes or deletes", async (draft) => {
    const { controller, setSecret } = setup();
    await controller.refresh();
    controller.setDraft(draft);
    await controller.saveSecret();
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("only explicit removal sends null and refreshes environment fallback", async () => {
    const { controller, secrets, setSecret } = setup("google", statuses("google_api_key"));
    await controller.refresh();
    controller.setDraft("discard-this-draft");
    secrets.mockResolvedValueOnce(statuses("google_api_key", "env"));
    await controller.removeSecret();
    expect(setSecret).toHaveBeenCalledExactlyOnceWith("google_api_key", null);
    expect(controller.getSnapshot().secrets?.google_api_key.source).toBe("env");
    expect(controller.getSnapshot().draft).toBe("");
    expect(controller.getSnapshot().notice).toContain("environment");
  });

  it("does not remove an unconfigured key or allow edits before status is available", async () => {
    const { controller, setSecret } = setup();
    controller.setDraft("synthetic-value");
    await controller.saveSecret();
    expect(controller.getSnapshot().draft).toBe("");
    await controller.refresh();
    await controller.removeSecret();
    expect(setSecret).not.toHaveBeenCalled();
  });

  it("never stores values returned by a secret write or extra read fields", async () => {
    const { controller, secrets, setSecret } = setup("openai");
    await controller.refresh();
    setSecret.mockResolvedValueOnce({ credential: "unexpected-returned-value" } as never);
    secrets.mockResolvedValueOnce({
      ...statuses("openai_api_key"),
      openai_api_key: { configured: true, source: "keychain", value: "extra-returned-value" },
      credential: "unexpected-status-value",
    } as never);
    controller.setDraft("submitted-synthetic-value");
    await controller.saveSecret();
    const snapshot = JSON.stringify(controller.getSnapshot());
    expect(snapshot).not.toContain("returned-value");
    expect(snapshot).not.toContain("submitted-synthetic-value");
    expect(snapshot).not.toContain("unexpected-status-value");
    expect(controller.getSnapshot().secrets).toEqual(statuses("openai_api_key"));
  });

  it.each(["save", "remove", "refresh"] as const)(
    "clears drafts after failed %s and hides raw errors",
    async (operation) => {
      const { controller, secrets, setSecret } = setup("anthropic", statuses("anthropic_api_key"));
      await controller.refresh();
      controller.setDraft("synthetic-value");
      if (operation === "refresh") secrets.mockRejectedValueOnce(new Error("unsafe credential"));
      else setSecret.mockRejectedValueOnce(new Error("unsafe credential"));
      await (operation === "save"
        ? controller.saveSecret()
        : operation === "remove"
          ? controller.removeSecret()
          : controller.refresh());
      expect(controller.getSnapshot().draft).toBe("");
      expect(controller.getSnapshot().error).toBeTruthy();
      expect(controller.getSnapshot().error).not.toContain("unsafe");
    },
  );

  it("retains successful write notice if the status refresh fails, without retaining drafts", async () => {
    const { controller, secrets } = setup();
    await controller.refresh();
    controller.setDraft("synthetic-value");
    secrets.mockRejectedValueOnce(new ReqflowError("unreachable", "Status refresh unavailable"));
    await controller.saveSecret();
    expect(controller.getSnapshot()).toMatchObject({
      draft: "",
      notice: expect.stringContaining("saved"),
      error: "Status refresh unavailable",
      pending: null,
    });
  });

  it("treats malformed credential status as unavailable, never displaying its payload", async () => {
    const { controller, secrets } = setup();
    secrets.mockResolvedValueOnce({ openai_api_key: "unsafe-value" } as never);
    await controller.refresh();
    expect(controller.getSnapshot().secrets).toBeNull();
    expect(controller.getSnapshot().error).toBeTruthy();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("unsafe-value");
  });

  it("clears drafts on provider switches and unmount, including StrictMode reactivation", async () => {
    const { controller } = setup();
    await controller.refresh();
    controller.setDraft("anthropic-synthetic-value");
    controller.selectProvider("google");
    expect(controller.getSnapshot()).toMatchObject({
      provider: "google",
      draft: "",
      secrets: null,
    });
    await controller.refresh();
    controller.setDraft("google-synthetic-value");
    controller.deactivate();
    expect(controller.getSnapshot().draft).toBe("");
    controller.activate();
    await controller.refresh();
    expect(controller.getSnapshot().draft).toBe("");
  });

  it.each(["resolve", "reject"] as const)(
    "ignores stale credential %s after a provider switch",
    async (outcome) => {
      const { controller, setSecret, secrets } = setup();
      await controller.refresh();
      const stale = deferred<SecretStatus>();
      setSecret.mockReturnValueOnce(stale.promise);
      controller.setDraft("old-synthetic-value");
      const saving = controller.saveSecret();
      controller.selectProvider("openai");
      await controller.refresh();
      controller.setDraft("new-synthetic-value");
      if (outcome === "resolve") stale.resolve(statuses("anthropic_api_key"));
      else stale.reject(new Error("unsafe old error"));
      await saving;
      expect(controller.getSnapshot()).toMatchObject({
        provider: "openai",
        draft: "new-synthetic-value",
        error: null,
        notice: null,
        pending: null,
      });
      expect(secrets).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores stale credential %s after unmount/remount",
    async (outcome) => {
      const { controller, setSecret } = setup();
      await controller.refresh();
      const stale = deferred<SecretStatus>();
      setSecret.mockReturnValueOnce(stale.promise);
      controller.setDraft("old-synthetic-value");
      const saving = controller.saveSecret();
      controller.deactivate();
      controller.activate();
      await controller.refresh();
      controller.setDraft("new-synthetic-value");
      if (outcome === "resolve") stale.resolve(statuses("anthropic_api_key"));
      else stale.reject(new Error("unsafe old error"));
      await saving;
      expect(controller.getSnapshot()).toMatchObject({
        draft: "new-synthetic-value",
        error: null,
        notice: null,
        pending: null,
      });
    },
  );

  it("ignores stale status loads even when switching away and back to the same provider", async () => {
    const { controller, secrets } = setup();
    const stale = deferred<SecretStatus>();
    secrets.mockReturnValueOnce(stale.promise);
    const loading = controller.refresh();
    controller.selectProvider("google");
    controller.selectProvider("anthropic");
    secrets.mockResolvedValueOnce(statuses("anthropic_api_key", "env"));
    await controller.refresh();
    controller.setDraft("new-synthetic-value");
    stale.resolve(statuses("anthropic_api_key", "keychain"));
    await loading;
    expect(controller.getSnapshot().secrets?.anthropic_api_key.source).toBe("env");
    expect(controller.getSnapshot().draft).toBe("new-synthetic-value");
  });

  it("mock never writes credentials or starts model calls", async () => {
    const { controller, setSecret } = setup("mock");
    await controller.refresh();
    controller.setDraft("synthetic-value");
    await controller.saveSecret();
    await controller.removeSecret();
    expect(setSecret).not.toHaveBeenCalled();
    expect(controller.getSnapshot().draft).toBe("");
  });
});
