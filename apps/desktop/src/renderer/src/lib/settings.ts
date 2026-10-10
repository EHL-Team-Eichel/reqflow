import { useStore } from "zustand";
import { api } from "./api";
import { createSettingsStore, type SettingsState } from "./settings-store";

/** The app-wide settings store, bound to the real IPC client. */
export const settingsStore = createSettingsStore(api);

/**
 * Read settings in components: `useSettings((s) => s.settings.app.theme)`.
 * Select primitives or existing objects; wrap selectors that build new objects in `useShallow`.
 */
export function useSettings<T>(selector: (state: SettingsState) => T): T {
  return useStore(settingsStore, selector);
}
