import { describe, expect, it } from "vitest";
import { CAR_PARTS } from "../parts";
import { buildCar } from "./buildCar";
import { buildBodyGrid, G60, RING, STATIONS, topLine } from "./body";
import * as THREE from "three";
import { isModelPartAvailable } from "./powertrains";

describe("buildCar", () => {
  const car = buildCar();

  it("has a clickable mesh and a badge anchor for every part available on the electric model", () => {
    expect(CAR_PARTS).toHaveLength(73);
    const available = CAR_PARTS.filter((p) => isModelPartAvailable(p.id, "electric"));
    const modelled = new Set(car.pieces.map((p) => p.partId).filter(Boolean));
    const missing = available.map((p) => p.id).filter((id) => !modelled.has(id));
    expect(missing).toEqual([]);
    for (const part of available) expect(car.anchors.has(part.id)).toBe(true);
  });

  it("gives detailed drive units separate meshes instead of duplicating an assembly label", () => {
    const ids = [
      "motor",
      "rear_motor",
      "transmission",
      "battery_pack",
      "inverter",
      "cooling_system",
      "drive_shafts",
      "differential",
    ];
    const meshes = ids.map((id) => car.pieces.find((p) => p.partId === id)!.mesh);
    expect(new Set(meshes).size).toBe(ids.length);
    const front = meshes[0]!;
    const rear = meshes[1]!;
    expect(front.position.x).toBe(G60.frontAxleX);
    expect(rear.position.x).toBe(G60.rearAxleX);
    for (const id of ids) {
      expect(car.pieces.filter((p) => p.partId === id).every((p) => p.layer === "interior")).toBe(
        true,
      );
      expect(car.anchors.has(id)).toBe(true);
    }
  });

  it("only uses part ids from the catalog", () => {
    const known = new Set(CAR_PARTS.map((p) => p.id));
    const unknown = car.pieces.map((p) => p.partId).filter((id) => id !== null && !known.has(id));
    expect(unknown).toEqual([]);
  });

  it("has a shortened nose with the original cabin height, width and rear endpoint", () => {
    const body = car.pieces.filter(
      (p) => p.kind === "paint" && p.partId !== "mirrors" && p.partId !== "antenna",
    );
    let [minX, maxX, maxY, maxZ] = [Infinity, -Infinity, -Infinity, -Infinity];
    for (const { mesh } of body) {
      mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
      minX = Math.min(minX, b.min.x);
      maxX = Math.max(maxX, b.max.x);
      maxY = Math.max(maxY, b.max.y);
      maxZ = Math.max(maxZ, b.max.z);
    }
    expect(maxX - minX).toBeCloseTo(4.73, 1);
    expect(maxX).toBeCloseTo(2.2, 2);
    expect(minX).toBeCloseTo(-2.53, 2);
    expect(maxY).toBeCloseTo(1.515, 1);
    expect(2 * maxZ).toBeGreaterThan(1.85);
    expect(2 * maxZ).toBeLessThan(1.95);
  });

  it("builds every geometry without NaNs", () => {
    for (const { mesh } of car.pieces) {
      const pos = mesh.geometry.getAttribute("position").array;
      expect(Array.from(pos).some((v) => Number.isNaN(v))).toBe(false);
    }
  });

  it("mounts four tyres on the arch centres, inside the body width and on the ground", () => {
    const tyres = car.pieces.filter((p) => p.kind === "tyre");
    expect(tyres).toHaveLength(4);
    const mounts = new Set<string>();
    for (const { mesh } of tyres) {
      const { x, y, z } = mesh.position;
      expect([G60.frontAxleX, G60.rearAxleX]).toContain(x);
      expect(y).toBe(G60.tyreRadius);
      expect(Math.abs(z)).toBe(G60.track / 2);
      mounts.add(`${x}:${Math.sign(z)}`);
      const bounds = new THREE.Box3().setFromObject(mesh);
      expect(bounds.min.y).toBeCloseTo(0, 3);
      expect(Math.max(Math.abs(bounds.min.z), Math.abs(bounds.max.z))).toBeLessThan(G60.width / 2);
      expect(bounds.getSize(new THREE.Vector3()).z).toBeCloseTo(G60.tyreWidth, 2);
      // The tyre envelope clears the arch rather than being detached beside the car.
      expect(bounds.max.y).toBeLessThan(G60.tyreRadius + G60.archRadius);
    }
    expect(mounts.size).toBe(4);
    expect(G60.frontAxleX - G60.rearAxleX).toBeCloseTo(G60.wheelbase, 5);
  });

  it("preserves both front seat assemblies, all three rear places and the LHD cockpit", () => {
    const front = car.pieces.filter(
      (p) =>
        ["front_seats", "driver_seat", "passenger_seat", "headrests"].includes(p.partId ?? "") &&
        Math.abs(p.mesh.position.z) === 0.38,
    );
    const rear = car.pieces.filter(
      (p) =>
        [
          "rear_seats",
          "rear_left_seat",
          "rear_center_seat",
          "rear_right_seat",
          "headrests",
        ].includes(p.partId ?? "") && [-0.45, 0, 0.45].includes(p.mesh.position.z),
    );
    expect(front).toHaveLength(6); // cushions, backrests and headrests
    expect(rear).toHaveLength(9);
    for (const z of [-0.38, 0.38])
      expect(front.filter((p) => p.mesh.position.z === z)).toHaveLength(3);
    for (const z of [-0.45, 0, 0.45])
      expect(rear.filter((p) => p.mesh.position.z === z)).toHaveLength(3);
    const driver = front.find((p) => p.mesh.userData.seatPosition === "driver")!.mesh;
    const passenger = front.find((p) => p.mesh.userData.seatPosition === "front_passenger")!.mesh;
    expect(driver.position.z).toBeLessThan(0);
    expect(passenger.position.z).toBeGreaterThan(0);
    const steering = car.pieces.find((p) => p.partId === "steering_wheel")!.mesh;
    expect(steering.position.z).toBe(driver.position.z);
    expect(steering.position.x).toBeGreaterThan(driver.position.x);
    expect([...front, ...rear].every((p) => p.layer === "interior")).toBe(true);
  });

  it("draws smooth, mirrored reference strokes without long jumps across missing surfaces", () => {
    expect(car.sketchLines).toHaveLength(10);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < 5; i++) {
      const left = car.sketchLines[i]!.getAttribute("position");
      const right = car.sketchLines[i + 5]!.getAttribute("position");
      expect(left.count).toBeGreaterThan(100);
      expect(left.count).toBe(right.count);
      for (let k = 0; k < left.count; k++) {
        expect(left.getX(k)).toBeCloseTo(right.getX(k), 4);
        // The independently triangulated panels can differ slightly at a seam.
        // Keep mirrored strokes within the 3 mm surface lift used by the sketch.
        a.fromBufferAttribute(left, k);
        b.fromBufferAttribute(right, k);
        b.z = -b.z;
        expect(a.distanceTo(b)).toBeLessThan(0.003);
      }
      for (let k = 0; k < left.count; k += 2) {
        a.fromBufferAttribute(left, k);
        b.fromBufferAttribute(left, k + 1);
        expect(a.distanceTo(b)).toBeLessThan(0.12);
      }
    }
  });

  it("keeps the inner floor level through both wheel arches", () => {
    const grid = buildBodyGrid();
    for (let i = 0; i < STATIONS; i++) {
      const k = i * RING * 3;
      // Ring vertex zero is the centre of the underfloor, not the wheel opening.
      expect(grid.positions[k]).toBeCloseTo(grid.stationX[i]!, 5);
      expect(grid.positions[k + 1]).toBeGreaterThan(0.15);
    }
    const painted = car.pieces.filter((p) => p.kind === "paint");
    const vertex = new THREE.Vector3();
    for (const { mesh } of painted) {
      const pos = mesh.geometry.getAttribute("position");
      for (let k = 0; k < pos.count; k++) {
        vertex.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld);
        expect(vertex.y).toBeGreaterThan(0);
      }
    }
  });

  it("bounds each panel using its own vertices", () => {
    for (const id of ["front_doors", "rear_doors", "hood", "trunk_lid"]) {
      const panel = car.pieces.find((p) => p.partId === id && p.kind === "paint")!;
      const position = panel.mesh.geometry.getAttribute("position");
      const index = panel.mesh.geometry.getIndex()!;
      const used = new Set(Array.from(index.array));
      expect(used.size).toBe(position.count);
      expect(panel.mesh.geometry.boundingBox!.getSize(new THREE.Vector3()).x).toBeLessThan(
        G60.length / 2,
      );
    }
  });

  it("keeps rear seat headrests inside the sloping cabin", () => {
    const vertex = new THREE.Vector3();
    for (const { mesh } of car.pieces.filter(
      (p) =>
        [
          "rear_seats",
          "rear_left_seat",
          "rear_center_seat",
          "rear_right_seat",
          "headrests",
        ].includes(p.partId ?? "") && p.mesh.position.x < -0.7,
    )) {
      const pos = mesh.geometry.getAttribute("position");
      for (let k = 0; k < pos.count; k++) {
        vertex.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld);
        expect(vertex.y).toBeLessThan(topLine(vertex.x) - 0.03);
      }
    }
  });

  it("keeps the detailed trunk selectable and its lip fitted to the rear deck", () => {
    const detail = (name: string) =>
      car.pieces.filter((p) => p.mesh.geometry.userData.detail === name);
    for (const name of [
      "plate_recess",
      "plate_surround",
      "rear_roundel",
      "trunk_handle",
      "trunk_lip",
    ]) {
      const pieces = detail(name);
      expect(pieces).toHaveLength(1);
      expect(pieces[0]!.partId).toBe("trunk_lid");
      expect(pieces[0]!.layer).toBe("exterior");
    }
    expect(detail("rear_led")).toHaveLength(4);
    expect(detail("rear_reflector")).toHaveLength(2);
    expect(detail("parking_sensor")).toHaveLength(4);
    expect(detail("diffuser_rib")).toHaveLength(5);
    const lid = car.pieces.find((p) => p.partId === "trunk_lid" && p.kind === "paint")!.mesh;
    expect(lid.geometry.boundingBox!.min.y).toBeLessThan(0.8);
    const targets = car.pieces.filter((p) => p.kind === "paint").map((p) => p.mesh);
    const raycaster = new THREE.Raycaster();
    const lip = detail("trunk_lip")[0]!.mesh.geometry.getAttribute("position");
    for (let i = 0; i < lip.count; i++) {
      raycaster.set(new THREE.Vector3(lip.getX(i), 3, lip.getZ(i)), new THREE.Vector3(0, -1, 0));
      const surface = raycaster.intersectObjects(targets, false)[0];
      expect(surface).toBeDefined();
      expect(lip.getY(i) - surface!.point.y).toBeCloseTo(0.017, 4);
    }
  });

  it("welds projected grille centres and seams without collapsed triangles", () => {
    const patches = car.pieces.filter((p) => p.partId === "kidney_grille");
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (const { mesh } of patches) {
      const pos = mesh.geometry.getAttribute("position");
      const index = mesh.geometry.getIndex()!;
      for (let k = 0; k < index.count; k += 3) {
        a.fromBufferAttribute(pos, index.getX(k));
        b.fromBufferAttribute(pos, index.getX(k + 1)).sub(a);
        c.fromBufferAttribute(pos, index.getX(k + 2)).sub(a);
        expect(b.cross(c).lengthSq()).toBeGreaterThan(1e-16);
      }
    }
  });
});
