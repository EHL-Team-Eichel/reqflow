import { useSettings, settingsStore } from "@/lib/settings";
import { SettingRow } from "../SettingRow";
import { Segmented } from "../Segmented";
import { Toggle } from "@/components/ui/controls";
import { Button } from "@/components/ui/Button";

const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

export function AppSection() {
  const app = useSettings((s) => s.settings.app);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">App</h2>
        <p className="mt-1 text-sm text-muted">How ReqFlow looks and behaves on this computer.</p>
      </div>

      <div className="flex flex-col">
        <SettingRow label="Theme">
          <Segmented
            options={THEME_OPTIONS}
            value={app.theme}
            onChange={(theme) => settingsStore.getState().update("app", { theme })}
            testIdPrefix="theme-"
          />
        </SettingRow>

        <SettingRow label="Snap blocks to the grid">
          <Toggle
            value={app.snapToGrid}
            onChange={(snapToGrid) => settingsStore.getState().update("app", { snapToGrid })}
            label="Snap blocks to the grid"
          />
        </SettingRow>

        <SettingRow label="Show the minimap on the workplace">
          <Toggle
            value={app.showMinimap}
            onChange={(showMinimap) => settingsStore.getState().update("app", { showMinimap })}
            label="Show the minimap on the workplace"
          />
        </SettingRow>

        <SettingRow label="Ask before deleting blocks">
          <Toggle
            value={app.confirmBeforeDelete}
            onChange={(confirmBeforeDelete) =>
              settingsStore.getState().update("app", { confirmBeforeDelete })
            }
            label="Ask before deleting blocks"
          />
        </SettingRow>
      </div>

      <div className="mt-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => settingsStore.getState().resetSection("app")}
        >
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
