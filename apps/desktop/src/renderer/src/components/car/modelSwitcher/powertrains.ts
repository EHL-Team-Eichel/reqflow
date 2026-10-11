import { CAR_PARTS, EXTENDED_CAR_PARTS } from "../parts";
import { PART_SUBCLASSES, type PartSubclass } from "../partMenu";
import type { PowertrainType, VehicleModel } from "../models/types";
import { modelExcludedPartIds } from "../models/features";
import { getSourceMeshInfoById } from "../models/registry";

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

/** Stable vocabulary across sketches, so switching never changes requirement assignments. */
export const CLASSIFIABLE_PARTS = [...CAR_PARTS, ...EXTENDED_CAR_PARTS];

export function availablePartIds(
  powertrain: PowertrainType,
  model?: VehicleModel,
): ReadonlySet<string> {
  const source = model ? getSourceMeshInfoById(model.id) : undefined;
  if (source) return new Set(source.partIds);
  const excluded = modelExcludedPartIds(model);
  return new Set([
    ...CAR_PARTS.filter((p) => !VARIABLE_PARTS.includes(p.id) && !excluded.has(p.id)).map(
      (p) => p.id,
    ),
    ...POWERTRAIN_PARTS[powertrain].filter((id) => !excluded.has(id)),
    ...modelPartIds(model).filter((id) => !excluded.has(id)),
  ]);
}

/** Map special-equipment aliases to the existing selectable assembly IDs. */
export function modelPartIds(model?: VehicleModel): string[] {
  const aliases: Readonly<Record<string, string>> = {
    gt_wing: "rear_spoiler",
    duckbill_spoiler: "rear_spoiler",
    canards: "front_splitter",
  };
  return [
    ...new Set(
      (model?.specialParts ?? [])
        .filter((id) => !VARIABLE_PARTS.includes(id))
        .map((id) => aliases[id] ?? id),
    ),
  ];
}

export function powertrainSubclasses(
  powertrain: PowertrainType,
  model?: VehicleModel,
): readonly PartSubclass[] {
  const available = availablePartIds(powertrain, model);
  const source = model ? getSourceMeshInfoById(model.id) : undefined;
  const subclasses = PART_SUBCLASSES.map((subclass) => ({
    ...subclass,
    partIds:
      subclass.id === "power_chassis"
        ? [
            ...subclass.partIds.filter((id) => !VARIABLE_PARTS.includes(id)),
            ...(source ? VARIABLE_PARTS : POWERTRAIN_PARTS[powertrain]),
          ].filter((id) => available.has(id))
        : subclass.partIds.filter((id) => available.has(id)),
  }));
  const existing = new Set(subclasses.flatMap((subclass) => subclass.partIds));
  for (const group of ["exterior", "interior", "technology"] as const) {
    const partIds = EXTENDED_CAR_PARTS.filter(
      (p) => p.group === group && available.has(p.id) && !existing.has(p.id),
    ).map((p) => p.id);
    if (partIds.length)
      subclasses.push({ id: `model_${group}`, label: "Model equipment", group, partIds });
  }
  return subclasses;
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
