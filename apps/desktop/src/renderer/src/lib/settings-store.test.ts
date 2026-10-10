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
      ...overrides,
    },
  };
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
