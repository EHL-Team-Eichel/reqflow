import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { classifyRequirement } from "../classify";
import { PART_SUBCLASSES } from "../partMenu";
import { buildCar } from "./buildCar";

describe("driver pedals and brake pads", () => {
  const car = buildCar();
  const face = (partId: string) =>
    car.pieces.find((p) => p.partId === partId && p.mesh.userData.pedalComponent === "face")!;

  it("fits distinct pedals ahead of the driver, above the floor and below the dashboard", () => {
    const gas = face("accelerator_pedal");
    const brake = face("brake_pedal");
    const driver = car.pieces.find((p) => p.mesh.userData.seatPosition === "driver")!.mesh;
    const floor = new THREE.Box3().setFromObject(
      car.pieces.find((p) => p.partId === "battery_pack")!.mesh,
    );
    const dash = new THREE.Box3().setFromObject(
      car.pieces.find((p) => p.partId === "dashboard")!.mesh,
    );
    const gasBounds = new THREE.Box3().setFromObject(gas.mesh);
    const brakeBounds = new THREE.Box3().setFromObject(brake.mesh);
    expect(brakeBounds.max.z).toBeLessThan(gasBounds.min.z);
    expect(gasBounds.max.y - gasBounds.min.y).toBeGreaterThan(
      brakeBounds.max.y - brakeBounds.min.y,
    );
    expect(brakeBounds.max.z - brakeBounds.min.z).toBeGreaterThan(
      gasBounds.max.z - gasBounds.min.z,
    );
    for (const p of [gas, brake]) {
      expect(p.layer).toBe("interior");
      const bounds = new THREE.Box3().setFromObject(p.mesh);
      expect(bounds.min.x).toBeGreaterThan(driver.position.x + 0.3);
      expect(bounds.max.z).toBeLessThan(0);
      expect(bounds.min.y).toBeGreaterThan(floor.max.y);
      expect(bounds.max.y).toBeLessThan(dash.min.y);
      expect(car.anchors.has(p.partId!)).toBe(true);
      expect(bounds.containsPoint(car.anchors.get(p.partId!)!)).toBe(true);
      expect(
        car.pieces.filter(
          (piece) => piece.partId === p.partId && piece.mesh.userData.pedalComponent === "grip",
        ),
      ).toHaveLength(3);
      expect(
        car.pieces.some(
          (piece) => piece.partId === p.partId && piece.mesh.userData.pedalComponent === "arm",
        ),
      ).toBe(true);
    }
  });

  it("places two friction pads on opposing disc faces at every wheel without intersecting the disc", () => {
    const pads = car.pieces.filter((p) => p.partId === "brake_pads");
    const discs = car.pieces.filter((p) => p.partId === "brake_discs");
    expect(pads).toHaveLength(8);
    expect(discs).toHaveLength(4);
    for (const { mesh: disc } of discs) {
      const pair = pads.filter(
        (p) =>
          Math.abs(p.mesh.position.x - (disc.position.x - 0.13)) < 1e-6 &&
          Math.abs(p.mesh.position.z - disc.position.z) < 0.03,
      );
      expect(pair).toHaveLength(2);
      const discBounds = new THREE.Box3().setFromObject(disc);
      const bounds = pair.map((p) => new THREE.Box3().setFromObject(p.mesh));
      expect(bounds.some((b) => b.max.z < discBounds.min.z)).toBe(true);
      expect(bounds.some((b) => b.min.z > discBounds.max.z)).toBe(true);
      for (const p of pair) {
        expect(p.layer).toBe("exterior");
        expect(
          Math.hypot(p.mesh.position.x - disc.position.x, p.mesh.position.y - disc.position.y),
        ).toBeLessThan(0.19);
      }
    }
    expect(car.anchors.has("brake_pads")).toBe(true);
    const anchor = car.anchors.get("brake_pads")!;
    expect(pads.some((p) => p.mesh.position.distanceTo(anchor) < 0.02)).toBe(true);
  });

  it.each([
    ["Gas pedal grip", "accelerator_pedal", "cockpit_controls"],
    ["Accelerator pedal reach", "accelerator_pedal", "cockpit_controls"],
    ["Brake pedal feel", "brake_pedal", "cockpit_controls"],
    ["Bremspedal", "brake_pedal", "cockpit_controls"],
    ["Brake pad noise", "brake_pads", "braking"],
    ["Bremsbeläge", "brake_pads", "braking"],
  ])("routes %s to its selectable component", (title, partId, menu) => {
    const result = classifyRequirement({
      title,
      description: "",
      category: "driving_experience",
      targets: [],
    });
    expect(result.partId).toBe(partId);
    expect(PART_SUBCLASSES.find((s) => s.id === menu)!.partIds).toContain(partId);
  });
});
