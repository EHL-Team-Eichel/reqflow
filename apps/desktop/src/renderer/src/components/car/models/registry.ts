/// <reference types="vite/client" />
import type { VehicleModel } from "./types";
import {
  ConvertedProfileSchema,
  ConvertedProfileIndexSchema,
  createConvertedProfileIndex,
  type ConvertedProfileIndex,
  type SourceMeshProfile,
} from "../converter/profile";
import { BATCH_1_MODELS } from "./batch1";
import { BATCH_2_MODELS } from "./batch2";
import { BATCH_3_MODELS } from "./batch3";
import { BATCH_4_MODELS } from "./batch4";
import { BATCH_5_MODELS } from "./batch5";
import { BATCH_6_MODELS } from "./batch6";
import { BATCH_7_MODELS } from "./batch7";
import { BATCH_8_MODELS } from "./batch8";
import { BATCH_9_MODELS } from "./batch9";
import { BATCH_10_MODELS } from "./batch10";
import { BATCH_11_MODELS } from "./batch11";

export const DEFAULT_MODEL_ID = "bmw_m4_competition_2025";

const ALL_BATCH_MODELS: VehicleModel[] = [
  ...BATCH_1_MODELS,
  ...BATCH_2_MODELS,
  ...BATCH_3_MODELS,
  ...BATCH_4_MODELS,
  ...BATCH_5_MODELS,
  ...BATCH_6_MODELS,
  ...BATCH_7_MODELS,
  ...BATCH_8_MODELS,
  ...BATCH_9_MODELS,
  ...BATCH_10_MODELS,
  ...BATCH_11_MODELS,
];

// Place the standard 2025 BMW M4 Competition at index 0 as the application preview model.
const standardModel = ALL_BATCH_MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!;
export const BUILT_IN_VEHICLE_MODELS: VehicleModel[] = [
  standardModel,
  ...ALL_BATCH_MODELS.filter((m) => m.id !== DEFAULT_MODEL_ID),
];
const importedFiles = import.meta.glob("./imported/*.json", { import: "default" });
const importedIndices = import.meta.glob("./imported/meta/*.json", {
  eager: true,
  import: "default",
});
const sourceIndices = new Map<string, ConvertedProfileIndex>();
const models = new Map(BUILT_IN_VEHICLE_MODELS.map((model) => [model.id, model]));
const indexedFiles = new Set<string>();
const indexedIds = new Set<string>();
for (const [path, raw] of Object.entries(importedIndices)) {
  const index = ConvertedProfileIndexSchema.parse(raw);
  const profilePath = `./imported/${index.file}`;
  if (!importedFiles[profilePath]) throw new Error(`Missing converted car geometry for ${path}`);
  if (indexedIds.has(index.model.id) || indexedFiles.has(profilePath))
    throw new Error(`Duplicate converted car id '${index.model.id}' in ${path}`);
  indexedIds.add(index.model.id);
  indexedFiles.add(profilePath);
  models.set(index.model.id, index.model);
  if (index.profileFormat === "reqflow-sketch-mesh-v1") sourceIndices.set(index.model.id, index);
}
for (const path of Object.keys(importedFiles)) {
  if (!indexedFiles.has(path))
    throw new Error(`Missing converted car metadata for ${path}; regenerate with the converter`);
}
export const VEHICLE_MODELS: VehicleModel[] = [...models.values()];
const SOURCE_MESHES = new Map<string, SourceMeshProfile>();
const pendingMeshes = new Map<string, Promise<SourceMeshProfile>>();
export function getSourceMeshInfoById(id: string): ConvertedProfileIndex | undefined {
  return sourceIndices.get(id);
}
export async function loadSourceMeshById(id: string): Promise<SourceMeshProfile | undefined> {
  const index = sourceIndices.get(id);
  if (!index) return undefined;
  const loaded = SOURCE_MESHES.get(id);
  if (loaded) return loaded;
  const pending = pendingMeshes.get(id);
  if (pending) return pending;
  const request = (async () => {
    const profile = ConvertedProfileSchema.parse(
      await importedFiles[`./imported/${index.file}`]!(),
    );
    if (
      profile.format !== "reqflow-sketch-mesh-v1" ||
      JSON.stringify(createConvertedProfileIndex(profile, index.file)) !== JSON.stringify(index)
    )
      throw new Error(`Converted car metadata differs from geometry for ${id}`);
    SOURCE_MESHES.set(id, profile);
    return profile;
  })();
  pendingMeshes.set(id, request);
  try {
    return await request;
  } finally {
    pendingMeshes.delete(id);
  }
}
/** Already-loaded geometry; menus and loading decisions use the lightweight index. */
export function getSourceMeshById(id: string): SourceMeshProfile | undefined {
  return SOURCE_MESHES.get(id);
}

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
