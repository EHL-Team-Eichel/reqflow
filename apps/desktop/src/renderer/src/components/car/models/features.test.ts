import { afterEach, describe, expect, it, vi } from "vitest";
import * as registry from "./registry";
import {
  VEHICLE_MODELS,
  BUILT_IN_VEHICLE_MODELS,
  getVehicleModelById,
  DEFAULT_MODEL_ID,
} from "./registry";
import {
  isTwoDoor,
  isTwoSeater,
  isSingleSeaterRaceCar,
  isConvertible,
  isSuv,
  isTouring,
  isWidebody,
  modelExcludedPartIds,
} from "./features";
import { buildVehicleModel } from "./builder";
import { availablePartIds } from "../modelSwitcher/powertrains";

const getProceduralModel = (id: string) => BUILT_IN_VEHICLE_MODELS.find((model) => model.id === id);
afterEach(() => vi.restoreAllMocks());

describe("Procedural vehicle features and class recognition", () => {
  it("defaults to the 2025 BMW M5 Sedan as the standard benchmark model", () => {
    expect(DEFAULT_MODEL_ID).toBe("bmw_m5_sedan_g90_2025");
    expect(VEHICLE_MODELS[0]!.id).toBe("bmw_m5_sedan_g90_2025");
    const m5 = getVehicleModelById("bmw_m5_sedan_g90_2025");
    expect(m5).toBeDefined();
    expect(m5!.series).toBe("M5");
    expect(m5!.chassisCode).toBe("G90");
    expect(m5!.bodyType).toBe("sedan");
    expect(isTwoDoor(m5)).toBe(false);
    expect(isTwoSeater(m5)).toBe(false);
    expect(isSingleSeaterRaceCar(m5)).toBe(false);

    // M5 has full 4-door, 5-seater appointments with no exclusions
    const excluded = modelExcludedPartIds(m5);
    expect(excluded.size).toBe(0);

    const car = buildVehicleModel(m5, "hybrid");
    const parts = new Set(car.pieces.map((p) => p.partId));
    expect(parts.has("rear_doors")).toBe(true);
    expect(parts.has("driver_seat")).toBe(true);
    expect(parts.has("passenger_seat")).toBe(true);
    expect(parts.has("rear_seats")).toBe(true);
    expect(parts.has("rear_spoiler")).toBe(true);
    expect(parts.has("rear_diffuser")).toBe(true);
    expect(parts.has("exhaust_system")).toBe(true);
  });

  it("removes rear doors from 2-door coupes while retaining frameless front doors", () => {
    const m2 = getProceduralModel("bmw_m2_cs_2026")!;
    expect(m2).toBeDefined();
    expect(isTwoDoor(m2)).toBe(true);
    expect(isTwoSeater(m2)).toBe(false);

    const excluded = modelExcludedPartIds(m2);
    expect(excluded.has("rear_doors")).toBe(true);
    expect(excluded.has("rear_seats")).toBe(false);

    // This test covers procedural menus; imported menus combine source exterior parts with the standard interior.
    vi.spyOn(registry, "getSourceMeshInfoById").mockReturnValue(undefined);
    const available = availablePartIds("gasoline", m2);
    expect(available.has("rear_doors")).toBe(false);
    expect(available.has("front_doors")).toBe(true);
    expect(available.has("rear_seats")).toBe(true);

    const car = buildVehicleModel(m2, "gasoline");
    const pieces = car.pieces.map((p) => p.partId);
    expect(pieces.includes("rear_doors")).toBe(false);
    expect(pieces.includes("front_doors")).toBe(true);
    expect(car.anchors.has("rear_doors")).toBe(false);
    expect(car.anchors.has("front_doors")).toBe(true);
  });

  it("removes rear seats and rear console air vents from 2-seaters", () => {
    const z4 = getProceduralModel("bmw_z4_m40i_g29_2019")!;
    expect(z4).toBeDefined();
    expect(isTwoDoor(z4)).toBe(true);
    expect(isTwoSeater(z4)).toBe(true);

    const excluded = modelExcludedPartIds(z4);
    expect(excluded.has("rear_doors")).toBe(true);
    expect(excluded.has("rear_seats")).toBe(true);
    expect(excluded.has("rear_left_seat")).toBe(true);
    expect(excluded.has("rear_center_seat")).toBe(true);
    expect(excluded.has("rear_right_seat")).toBe(true);
    expect(excluded.has("rear_air_vents")).toBe(true);

    const car = buildVehicleModel(z4, "gasoline");
    const pieces = car.pieces.map((p) => p.partId);
    expect(pieces.includes("rear_seats")).toBe(false);
    expect(pieces.includes("rear_left_seat")).toBe(false);
    expect(pieces.includes("rear_center_seat")).toBe(false);
    expect(pieces.includes("rear_right_seat")).toBe(false);
    expect(pieces.includes("rear_air_vents")).toBe(false);
    expect(car.anchors.has("rear_seats")).toBe(false);
    expect(car.pieces.filter((piece) => piece.partId === "headrests")).toHaveLength(2);
    expect(car.pieces.filter((piece) => piece.partId === "seat_belts")).toHaveLength(2);
    expect(car.pieces.filter((piece) => piece.partId === "front_seats")).toHaveLength(2);
  });

  it("strips passenger seat and luxury comfort items from dedicated GT3/GT4/DTM/GTR race cars", () => {
    // Exercise the legacy procedural builder; source-mesh menus/geometry have their own integration test.
    const gt3 = BUILT_IN_VEHICLE_MODELS.find((model) => model.id === "bmw_m4_gt3_evo_2025")!;
    expect(gt3).toBeDefined();
    expect(isSingleSeaterRaceCar(gt3)).toBe(true);

    const excluded = modelExcludedPartIds(gt3);
    expect(excluded.has("rear_doors")).toBe(true);
    expect(excluded.has("rear_seats")).toBe(true);
    expect(excluded.has("passenger_seat")).toBe(true);
    expect(excluded.has("cup_holders")).toBe(true);
    expect(excluded.has("armrest")).toBe(true);
    expect(excluded.has("glovebox")).toBe(true);
    expect(excluded.has("wireless_charger")).toBe(true);

    const car = buildVehicleModel(gt3, "gasoline");
    const pieces = car.pieces.map((p) => p.partId);
    expect(pieces.includes("passenger_seat")).toBe(false);
    expect(pieces.includes("cup_holders")).toBe(false);
    expect(pieces.includes("armrest")).toBe(false);
    expect(pieces.includes("glovebox")).toBe(false);
    expect(pieces.includes("wireless_charger")).toBe(false);

    expect(car.pieces.filter((piece) => piece.partId === "headrests")).toHaveLength(1);
    expect(car.pieces.filter((piece) => piece.partId === "seat_belts")).toHaveLength(1);
    expect(car.pieces.filter((piece) => piece.partId === "front_seats")).toHaveLength(1);

    // Single lightweight driver seat and racing roll cage remain
    expect(pieces.includes("driver_seat")).toBe(true);
    expect(pieces.includes("roll_cage")).toBe(true);
    expect(pieces.includes("front_splitter")).toBe(true);
    expect(pieces.includes("rear_spoiler")).toBe(true);
    expect(pieces.includes("rear_diffuser")).toBe(true);
    expect(pieces.includes("widebody_flares")).toBe(true);
    expect(pieces.includes("hood_vents")).toBe(true);
  });

  it("adds SUV equipment (roof rails and skid plates) and raises ride height", () => {
    const x5 = getProceduralModel("bmw_x5_xdrive40i_2024")!;
    expect(x5).toBeDefined();
    expect(isSuv(x5)).toBe(true);
    expect(isTwoDoor(x5)).toBe(false);

    const car = buildVehicleModel(x5, "gasoline");
    const pieces = car.pieces.map((p) => p.partId);
    expect(pieces.includes("roof_rails")).toBe(true);
    expect(pieces.includes("skid_plates")).toBe(true);
    expect(car.anchors.has("roof_rails")).toBe(true);
    expect(car.anchors.has("skid_plates")).toBe(true);

    // SUV ride height is elevated above baseline
    expect(car.root.position.y).toBeGreaterThan(0);
  });

  it("adds estate wagon features (extended roofline and roof rails) to Touring models", () => {
    const touring = getProceduralModel("bmw_m3_touring_g81_2023")!;
    expect(touring).toBeDefined();
    expect(isTouring(touring)).toBe(true);

    const car = buildVehicleModel(touring, "gasoline");
    const pieces = car.pieces.map((p) => p.partId);
    expect(pieces.includes("roof_rails")).toBe(true);
    expect(pieces.includes("rear_spoiler")).toBe(true);
    expect(car.anchors.has("roof_rails")).toBe(true);
  });

  it("adds soft-top canopy and rollover protection to convertibles", () => {
    const m4Cabrio = getProceduralModel("bmw_m4_convertible_f83_2018")!;
    expect(m4Cabrio).toBeDefined();
    expect(isConvertible(m4Cabrio)).toBe(true);

    const car = buildVehicleModel(m4Cabrio, "gasoline");
    const pieces = car.pieces.map((p) => p.partId);
    expect(pieces.includes("convertible_roof")).toBe(true);
    expect(car.anchors.has("convertible_roof")).toBe(true);
  });

  it("proportionally scales 3D model dimensions and anchors", () => {
    const z4 = getProceduralModel("bmw_z4_sdrive35is_2014")!;
    const carZ4 = buildVehicleModel(z4, "gasoline");
    // Z4 is compact (4.24m length vs 5.06m baseline)
    expect(carZ4.root.scale.x).toBeLessThan(0.9);
    expect(carZ4.root.scale.y).toBeLessThan(0.9);

    const x7 = getProceduralModel("bmw_x7_xdrive40i_2019")!;
    const carX7 = buildVehicleModel(x7, "gasoline");
    // X7 is tall (1.805m height vs 1.515m baseline)
    expect(carX7.root.scale.y).toBeGreaterThan(1.15);
  });
});
