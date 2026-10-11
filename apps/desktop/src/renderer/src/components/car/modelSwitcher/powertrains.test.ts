import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildCar } from "../model/buildCar";
import { classifyRequirement, groupByPart } from "../classify";
import { PARTS_BY_ID } from "../parts";
import { menuPartIds } from "../markerMenu";
import { fixtureRequirements } from "@reqflow/core/fixtures";
import {
  availablePartIds,
  powertrainSubclasses,
  POWERTRAINS,
  retainedRequirementParts,
} from "./powertrains";

const expected = {
  electric: {
    present: ["motor", "rear_motor", "battery_pack", "inverter", "charging_port"],
    absent: ["combustion_engine", "fuel_system", "exhaust_system", "fuel_cell", "h2_storage"],
  },
  hybrid: {
    present: [
      "combustion_engine",
      "rear_motor",
      "battery_pack",
      "inverter",
      "charging_port",
      "fuel_system",
      "exhaust_system",
    ],
    absent: ["motor", "fuel_cell", "h2_storage"],
  },
  h2: {
    present: ["rear_motor", "battery_pack", "inverter", "fuel_cell", "h2_storage"],
    absent: ["motor", "combustion_engine", "charging_port", "fuel_system", "exhaust_system"],
  },
  gasoline: {
    present: ["combustion_engine", "fuel_system", "exhaust_system"],
    absent: [
      "motor",
      "rear_motor",
      "battery_pack",
      "inverter",
      "charging_port",
      "fuel_cell",
      "h2_storage",
    ],
  },
};

describe("powertrain switching", () => {
  for (const option of POWERTRAINS) {
    it(`${option.label} has the appropriate clickable components, menu and finite geometry`, () => {
      const car = buildCar(option.value);
      const modelled = new Set(
        car.pieces.map((p) => p.partId).filter((id): id is string => id !== null),
      );
      const available = availablePartIds(option.value);
      expect([...modelled].sort()).toEqual([...available].sort());
      for (const id of expected[option.value].present) {
        expect(modelled.has(id)).toBe(true);
        expect(car.anchors.has(id)).toBe(true);
      }
      for (const id of expected[option.value].absent) expect(modelled.has(id)).toBe(false);
      const menus = powertrainSubclasses(option.value);
      const ids = menus.flatMap((s) => s.partIds);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual([...available].sort());
      for (const s of menus)
        for (const id of s.partIds) expect(PARTS_BY_ID.get(id)?.group).toBe(s.group);
      expect(menuPartIds("power_chassis", menus)).toEqual(
        menus.find((s) => s.id === "power_chassis")?.partIds,
      );
      for (const { mesh } of car.pieces) {
        expect(
          Array.from(mesh.geometry.getAttribute("position").array).every(Number.isFinite),
        ).toBe(true);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      for (const line of car.sketchLines) line.dispose();
    });
  }

  it("shrinks the hybrid traction and H2 buffer batteries relative to electric", () => {
    const volume = (powertrain: "electric" | "hybrid" | "h2") => {
      const car = buildCar(powertrain);
      const mesh = car.pieces.find((p) => p.partId === "battery_pack")!.mesh;
      const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
      for (const p of car.pieces) {
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
      }
      for (const line of car.sketchLines) line.dispose();
      return size.x * size.y * size.z;
    };
    expect(volume("hybrid")).toBeLessThan(volume("electric") / 2);
    expect(volume("h2")).toBeLessThan(volume("hybrid"));
  }, 15000);

  it("classifies combustion, fuel, exhaust and hydrogen stack requirements independently", () => {
    for (const [title, id] of [
      ["Combustion engine refinement", "combustion_engine"],
      ["Engine refinement", "combustion_engine"],
      ["Fuel tank usability", "fuel_system"],
      ["Exhaust system sound", "exhaust_system"],
      ["Fuel cell stack response", "fuel_cell"],
      ["Hydrogen storage access", "h2_storage"],
    ]) {
      expect(
        classifyRequirement({
          title: title!,
          description: "",
          category: "driving_experience",
          targets: [],
        }).partId,
      ).toBe(id);
    }
  });

  it("keeps every original requirement identity, assignment and count through repeated switches", () => {
    const requirements = [
      ...fixtureRequirements,
      {
        ...fixtureRequirements[0]!,
        id: "synthetic-battery",
        title: "Battery pack range",
        description: "Battery pack",
        targets: [],
      },
    ];
    const original = JSON.stringify(requirements);
    const grouped = groupByPart(requirements);
    const counts = new Map([...grouped].map(([id, items]) => [id, items.length]));
    for (const option of [...POWERTRAINS, ...POWERTRAINS].reverse()) {
      const available = availablePartIds(option.value);
      const retained = retainedRequirementParts(available, counts);
      const visible = new Set(["whole_car", ...available, ...retained]);
      for (const [id, items] of grouped) {
        expect(visible.has(id)).toBe(true);
        for (const item of items) expect(requirements).toContain(item.requirement);
      }
      expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(requirements.length);
    }
    expect(retainedRequirementParts(availablePartIds("gasoline"), counts)).toContain(
      "battery_pack",
    );
    expect(JSON.stringify(requirements)).toBe(original);
  });
});
