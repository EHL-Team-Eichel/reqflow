import { useState, useMemo } from "react";
import { useSettings, settingsStore } from "@/lib/settings";
import { SettingRow } from "../SettingRow";
import { Segmented } from "../Segmented";
import { NumberInput, Select, Slider, ValidatedTextInput } from "@/components/ui/controls";
import { Button } from "@/components/ui/Button";
import {
  KNOWN_VEHICLE_LINES,
  KNOWN_MARKETS,
  ScoreFactor,
  SCORE_FACTOR_LABELS,
  weightedTotal,
  priorityForScore,
} from "@reqflow/core";

const MARKET_LABELS: Record<string, string> = {
  EU: "Europe",
  CN: "China",
  US: "United States",
};
const MARKET_OPTIONS = KNOWN_MARKETS.map((m) => ({ value: m, label: MARKET_LABELS[m] || m }));
const VEHICLE_LINE_OPTIONS = KNOWN_VEHICLE_LINES.map((l) => ({ value: l, label: l }));
const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
] as const;

const EXAMPLE_VALUES: Record<ScoreFactor, number> = {
  customer_impact: 5,
  evidence_strength: 2,
  competitive_gap: 4,
  trend_momentum: 3,
  brand_fit: 4,
  ease: 1,
};

export function ParametersSection() {
  const scope = useSettings((s) => s.settings.defaultScope);
  const scoring = useSettings((s) => s.settings.scoring);
  const llm = useSettings((s) => s.settings.llm);

  // Validation errors returned by update(), per row.
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const updateScope = (patch: Partial<typeof scope>, key: string) => {
    const err = settingsStore.getState().update("defaultScope", patch);
    setErrors((prev) => ({ ...prev, [key]: err }));
  };
  const updateScoring = (patch: Partial<typeof scoring>, key: string) => {
    const err = settingsStore.getState().update("scoring", patch);
    setErrors((prev) => ({ ...prev, [key]: err }));
  };
  const updateWeights = (factor: ScoreFactor, v: number) => {
    updateScoring({ weights: { ...scoring.weights, [factor]: v } }, "weights");
  };
  const updateThresholds = (key: keyof typeof scoring.thresholds, v: number) => {
    updateScoring({ thresholds: { ...scoring.thresholds, [key]: v } }, "thresholds");
  };
  const updateLlm = (patch: Partial<typeof llm>, key: string) => {
    const err = settingsStore.getState().update("llm", patch);
    setErrors((prev) => ({ ...prev, [key]: err }));
  };

  const reqIdExample = `REQ-${scope.vehicleCode || "XX"}-${scope.market || "XX"}-001`;

  let exampleOutput = "";
  try {
    const total = weightedTotal(EXAMPLE_VALUES, scoring.weights);
    const band = priorityForScore(total, scoring.thresholds);
    const bandLabels = {
      must: "Must have",
      should: "Should have",
      could: "Could have",
      wont: "Won't have",
    };
    exampleOutput = `Example requirement scores ${total} → ${bandLabels[band]}`;
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    exampleOutput = "Set at least one weight above 0";
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h2 className="text-lg font-semibold text-ink">Global parameters</h2>
        <p className="mt-1 text-sm text-muted">
          Defaults every flow uses. Blocks set to “From Settings” follow these.
        </p>
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 text-sm font-semibold text-ink">Vehicle & market</h3>
        <SettingRow label="Vehicle line" error={errors.vehicleLine}>
          <Select
            options={VEHICLE_LINE_OPTIONS}
            value={scope.vehicleLine}
            onChange={(vehicleLine) => updateScope({ vehicleLine }, "vehicleLine")}
          />
        </SettingRow>
        <SettingRow label="Derivative">
          <ValidatedTextInput
            aria-label="Derivative"
            value={scope.derivative ?? ""}
            placeholder="e.g. Sedan"
            onCommit={(v) =>
              settingsStore.getState().update("defaultScope", { derivative: v.trim() || undefined })
            }
          />
        </SettingRow>
        <SettingRow
          label="Vehicle code"
          description={`Up to 6 letters or digits, used in requirement IDs like ${reqIdExample}`}
        >
          <ValidatedTextInput
            aria-label="Vehicle code"
            value={scope.vehicleCode}
            onCommit={(v) =>
              settingsStore
                .getState()
                .update("defaultScope", { vehicleCode: v.trim().toUpperCase() })
            }
          />
        </SettingRow>
        <SettingRow label="Market" error={errors.market}>
          <Select
            options={MARKET_OPTIONS}
            value={scope.market}
            onChange={(market) => updateScope({ market }, "market")}
          />
        </SettingRow>
        <SettingRow label="Planning horizon" error={errors.horizonYears}>
          <NumberInput
            value={scope.horizonYears}
            onChange={(horizonYears) => updateScope({ horizonYears }, "horizonYears")}
            min={1}
            max={10}
            unit="years"
          />
        </SettingRow>
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 text-sm font-semibold text-ink">Prioritization</h3>
        {ScoreFactor.options.map((factor) => (
          <SettingRow key={factor} label={SCORE_FACTOR_LABELS[factor]} error={errors.weights}>
            <Slider
              value={scoring.weights[factor]}
              onChange={(v) => updateWeights(factor, v)}
              min={0}
              max={10}
              step={1}
            />
          </SettingRow>
        ))}

        <SettingRow label="Thresholds" error={errors.thresholds}>
          <div className="flex gap-2">
            <div className="flex-1">
              <div className="mb-1 text-xs text-muted">Must</div>
              <NumberInput
                value={scoring.thresholds.must}
                onChange={(must) => updateThresholds("must", must)}
                min={0}
                max={100}
              />
            </div>
            <div className="flex-1">
              <div className="mb-1 text-xs text-muted">Should</div>
              <NumberInput
                value={scoring.thresholds.should}
                onChange={(should) => updateThresholds("should", should)}
                min={0}
                max={100}
              />
            </div>
            <div className="flex-1">
              <div className="mb-1 text-xs text-muted">Could</div>
              <NumberInput
                value={scoring.thresholds.could}
                onChange={(could) => updateThresholds("could", could)}
                min={0}
                max={100}
              />
            </div>
          </div>
        </SettingRow>

        <div className="mt-4 rounded-lg bg-panel-2 p-3 text-sm text-ink border border-line">
          {exampleOutput}
        </div>
      </div>

      <div className="flex flex-col">
        <h3 className="mb-2 text-sm font-semibold text-ink">AI output</h3>
        <SettingRow label="Language of AI-written requirements">
          <Segmented
            options={LANGUAGE_OPTIONS}
            value={llm.outputLanguage}
            onChange={(outputLanguage) =>
              settingsStore.getState().update("llm", { outputLanguage })
            }
          />
        </SettingRow>
      </div>

      <div className="mt-2 flex gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => settingsStore.getState().resetSection("defaultScope")}
        >
          Reset scope
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            settingsStore.getState().resetSection("scoring");
            setErrors({});
          }}
        >
          Reset scoring
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => settingsStore.getState().resetSection("llm")}
        >
          Reset AI
        </Button>
      </div>
    </div>
  );
}
