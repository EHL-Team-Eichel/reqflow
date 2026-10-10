import type { VehicleModel } from "./types";
import { BATCH_1_MODELS } from "./batch1";
import { BATCH_2_MODELS } from "./batch2";
import { BATCH_3_MODELS } from "./batch3";
import { BATCH_4_MODELS } from "./batch4";

export const VEHICLE_MODELS: VehicleModel[] = [
  ...BATCH_1_MODELS,
  ...BATCH_2_MODELS,
  ...BATCH_3_MODELS,
  ...BATCH_4_MODELS,
];

const MODELS_MAP = new Map<string, VehicleModel>(VEHICLE_MODELS.map((m) => [m.id, m]));

export function getVehicleModelById(id: string): VehicleModel | undefined {
  return MODELS_MAP.get(id);
}

export function searchVehicleModels(query: string, category?: string): VehicleModel[] {
  const q = query.trim().toLowerCase();
  return VEHICLE_MODELS.filter((model) => {
    if (category && category !== "all") {
      if (category === "m" && !model.name.includes("M") && !model.series.startsWith("M"))
        return false;
      if (category === "sedan" && model.bodyType !== "sedan") return false;
      if (category === "coupe" && model.bodyType !== "coupe") return false;
      if (category === "suv" && model.bodyType !== "suv") return false;
      if (category === "touring" && model.bodyType !== "touring") return false;
      if (category === "race" && model.bodyType !== "race" && !model.name.includes("GT"))
        return false;
    }
    if (!q) return true;
    return (
      model.name.toLowerCase().includes(q) ||
      model.chassisCode.toLowerCase().includes(q) ||
      model.series.toLowerCase().includes(q) ||
      model.year.toString().includes(q) ||
      model.bodyType.toLowerCase().includes(q)
    );
  });
}
