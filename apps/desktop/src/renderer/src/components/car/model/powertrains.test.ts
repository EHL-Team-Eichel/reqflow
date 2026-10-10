import { CarPowertrain } from "@reqflow/core";
import { afterAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { CAR_PARTS } from "../parts";
import { PART_SUBCLASSES } from "../partMenu";
import { buildCar, type CarPiece } from "./buildCar";
import { CAR_MODELS, isModelPartAvailable, modelMenuParts } from "./powertrains";
import { exteriorBadgeTargets, isPieceVisible } from "./visibility";

describe("car powertrain models", () => {
  const models = Object.fromEntries(CarPowertrain.options.map((p) => [p, buildCar(p)])) as Record<
    CarPowertrain,
    ReturnType<typeof buildCar>
  >;
  afterAll(() => {
    for (const car of Object.values(models)) {
      for (const { mesh } of car.pieces) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      for (const line of car.sketchLines) line.dispose();
    }
  });

  it.each(CarPowertrain.options)(
    "models and anchors exactly the available %s parts",
    (powertrain) => {
      const car = models[powertrain];
      const expected = CAR_PARTS.filter((p) => isModelPartAvailable(p.id, powertrain))
        .map((p) => p.id)
        .sort();
      expect([...car.anchors.keys()].sort()).toEqual(expected);
      expect([...new Set(car.pieces.map((p) => p.partId).filter(Boolean))].sort()).toEqual(
        expected,
      );
      expect(CAR_MODELS[powertrain].label).toBeTruthy();
      for (const anchor of car.anchors.values())
        expect(anchor.toArray().every(Number.isFinite)).toBe(true);
      for (const { mesh } of car.pieces)
        expect(
          Array.from(mesh.geometry.getAttribute("position").array).every(Number.isFinite),
        ).toBe(true);
    },
  );

  const signature = (pieces: CarPiece[]) =>
    pieces.map(({ mesh, partId, kind, layer }) => [
      partId,
      kind,
      layer,
      mesh.position.toArray(),
      mesh.rotation.toArray(),
      mesh.geometry.getAttribute("position").array.toString(),
    ]);
  it.each(["hydrogen", "hybrid", "fuel"] as const)(
    "keeps the same shell, cabin and chassis for %s",
    (powertrain) => {
      const shared = (p: CarPiece) =>
        p.partId === null ||
        (CarPowertrain.options.every((m) => isModelPartAvailable(p.partId!, m)) &&
          !["motor", "transmission", "inverter"].includes(p.partId!));
      expect(signature(models[powertrain].pieces.filter(shared))).toEqual(
        signature(models.electric.pieces.filter(shared)),
      );
      expect(
        models[powertrain].sketchLines.map((g) => g.getAttribute("position").array.toString()),
      ).toEqual(
        models.electric.sketchLines.map((g) => g.getAttribute("position").array.toString()),
      );
    },
  );

  it("uses smaller hybrid and hydrogen batteries and an engine instead of an electric front motor", () => {
    const volume = (p: CarPowertrain) => {
      const battery = models[p].pieces.find((piece) => piece.partId === "battery_pack")!.mesh;
      const size = new THREE.Box3().setFromObject(battery).getSize(new THREE.Vector3());
      return size.x * size.y * size.z;
    };
    expect(volume("hydrogen")).toBeLessThan(volume("hybrid"));
    expect(volume("hybrid")).toBeLessThan(volume("electric"));
    expect(models.fuel.pieces.find((p) => p.partId === "motor")!.mesh.geometry.type).toBe(
      "RoundedBoxGeometry",
    );
    expect(models.electric.pieces.find((p) => p.partId === "motor")!.mesh.geometry.type).toBe(
      "CylinderGeometry",
    );
    expect(
      models.hydrogen.pieces.filter(
        (p) => p.partId === "hydrogen_tanks" && p.mesh.geometry.type === "CylinderGeometry",
      ),
    ).toHaveLength(2);
  });

  it.each(CarPowertrain.options)(
    "keeps %s internal powertrain components invisible in Exterior",
    (powertrain) => {
      const car = models[powertrain];
      const targets = exteriorBadgeTargets(car.pieces, car.anchors);
      for (const id of [
        "motor",
        "rear_motor",
        "battery_pack",
        "fuel_cell",
        "hydrogen_tanks",
        "fuel_tank",
        "exhaust_system",
      ])
        expect(targets.has(id)).toBe(false);
      for (const p of car.pieces.filter((p) => p.layer === "interior")) {
        expect(isPieceVisible(p, "exterior")).toBe(false);
        expect(isPieceVisible(p, "interior")).toBe(true);
      }
    },
  );

  it("keeps every component in the menu once and preserves off-model requirements", () => {
    const ids = PART_SUBCLASSES.flatMap((s) => s.partIds);
    expect(new Set(ids).size).toBe(CAR_PARTS.length);
    expect(
      modelMenuParts(["motor", "fuel_cell", "battery_pack", "charging_port"], "fuel", new Map()),
    ).toEqual(["motor"]);
    expect(
      modelMenuParts(
        ["motor", "fuel_cell", "battery_pack", "charging_port"],
        "fuel",
        new Map([["charging_port", 3]]),
      ),
    ).toEqual(["motor", "charging_port"]);
  });

  it("rejects unknown model values before building geometry", () => {
    expect(() => buildCar("unknown" as CarPowertrain)).toThrow();
  });
});
