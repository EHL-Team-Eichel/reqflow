import { beforeEach, describe, expect, it, vi } from "vitest";
import { VEHICLE_MODELS } from "./registry";
import { DEFAULT_SETTINGS } from "@reqflow/core";
import { settingsStore } from "../../../lib/settings";

vi.mock("../../../lib/settings", async () => {
  const { DEFAULT_SETTINGS } = await import("@reqflow/core");
  const { createSettingsStore } = await import("../../../lib/settings-store");
  return {
    settingsStore: createSettingsStore({
      settings: {
        get: async () => structuredClone(DEFAULT_SETTINGS),
        save: async (settings) => settings,
        secrets: vi.fn(),
        setSecret: vi.fn(),
        testSetup: vi.fn(),
      },
    }),
  };
});

const memory = new Map<string, string>();
const STORAGE_KEY = "reqflow.vehicle_switcher_state";
beforeEach(() => {
  vi.resetModules();
  memory.clear();
  settingsStore.setState({
    settings: structuredClone(DEFAULT_SETTINGS),
    persistence: "unavailable",
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  });
});

describe("vehicle sketch state", () => {
  it("uses the M4 Competition for a fresh preview without changing requirement scope", async () => {
    const { useVehicleStore, getActiveVehicle } = await import("./vehicleStore");
    expect(useVehicleStore.getState().selectedModelId).toBe("bmw_m4_competition_2025");
    expect(getActiveVehicle().model.name).toBe("2025 BMW M4 Competition");
    expect(settingsStore.getState().settings.defaultScope).toEqual(DEFAULT_SETTINGS.defaultScope);
  });

  it("starts electric and persists all four choices without changing requirement scope", async () => {
    const { useVehicleStore, getActiveVehicle } = await import("./vehicleStore");
    expect(getActiveVehicle().powertrain).toBe("electric");
    for (const pt of ["electric", "hybrid", "h2", "gasoline"] as const) {
      useVehicleStore.getState().setPowertrain(pt);
      expect(getActiveVehicle().powertrain).toBe(pt);
      expect(JSON.parse(memory.get(STORAGE_KEY)!).powertrain).toBe(pt);
      expect(settingsStore.getState().settings.model.powertrain).toBe(
        pt === "h2" ? "hydrogen" : pt === "gasoline" ? "fuel" : pt,
      );
    }
    useVehicleStore.getState().setPowertrain("h2");
    useVehicleStore.getState().selectModel(VEHICLE_MODELS[1]!.id);
    expect(getActiveVehicle().powertrain).toBe("h2");
    expect(getActiveVehicle().model.id).toBe(VEHICLE_MODELS[1]!.id);
  });

  it("follows persisted Settings reloads and external model changes without changing catalog selection", async () => {
    const { useVehicleStore } = await import("./vehicleStore");
    useVehicleStore.getState().selectModel(VEHICLE_MODELS[1]!.id);
    settingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, model: { powertrain: "hydrogen" } },
      persistence: "saved",
    });
    expect(useVehicleStore.getState().powertrain).toBe("h2");
    expect(useVehicleStore.getState().selectedModelId).toBe(VEHICLE_MODELS[1]!.id);
    settingsStore.getState().update("model", { powertrain: "fuel" });
    expect(useVehicleStore.getState().powertrain).toBe("gasoline");
    expect(settingsStore.getState().settings.defaultScope).toEqual(DEFAULT_SETTINGS.defaultScope);
  });

  it("restores a valid saved sketch and rejects invalid runtime choices", async () => {
    memory.set(
      STORAGE_KEY,
      JSON.stringify({
        modelId: VEHICLE_MODELS[1]!.id,
        powertrain: "hybrid",
        previewDefaultVersion: 1,
      }),
    );
    const { useVehicleStore, getActiveVehicle } = await import("./vehicleStore");
    expect(getActiveVehicle().model.id).toBe(VEHICLE_MODELS[1]!.id);
    expect(getActiveVehicle().powertrain).toBe("hybrid");
    expect(() => useVehicleStore.getState().setPowertrain("diesel" as "electric")).toThrow(
      "Unknown powertrain",
    );
    expect(() => useVehicleStore.getState().selectModel("missing")).toThrow(
      "Unknown vehicle model",
    );
    expect(getActiveVehicle().powertrain).toBe("hybrid");
  });

  it("migrates the legacy saved default sedan to M4 once, retaining powertrain and scope", async () => {
    memory.set(
      STORAGE_KEY,
      JSON.stringify({ modelId: "bmw_m5_sedan_g90_2025", powertrain: "hybrid" }),
    );
    const { getActiveVehicle, useVehicleStore } = await import("./vehicleStore");
    expect(getActiveVehicle().model.id).toBe("bmw_m4_competition_2025");
    expect(getActiveVehicle().powertrain).toBe("hybrid");
    expect(JSON.parse(memory.get(STORAGE_KEY)!)).toEqual({
      modelId: "bmw_m4_competition_2025",
      powertrain: "hybrid",
      previewDefaultVersion: 1,
    });
    expect(settingsStore.getState().settings.defaultScope).toEqual(DEFAULT_SETTINGS.defaultScope);

    useVehicleStore.getState().selectModel("bmw_m5_sedan_g90_2025");
    vi.resetModules();
    const reloaded = await import("./vehicleStore");
    expect(reloaded.getActiveVehicle().model.id).toBe("bmw_m5_sedan_g90_2025");
    expect(reloaded.getActiveVehicle().powertrain).toBe("hybrid");
  });

  it("retains other legacy saved models", async () => {
    const other = VEHICLE_MODELS.find(
      (model) => model.id !== "bmw_m5_sedan_g90_2025" && model.id !== "bmw_m4_competition_2025",
    )!;
    memory.set(STORAGE_KEY, JSON.stringify({ modelId: other.id, powertrain: "h2" }));
    const { getActiveVehicle } = await import("./vehicleStore");
    expect(getActiveVehicle().model.id).toBe(other.id);
    expect(getActiveVehicle().powertrain).toBe("h2");
  });

  it.each([
    "not json",
    "null",
    JSON.stringify({ modelId: "missing", powertrain: "h2" }),
    JSON.stringify({ modelId: VEHICLE_MODELS[0]!.id, powertrain: "diesel" }),
  ])("recovers safely from invalid persisted state %s", async (raw) => {
    memory.set(STORAGE_KEY, raw);
    const { getActiveVehicle } = await import("./vehicleStore");
    expect(getActiveVehicle().model.id).toBe(VEHICLE_MODELS[0]!.id);
    expect(getActiveVehicle().powertrain).toBe("electric");
  });

  it("keeps switching available when browser storage is unavailable", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Unavailable");
      },
      setItem: () => {
        throw new Error("Unavailable");
      },
    });
    const { useVehicleStore, getActiveVehicle } = await import("./vehicleStore");
    useVehicleStore.getState().setPowertrain("gasoline");
    expect(getActiveVehicle().powertrain).toBe("gasoline");
  });
});
