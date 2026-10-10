import { describe, expect, it } from "vitest";
import { buildVehicleModel } from "./builder";
import { BATCH_1_MODELS } from "./batch1";
import { BATCH_2_MODELS } from "./batch2";
import { BATCH_3_MODELS } from "./batch3";
import { VEHICLE_MODELS, getVehicleModelById, searchVehicleModels } from "./registry";
import type { PowertrainType } from "./types";

describe("Vehicle Models & Builder", () => {
  it("has definitions for all models in Batches 1 to 3", () => {
    expect(BATCH_1_MODELS).toHaveLength(10);
    expect(BATCH_2_MODELS).toHaveLength(10);
    expect(BATCH_3_MODELS).toHaveLength(10);
    expect(VEHICLE_MODELS).toHaveLength(30);
    for (const model of VEHICLE_MODELS) {
      expect(model.id).toBeTruthy();
      expect(model.name).toBeTruthy();
      expect(model.sketchfabUid).toMatch(/^[a-f0-9]{32}$/);
      expect(model.dimensions.length).toBeGreaterThan(3.5);
      expect(model.dimensions.length).toBeLessThan(6.0);
    }
  });

  it("builds valid 3D model for each powertrain variant", () => {
    const powertrains: PowertrainType[] = ["gasoline", "hybrid", "electric", "h2"];
    const model = BATCH_1_MODELS[0]!;

    for (const pt of powertrains) {
      const car = buildVehicleModel(model, pt);
      expect(car.root).toBeDefined();
      expect(car.pieces.length).toBeGreaterThan(60);
      expect(car.anchors.size).toBeGreaterThan(30);

      // Verify no NaN coordinates
      for (const { mesh } of car.pieces) {
        const arr = mesh.geometry.getAttribute("position").array;
        expect(Array.from(arr).some((v) => Number.isNaN(v))).toBe(false);
      }
    }
  });

  it("adds car-specific aero parts when specified on the model", () => {
    // Model 2: M4 GT3 EVO has gt_wing, front_splitter, canards, widebody_flares, rear_diffuser, roll_cage
    const gt3 = BATCH_1_MODELS.find((m) => m.id === "bmw_m4_gt3_evo_2025")!;
    expect(gt3).toBeDefined();
    const car = buildVehicleModel(gt3, "gasoline");

    const parts = new Set(car.pieces.map((p) => p.partId));
    expect(parts.has("rear_spoiler")).toBe(true);
    expect(parts.has("front_splitter")).toBe(true);
    expect(parts.has("rear_diffuser")).toBe(true);
    expect(parts.has("widebody_flares")).toBe(true);
    expect(parts.has("roll_cage")).toBe(true);
    expect(parts.has("hood_vents")).toBe(true);
    expect(parts.has("exhaust_system")).toBe(true);

    // Anchors must exist for key parts
    expect(car.anchors.has("rear_spoiler")).toBe(true);
    expect(car.anchors.has("front_splitter")).toBe(true);
    expect(car.anchors.has("rear_diffuser")).toBe(true);
    expect(car.anchors.has("roll_cage")).toBe(true);
  });

  it("searches and filters models by name, chassis and category", () => {
    const m2Results = searchVehicleModels("G87");
    expect(m2Results.length).toBeGreaterThan(0);
    expect(m2Results.every((m) => m.chassisCode === "G87")).toBe(true);

    const mModels = searchVehicleModels("", "m");
    expect(mModels.length).toBeGreaterThan(0);
  });
});
