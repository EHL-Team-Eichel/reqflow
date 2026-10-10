import type { CarPowertrain } from "@reqflow/core";

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
export const POWERTRAIN_PARTS: Record<string, readonly CarPowertrain[]> = {
  rear_motor: ["electric", "hybrid", "hydrogen"],
  battery_pack: ["electric", "hybrid", "hydrogen"],
  inverter: ["electric", "hybrid", "hydrogen"],
  charging_port: ["electric", "hybrid"],
  fuel_tank: ["fuel", "hybrid"],
  exhaust_system: ["fuel", "hybrid"],
  fuel_cell: ["hydrogen"],
  hydrogen_tanks: ["hydrogen"],
  refuelling_port: ["fuel", "hybrid", "hydrogen"],
};

export function isModelPartAvailable(partId: string, powertrain: CarPowertrain): boolean {
  return POWERTRAIN_PARTS[partId]?.includes(powertrain) ?? true;
}

/** Keep off-model requirements reviewable; never hide evidence when changing a visualization. */
export function modelMenuParts(
  partIds: readonly string[],
  powertrain: CarPowertrain,
  counts: ReadonlyMap<string, number>,
): string[] {
  return partIds.filter((id) => isModelPartAvailable(id, powertrain) || (counts.get(id) ?? 0) > 0);
}
