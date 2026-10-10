import { describe, expect, it } from "vitest";
import { CAR_PARTS } from "../parts";
import { buildCar } from "./buildCar";

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

  it("has G60 proportions: 5.06 m long, ~1.9 m wide (without mirrors), 1.515 m high", () => {
    const body = car.pieces.filter((p) => p.kind === "paint" && p.partId !== "mirrors");
    let [minX, maxX, maxY, maxZ] = [Infinity, -Infinity, -Infinity, -Infinity];
    for (const { mesh } of body) {
      mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
      minX = Math.min(minX, b.min.x);
      maxX = Math.max(maxX, b.max.x);
      maxY = Math.max(maxY, b.max.y);
      maxZ = Math.max(maxZ, b.max.z);
    }
    expect(maxX - minX).toBeCloseTo(5.06, 1);
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
});
