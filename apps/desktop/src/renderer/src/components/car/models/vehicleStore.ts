import { create } from "zustand";
import type { PowertrainType, VehicleModel } from "./types";
import { DEFAULT_MODEL_ID, getVehicleModelById, VEHICLE_MODELS } from "./registry";
import { settingsStore } from "../../../lib/settings";
import { settingsPowertrain, sketchPowertrain } from "../model/powertrains";

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
const PREVIEW_DEFAULT_VERSION = 1;
const LEGACY_DEFAULT_MODEL_ID = "bmw_m5_sedan_g90_2025";

function loadSaved(): { modelId: string; powertrain: PowertrainType } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.modelId === "string" && getVehicleModelById(parsed.modelId)) {
        // Older installs persisted the former default. Upgrade it once, but preserve other
        // saved models and any explicit sedan selection made after this migration.
        const modelId =
          parsed.modelId === LEGACY_DEFAULT_MODEL_ID &&
          parsed.previewDefaultVersion !== PREVIEW_DEFAULT_VERSION
            ? DEFAULT_MODEL_ID
            : parsed.modelId;
        const saved: { modelId: string; powertrain: PowertrainType } = {
          modelId,
          powertrain: isPowertrain(parsed.powertrain) ? parsed.powertrain : "electric",
        };
        if (modelId !== parsed.modelId) persist(saved.modelId, saved.powertrain);
        return saved;
      }
    }
  } catch {
    // Ignore localStorage parse errors
  }
  return {
    modelId: DEFAULT_MODEL_ID,
    powertrain: "electric",
  };
}

function persist(modelId: string, powertrain: PowertrainType) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ modelId, powertrain, previewDefaultVersion: PREVIEW_DEFAULT_VERSION }),
    );
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
      if (!model) throw new Error(`Unknown vehicle model: ${modelId}`);

      // Sketch choices are exploratory and remain available for every catalog model.
      // Changing the sketch must not reset the chosen powertrain or alter requirement scope.
      const nextPowertrain = get().powertrain;

      set({ selectedModelId: modelId, powertrain: nextPowertrain });
      persist(modelId, nextPowertrain);
    },

    setPowertrain: (powertrain: PowertrainType) => {
      if (!isPowertrain(powertrain)) throw new Error("Unknown powertrain");
      const error = settingsStore
        .getState()
        .update("model", { powertrain: settingsPowertrain(powertrain) });
      if (error) throw new Error(error);
      set({ powertrain });
      persist(get().selectedModelId, powertrain);
    },

    setSearchQuery: (searchQuery: string) => set({ searchQuery }),
    setSelectedCategory: (selectedCategory: string) => set({ selectedCategory }),
  };
});

// Both Settings screens and the Car switcher share the persisted powertrain choice.
settingsStore.subscribe((state, previous) => {
  if (
    state.settings.model.powertrain === previous.settings.model.powertrain &&
    state.persistence === previous.persistence
  )
    return;
  const powertrain = sketchPowertrain(state.settings.model.powertrain);
  if (useVehicleStore.getState().powertrain !== powertrain) {
    useVehicleStore.setState({ powertrain });
    persist(useVehicleStore.getState().selectedModelId, powertrain);
  }
});

export function getActiveVehicle(): { model: VehicleModel; powertrain: PowertrainType } {
  const state = useVehicleStore.getState();
  const model = getVehicleModelById(state.selectedModelId) ?? VEHICLE_MODELS[0]!;
  return { model, powertrain: state.powertrain };
}
