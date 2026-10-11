import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VEHICLE_MODELS, getSourceMeshInfoById, loadSourceMeshById } from "../models/registry";
import { buildSourceVehicle } from "../converter/buildSourceVehicle";
import { buildVehicleModel } from "../models/builder";
import { availablePartIds, powertrainSubclasses, POWERTRAINS } from "./powertrains";
import { initialMarkerMenu, toggleMarkerMenu, menuPartIds } from "../markerMenu";
import * as THREE from "three";

describe("existing catalog switching integration", () => {
  it.each(VEHICLE_MODELS)(
    "matches $id to its parts/review areas/menu without duplicate powertrains",
    async (model) => {
      const source = await loadSourceMeshById(model.id);
      const car = source
        ? buildSourceVehicle(source, model.defaultPowertrain)
        : buildVehicleModel(model, model.defaultPowertrain);
      const modelled = new Set([
        ...car.pieces.map((p) => p.partId).filter((id): id is string => id !== null),
        ...(car.exteriorReviewAreas?.keys() ?? []),
      ]);
      for (const points of car.exteriorReviewAreas?.values() ?? [])
        expect(points.length).toBeGreaterThan(0);
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
    },
  );

  it("supports exploratory powertrains while preserving catalog equipment and baseline body", () => {
    const model = VEHICLE_MODELS.find(
      (m) => m.specialParts.includes("gt_wing") && !getSourceMeshInfoById(m.id),
    )!;
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

  it("switches imported schematic powertrains and preserves the source exterior", async () => {
    const source = (await loadSourceMeshById("bmw_330i_xdrive_2025"))!;
    expect(source).toBeDefined();
    const shells: string[][] = [];
    for (const option of POWERTRAINS) {
      const car = buildSourceVehicle(source, option.value);
      const available = availablePartIds(option.value, source.model);
      const modelled = new Set(
        car.pieces.map((piece) => piece.partId).filter((id): id is string => id !== null),
      );
      expect([...available].sort()).toEqual([...modelled].sort());
      expect(available.has("dashboard")).toBe(true);
      expect(available.has("front_seats")).toBe(true);
      expect(available.has("fuel_cell")).toBe(option.value === "h2");
      expect(available.has("combustion_engine")).toBe(
        option.value === "gasoline" || option.value === "hybrid",
      );
      shells.push(
        car.pieces
          .filter((piece) => piece.layer === "exterior")
          .map((piece) => {
            const array = piece.mesh.geometry.getAttribute("position").array;
            return createHash("sha256")
              .update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength))
              .digest("hex");
          }),
      );
      const menus = powertrainSubclasses(option.value, source.model).flatMap(
        (group) => group.partIds,
      );
      expect([...menus].sort()).toEqual([...available].sort());
      for (const piece of car.pieces) {
        piece.mesh.geometry.dispose();
        (piece.mesh.material as THREE.Material).dispose();
      }
    }
    for (const shell of shells.slice(1)) expect(shell).toEqual(shells[0]);
  });

  it("activates optional equipment markers and closes them with their parent", () => {
    const model = VEHICLE_MODELS.find(
      (m) => m.specialParts.includes("gt_wing") && !getSourceMeshInfoById(m.id),
    )!;
    const menus = powertrainSubclasses("electric", model);
    const state = toggleMarkerMenu(initialMarkerMenu(), "model_exterior");
    expect(state.active).toBe("model_exterior");
    expect(menuPartIds(state.active, menus)).toContain("rear_spoiler");
    const closed = toggleMarkerMenu(state, "exterior");
    expect(closed.active).toBe(null);
    expect(closed.expanded.has("model_exterior")).toBe(false);
  });
});
