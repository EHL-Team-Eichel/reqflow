import { CAR_PARTS, EXTENDED_CAR_PARTS } from "../parts";
import { PART_SUBCLASSES, type PartSubclass } from "../partMenu";
import type { PowertrainType } from "../models/types";

/** Schematic layouts, independent of the configured requirement scope/vehicle derivative. */
export const POWERTRAINS = [
  { value: "electric", label: "Electric", description: "Traction battery and two electric motors" },
  {
    value: "hybrid",
    label: "Hybrid",
    description: "Plug-in hybrid: engine, electric motor and smaller battery",
  },
  {
    value: "h2",
    label: "H2",
    description: "Hydrogen: fuel cell, storage tanks and electric motor",
  },
  { value: "gasoline", label: "Gasoline", description: "Combustion engine, fuel tank and exhaust" },
] as const;

const VARIABLE_PARTS = [
  "motor",
  "rear_motor",
  "battery_pack",
  "inverter",
  "charging_port",
  "combustion_engine",
  "fuel_system",
  "exhaust_system",
  "fuel_cell",
  "h2_storage",
];

export const POWERTRAIN_PARTS: Readonly<Record<PowertrainType, readonly string[]>> = {
  electric: ["motor", "rear_motor", "battery_pack", "inverter", "charging_port"],
  hybrid: [
    "combustion_engine",
    "rear_motor",
    "battery_pack",
    "inverter",
    "charging_port",
    "fuel_system",
    "exhaust_system",
  ],
  h2: ["rear_motor", "battery_pack", "inverter", "fuel_cell", "h2_storage"],
  gasoline: ["combustion_engine", "fuel_system", "exhaust_system"],
};

/** Only powertrain extensions join classification; optional future body parts remain scaffolding. */
export const CLASSIFIABLE_PARTS = [
  ...CAR_PARTS,
  ...EXTENDED_CAR_PARTS.filter((p) => VARIABLE_PARTS.includes(p.id)),
];

export function availablePartIds(powertrain: PowertrainType): ReadonlySet<string> {
  return new Set([
    ...CAR_PARTS.filter((p) => !VARIABLE_PARTS.includes(p.id)).map((p) => p.id),
    ...POWERTRAIN_PARTS[powertrain],
  ]);
}

export function powertrainSubclasses(powertrain: PowertrainType): readonly PartSubclass[] {
  const available = availablePartIds(powertrain);
  return PART_SUBCLASSES.map((subclass) => ({
    ...subclass,
    partIds:
      subclass.id === "power_chassis"
        ? [
            ...subclass.partIds.filter((id) => !VARIABLE_PARTS.includes(id)),
            ...POWERTRAIN_PARTS[powertrain],
          ]
        : subclass.partIds.filter((id) => available.has(id)),
  }));
}

/** Preserve original assignments/counts; absent parts retain their own review rows. */
export function retainedRequirementParts(
  available: ReadonlySet<string>,
  counts: ReadonlyMap<string, number>,
): string[] {
  return [...counts]
    .filter(([id, count]) => id !== "whole_car" && count > 0 && !available.has(id))
    .map(([id]) => id);
}
