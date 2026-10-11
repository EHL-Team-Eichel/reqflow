import { DEFAULT_SETTINGS, type ReqflowApi, type Settings } from "@reqflow/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReqflowError } from "./bridge-client";
import { createSettingsStore } from "./settings-store";

type SettingsClient = Pick<ReqflowApi, "settings">;

function client(overrides: Partial<SettingsClient["settings"]> = {}): SettingsClient {
  const notBuilt = async (): Promise<never> => {
    throw new ReqflowError("not_implemented", "not built");
  };
  return {
    settings: {
      get: notBuilt,
      save: notBuilt,
      secrets: notBuilt,
      setSecret: notBuilt,
      testSetup: notBuilt,
      ...overrides,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("settings store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps defaults and reports 'unavailable' while main has no settings storage", async () => {
    const store = createSettingsStore(client());
    await store.getState().load();
    expect(store.getState()).toMatchObject({
      settings: DEFAULT_SETTINGS,
      persistence: "unavailable",
    });
    expect(store.getState().update("app", { theme: "dark" })).toBeNull();
    expect(store.getState().settings.app.theme).toBe("dark");
  });

  it("rejects invalid values with a message and leaves settings unchanged", () => {
    const store = createSettingsStore(client());
    expect(store.getState().update("defaultScope", { horizonYears: 40 })).toMatch(/10/);
    expect(store.getState().update("defaultScope", { market: "europe" })).not.toBeNull();
    const member = {
      id: "m1",
      name: "A",
      email: "a@example.com",
      role: "editor",
      status: "invited",
    } as const;
    expect(store.getState().update("collaboration", { members: [member] })).toBeNull();
    expect(
      store.getState().update("collaboration", {
        members: [member, { ...member, id: "m2", email: "A@example.com" }],
      }),
    ).toMatch(/already on the team/);
    expect(store.getState().settings.defaultScope).toEqual(DEFAULT_SETTINGS.defaultScope);
    expect(store.getState().settings.collaboration.members).toHaveLength(1);
  });

  it("loads stored settings and saves changes in the background", async () => {
    const stored: Settings = {
      ...DEFAULT_SETTINGS,
      app: { ...DEFAULT_SETTINGS.app, showMinimap: true },
    };
    const save = vi.fn(async (s: Settings) => s);
    const store = createSettingsStore(client({ get: async () => stored, save }));
    await store.getState().load();
    expect(store.getState()).toMatchObject({ persistence: "saved", settings: stored });

    store.getState().update("app", { snapToGrid: false });
    store.getState().update("app", { confirmBeforeDelete: false });
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(1); // debounced
    expect(save.mock.calls[0]![0].app).toMatchObject({
      snapToGrid: false,
      confirmBeforeDelete: false,
    });
  });

  it("surfaces load and save failures instead of swallowing them", async () => {
    const store = createSettingsStore(
      client({
        get: async () => ({ nonsense: true }) as never,
        save: async () => {
          throw new Error("disk full");
        },
      }),
    );
    await store.getState().load();
    expect(store.getState().persistence).toBe("error");
    expect(store.getState().error).toMatch(/Loading settings failed/);

    store.getState().update("app", { theme: "light" });
    await vi.runAllTimersAsync();
    expect(store.getState()).toMatchObject({
      persistence: "error",
      error: expect.stringMatching(/disk full/),
    });
  });

  it("reconciles only provider APIs without replacing dirty settings or delaying their autosave", async () => {
    let persisted = structuredClone(DEFAULT_SETTINGS);
    const save = vi.fn(async (input: Settings) => {
      persisted = { ...input, research: { ...input.research, apis: persisted.research.apis } };
      return structuredClone(persisted);
    });
    const store = createSettingsStore(
      client({ get: async () => structuredClone(persisted), save }),
    );
    await store.getState().load();
    store.getState().update("app", { theme: "dark" });
    store.getState().update("llm", { provider: "anthropic", model: "custom-quality-model" });
    store.getState().update("research", { provider: "firecrawl", allowedDomains: ["example.com"] });
    await vi.advanceTimersByTimeAsync(200);
    persisted.research.apis.firecrawl.enabled = true;

    await store.getState().reloadResearchApis();

    expect(store.getState().settings.app.theme).toBe("dark");
    expect(store.getState().settings.llm).toMatchObject({
      provider: "anthropic",
      model: "custom-quality-model",
    });
    expect(store.getState().settings.research).toMatchObject({
      provider: "firecrawl",
      allowedDomains: ["example.com"],
      apis: { firecrawl: { enabled: true } },
    });
    await vi.advanceTimersByTimeAsync(199);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledOnce();
    expect(persisted).toEqual(store.getState().settings);
    expect(persisted.app.theme).toBe("dark");
    expect(persisted.research.apis.firecrawl.enabled).toBe(true);
  });

  it("does not let an older save response undo reconciled provider settings", async () => {
    const response = deferred<Settings>();
    let persisted = structuredClone(DEFAULT_SETTINGS);
    const save = vi.fn<ReqflowApi["settings"]["save"]>().mockReturnValueOnce(response.promise);
    const store = createSettingsStore(
      client({ get: async () => structuredClone(persisted), save }),
    );
    await store.getState().load();
    store.getState().update("app", { theme: "dark" });
    await vi.advanceTimersByTimeAsync(400);
    const oldResponse = structuredClone(save.mock.calls[0]![0]);
    persisted.research.apis.firecrawl.enabled = true;
    await store.getState().reloadResearchApis();

    response.resolve(oldResponse);
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getState().settings.app.theme).toBe("dark");
    expect(store.getState().settings.research.apis.firecrawl.enabled).toBe(true);
  });

  it("preserves edits made while a save is in flight and persists them on the next debounce", async () => {
    const first = deferred<Settings>();
    const save = vi
      .fn<ReqflowApi["settings"]["save"]>()
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(async (input) => input);
    const store = createSettingsStore(client({ get: async () => DEFAULT_SETTINGS, save }));
    await store.getState().load();
    store.getState().update("app", { theme: "dark" });
    await vi.advanceTimersByTimeAsync(400);
    store.getState().update("app", { theme: "light" });
    store.getState().update("llm", { model: "newer-model" });
    first.resolve(save.mock.calls[0]![0]);
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getState().settings.app.theme).toBe("light");
    expect(store.getState().settings.llm.model).toBe("newer-model");
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0].app.theme).toBe("light");
    expect(save.mock.calls[1]![0].llm.model).toBe("newer-model");
  });

  it.each(["resolve", "reject"] as const)(
    "ignores an older save %s after a newer save succeeds",
    async (outcome) => {
      const first = deferred<Settings>();
      const save = vi
        .fn<ReqflowApi["settings"]["save"]>()
        .mockReturnValueOnce(first.promise)
        .mockImplementationOnce(async (input) => input);
      const store = createSettingsStore(client({ get: async () => DEFAULT_SETTINGS, save }));
      await store.getState().load();
      store.getState().update("app", { theme: "dark" });
      await vi.advanceTimersByTimeAsync(400);
      store.getState().update("app", { theme: "light" });
      await vi.advanceTimersByTimeAsync(400);
      if (outcome === "resolve") first.resolve(save.mock.calls[0]![0]);
      else first.reject(new Error("old save failed"));
      await vi.advanceTimersByTimeAsync(0);

      expect(store.getState()).toMatchObject({
        settings: { app: { theme: "light" } },
        persistence: "saved",
        error: null,
      });
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores an older provider reload %s after a newer reload",
    async (outcome) => {
      const first = deferred<Settings>();
      const updated = structuredClone(DEFAULT_SETTINGS);
      updated.research.apis.firecrawl.enabled = true;
      const get = vi
        .fn<ReqflowApi["settings"]["get"]>()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(updated);
      const store = createSettingsStore(client({ get }));
      const old = store.getState().reloadResearchApis();
      await store.getState().reloadResearchApis();
      if (outcome === "resolve") first.resolve(DEFAULT_SETTINGS);
      else first.reject(new Error("old reload failed"));
      await old;

      expect(store.getState().settings.research.apis.firecrawl.enabled).toBe(true);
      expect(store.getState().persistence).toBe("loading"); // Provider reload never changes persistence.
    },
  );

  it("rejects a failed or invalid provider reload without replacing local settings or cancelling autosave", async () => {
    const get = vi
      .fn<ReqflowApi["settings"]["get"]>()
      .mockResolvedValueOnce(DEFAULT_SETTINGS)
      .mockRejectedValueOnce(new ReqflowError("unreachable", "Settings unavailable"))
      .mockResolvedValueOnce({
        research: { apis: { firecrawl: { enabled: "invalid" } } },
      } as never);
    const save = vi.fn(async (input: Settings) => input);
    const store = createSettingsStore(client({ get, save }));
    await store.getState().load();
    store.getState().update("app", { theme: "dark" });
    const current = store.getState().settings;
    await expect(store.getState().reloadResearchApis()).rejects.toThrow("Settings unavailable");
    await expect(store.getState().reloadResearchApis()).rejects.toThrow();
    expect(store.getState().settings).toBe(current);
    await vi.advanceTimersByTimeAsync(400);
    expect(save).toHaveBeenCalledExactlyOnceWith(current);
  });
  it("saves and resets the model without changing vehicle scope or other settings", async () => {
    const save = vi.fn(async (s: Settings) => s);
    const store = createSettingsStore(client({ get: async () => DEFAULT_SETTINGS, save }));
    await store.getState().load();
    expect(store.getState().update("model", { powertrain: "hydrogen" })).toBeNull();
    await vi.runAllTimersAsync();
    expect(save.mock.calls[0]![0]).toEqual({
      ...DEFAULT_SETTINGS,
      model: { powertrain: "hydrogen" },
    });
    expect(store.getState().update("model", { powertrain: "unknown" as never })).not.toBeNull();
    expect(store.getState().settings.model.powertrain).toBe("hydrogen");
    store.getState().resetSection("model");
    await vi.runAllTimersAsync();
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
  });
});
