import { DEFAULT_SETTINGS, Settings, type ReqflowApi } from "@reqflow/core";
import { createStore } from "zustand/vanilla";
import { ReqflowError } from "./bridge-client";

/**
 * Where the settings live, as far as the UI knows:
 * - "loading": asking the main process
 * - "saved": loaded from / saved to disk
 * - "unavailable": main has no settings storage yet (WS1) — changes apply until the app restarts
 * - "error": loading or saving failed; `error` says why
 */
export type SettingsPersistence = "loading" | "saved" | "unavailable" | "error";

export interface SettingsState {
  settings: Settings;
  persistence: SettingsPersistence;
  error: string | null;
  /** Ask main for the stored settings. Keeps the defaults when storage isn't built yet. */
  load(): Promise<void>;
  /**
   * Merge `patch` into one section, validated with the `Settings` schema. Returns a readable
   * error and changes nothing when invalid; otherwise applies it and saves in the background.
   */
  update<K extends keyof Settings>(section: K, patch: Partial<Settings[K]>): string | null;
  resetSection(section: keyof Settings): void;
}

const SAVE_DELAY_MS = 400;

export function createSettingsStore(client: Pick<ReqflowApi, "settings">) {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  return createStore<SettingsState>()((set, get) => {
    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        if (get().persistence === "unavailable") return;
        try {
          const saved = await client.settings.save(get().settings);
          set({ settings: saved, persistence: "saved", error: null });
        } catch (err) {
          if (err instanceof ReqflowError && err.code === "not_implemented") {
            set({ persistence: "unavailable", error: null });
          } else {
            set({ persistence: "error", error: errorMessage(err, "Saving settings failed") });
          }
        }
      }, SAVE_DELAY_MS);
    };

    const apply = <K extends keyof Settings>(section: K, value: Settings[K]): string | null => {
      const parsed = Settings.shape[section].safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return issue ? issue.message : "Invalid value";
      }
      set({ settings: { ...get().settings, [section]: parsed.data } });
      save();
      return null;
    };

    return {
      settings: DEFAULT_SETTINGS,
      persistence: "loading",
      error: null,

      async load() {
        set({ persistence: "loading", error: null });
        try {
          const stored = Settings.parse(await client.settings.get());
          set({ settings: stored, persistence: "saved" });
        } catch (err) {
          if (err instanceof ReqflowError && err.code === "not_implemented") {
            set({ persistence: "unavailable" });
          } else {
            set({ persistence: "error", error: errorMessage(err, "Loading settings failed") });
          }
        }
      },

      update(section, patch) {
        return apply(section, { ...get().settings[section], ...patch });
      },

      resetSection(section) {
        apply(section, DEFAULT_SETTINGS[section]);
      },
    };
  });
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? `${fallback}: ${err.message}` : fallback;
}
