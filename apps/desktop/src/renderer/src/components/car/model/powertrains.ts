import { CarPowertrain } from "@reqflow/core";
import { availablePartIds, CLASSIFIABLE_PARTS } from "../modelSwitcher/powertrains";
import type { PowertrainType } from "../models/types";

/** The saved Settings contract uses hydrogen/fuel; the catalog uses h2/gasoline. */
export function sketchPowertrain(value: PowertrainType | CarPowertrain): PowertrainType {
  const persisted = CarPowertrain.parse(
    value === "h2" ? "hydrogen" : value === "gasoline" ? "fuel" : value,
  );
  return persisted === "hydrogen" ? "h2" : persisted === "fuel" ? "gasoline" : persisted;
}

export function settingsPowertrain(value: PowertrainType): CarPowertrain {
  return CarPowertrain.parse(value === "h2" ? "hydrogen" : value === "gasoline" ? "fuel" : value);
}

export const CAR_MODELS: Record<CarPowertrain, { label: string; description: string }> = {
  hydrogen: {
    label: "Hydrogen",
    description:
      "Fuel-cell electric drive with hydrogen tanks, a fuel-cell stack and a buffer battery.",
  },
  hybrid: {
    label: "Hybrid",
    description:
      "Plug-in hybrid with a combustion engine, electric rear motor, battery and fuel tank.",
  },
  electric: {
    label: "Electric",
    description:
      "Battery-electric drive with an underfloor battery and front and rear electric motors.",
  },
  fuel: {
    label: "Fuel",
    description: "Combustion drive with an engine, fuel tank, transmission and exhaust system.",
  },
};

/** Only model-specific components vary; the shell, cabin and chassis are shared. */
export function isModelPartAvailable(partId: string, powertrain: CarPowertrain): boolean {
  return (
    !CLASSIFIABLE_PARTS.some((part) => part.id === partId) ||
    availablePartIds(sketchPowertrain(powertrain)).has(partId)
  );
}

/** Keep off-model requirements reviewable; never hide evidence when changing a visualization. */
export function modelMenuParts(
  partIds: readonly string[],
  powertrain: CarPowertrain,
  counts: ReadonlyMap<string, number>,
): string[] {
  return partIds.filter((id) => isModelPartAvailable(id, powertrain) || (counts.get(id) ?? 0) > 0);
}
