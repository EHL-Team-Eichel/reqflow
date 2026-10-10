import { CarPowertrain } from "@reqflow/core";
import { CAR_MODELS } from "@/components/car/model/powertrains";
import { settingsStore, useSettings } from "@/lib/settings";
import { Button } from "@/components/ui/Button";
import { cx } from "@/lib/cx";

export function ModelSection() {
  const powertrain = useSettings((s) => s.settings.model.powertrain);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-ink">Model</h2>
        <p className="mt-1 text-sm text-muted">
          Choose the powertrain for the Car tab. All four models share the same body shell, cabin
          and chassis.
        </p>
      </div>
      <div role="group" aria-label="Car model" className="grid grid-cols-2 gap-3">
        {CarPowertrain.options.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={powertrain === value}
            data-testid={`model-${value}`}
            onClick={() => settingsStore.getState().update("model", { powertrain: value })}
            className={cx(
              "rounded-lg border p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
              powertrain === value
                ? "border-brand bg-brand-soft"
                : "border-line bg-panel hover:bg-panel-2",
            )}
          >
            <span className="block text-sm font-semibold text-ink">{CAR_MODELS[value].label}</span>
            <span className="mt-2 block text-sm text-muted">{CAR_MODELS[value].description}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">
        Conceptual layouts, not production BMW specifications. This changes the visualization only;
        vehicle scope, flow data and requirement decisions stay unchanged. Your choice is saved on
        this computer.
      </p>
      <div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => settingsStore.getState().resetSection("model")}
        >
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
