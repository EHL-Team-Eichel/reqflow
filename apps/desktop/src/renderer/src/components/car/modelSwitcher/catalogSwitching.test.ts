import { describe, expect, it } from "vitest";
import { VEHICLE_MODELS } from "../models/registry";
import { buildVehicleModel } from "../models/builder";
import { availablePartIds, powertrainSubclasses, POWERTRAINS } from "./powertrains";
import { initialMarkerMenu, toggleMarkerMenu, menuPartIds } from "../markerMenu";
import * as THREE from "three";

describe("existing catalog switching integration", () => {
  it("matches every catalog sketch to its available parts/menu without duplicate powertrains", () => {
    for (const model of VEHICLE_MODELS) {
      const car = buildVehicleModel(model, model.defaultPowertrain);
      const modelled = new Set(
        car.pieces.map((p) => p.partId).filter((id): id is string => id !== null),
      );
      const available = availablePartIds(model.defaultPowertrain, model);
      expect([...modelled].sort(), model.id).toEqual([...available].sort());
      const menus = powertrainSubclasses(model.defaultPowertrain, model);
      const ids = menus.flatMap((s) => s.partIds);
      expect([...ids].sort()).toEqual([...available].sort());
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of available) expect(car.anchors.has(id), model.id + ":" + id).toBe(true);
      for (const p of car.pieces) {
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
      }
      for (const line of car.sketchLines) line.dispose();
    }
  });

  it("supports exploratory powertrains while preserving catalog equipment and baseline body", () => {
    const model = VEHICLE_MODELS.find((m) => m.specialParts.includes("gt_wing"))!;
    for (const option of POWERTRAINS) {
      const car = buildVehicleModel(model, option.value);
      const modelled = new Set(
        car.pieces.map((p) => p.partId).filter((id): id is string => id !== null),
      );
      expect([...modelled].sort()).toEqual([...availablePartIds(option.value, model)].sort());
      expect(car.pieces.filter((p) => p.partId === "battery_pack")).toHaveLength(
        option.value === "gasoline" ? 0 : 1,
      );
      expect(car.pieces.some((p) => p.partId === "rear_window")).toBe(true);
      expect(car.pieces.some((p) => p.partId === "side_windows")).toBe(true);
      for (const p of car.pieces) {
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
      }
      for (const line of car.sketchLines) line.dispose();
    }
  });

  it("activates optional equipment markers and closes them with their parent", () => {
    const model = VEHICLE_MODELS.find((m) => m.specialParts.includes("gt_wing"))!;
    const menus = powertrainSubclasses("electric", model);
    const state = toggleMarkerMenu(initialMarkerMenu(), "model_exterior");
    expect(state.active).toBe("model_exterior");
    expect(menuPartIds(state.active, menus)).toContain("rear_spoiler");
    const closed = toggleMarkerMenu(state, "exterior");
    expect(closed.active).toBe(null);
    expect(closed.expanded.has("model_exterior")).toBe(false);
  });
});
