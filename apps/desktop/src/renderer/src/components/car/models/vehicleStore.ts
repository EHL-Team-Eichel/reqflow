import { create } from "zustand";
import type { PowertrainType, VehicleModel } from "./types";
import { getVehicleModelById, VEHICLE_MODELS } from "./registry";

interface VehicleState {
  selectedModelId: string;
  powertrain: PowertrainType;
  searchQuery: string;
  selectedCategory: string;
  selectModel: (modelId: string) => void;
  setPowertrain: (pt: PowertrainType) => void;
  setSearchQuery: (query: string) => void;
  setSelectedCategory: (category: string) => void;
}

export function isPowertrain(value: unknown): value is PowertrainType {
  return value === "electric" || value === "hybrid" || value === "h2" || value === "gasoline";
}

const STORAGE_KEY = "reqflow.vehicle_switcher_state";

function loadSaved(): { modelId: string; powertrain: PowertrainType } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.modelId === "string" && getVehicleModelById(parsed.modelId)) {
        return {
          modelId: parsed.modelId,
          powertrain: isPowertrain(parsed.powertrain) ? parsed.powertrain : "electric",
        };
      }
    }
  } catch {
    // Ignore localStorage parse errors
  }
  return {
    modelId: VEHICLE_MODELS[0]?.id ?? "bmw_330i_xdrive_2025",
    powertrain: "electric",
  };
}

function persist(modelId: string, powertrain: PowertrainType) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ modelId, powertrain }));
  } catch {
    // Ignore storage quota errors
  }
}

export const useVehicleStore = create<VehicleState>((set, get) => {
  const initial = loadSaved();

  return {
    selectedModelId: initial.modelId,
    powertrain: initial.powertrain,
    searchQuery: "",
    selectedCategory: "all",

    selectModel: (modelId: string) => {
      const model = getVehicleModelById(modelId);
      if (!model) return;

      const nextPowertrain = model.supportedPowertrains.includes(get().powertrain)
        ? get().powertrain
        : model.defaultPowertrain;

      set({ selectedModelId: modelId, powertrain: nextPowertrain });
      persist(modelId, nextPowertrain);
    },

    setPowertrain: (powertrain: PowertrainType) => {
      if (!isPowertrain(powertrain)) throw new Error("Unknown powertrain");
      set({ powertrain });
      persist(get().selectedModelId, powertrain);
    },

    setSearchQuery: (searchQuery: string) => set({ searchQuery }),
    setSelectedCategory: (selectedCategory: string) => set({ selectedCategory }),
  };
});

export function getActiveVehicle(): { model: VehicleModel; powertrain: PowertrainType } {
  const state = useVehicleStore.getState();
  const model = getVehicleModelById(state.selectedModelId) ?? VEHICLE_MODELS[0]!;
  return { model, powertrain: state.powertrain };
}
