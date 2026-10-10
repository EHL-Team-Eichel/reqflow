import { describe, expect, it } from "vitest";
import { CAR_PARTS } from "../parts";
import { buildCar } from "./buildCar";
import { buildBodyGrid, G60, RING, STATIONS, topLine } from "./body";
import * as THREE from "three";

describe("buildCar", () => {
  const car = buildCar();

  it("has a clickable mesh and a badge anchor for every part in the catalog", () => {
    const modelled = new Set(car.pieces.map((p) => p.partId).filter(Boolean));
    const missing = CAR_PARTS.map((p) => p.id).filter((id) => !modelled.has(id));
    expect(missing).toEqual([]);
    for (const part of CAR_PARTS) expect(car.anchors.has(part.id)).toBe(true);
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
    for (const { mesh } of car.pieces.filter((p) => p.partId === "rear_seats")) {
      const pos = mesh.geometry.getAttribute("position");
      for (let k = 0; k < pos.count; k++) {
        vertex.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld);
        expect(vertex.y).toBeLessThan(topLine(vertex.x) - 0.03);
      }
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
