import { afterAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { bottomLine, buildBodyGrid, G60, RING } from "./body";
import { buildCar } from "./buildCar";

describe("level front apron", () => {
  const grid = buildBodyGrid();
  const car = buildCar();

  afterAll(() => {
    for (const { mesh } of car.pieces) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    for (const geometry of car.sketchLines) geometry.dispose();
  });

  it("keeps the bumper underside level all the way to the nose", () => {
    for (let x = 1.96; x <= G60.frontX; x += 0.001) {
      expect(bottomLine(x)).toBeCloseTo(0.205, 8);
    }
    expect(bottomLine(G60.frontX)).toBeCloseTo(0.205, 8);
    expect(bottomLine(1.96 - 0.001)).toBeCloseTo(bottomLine(1.96), 6);
  });

  it("builds the same level edge into the rendered front body, without an upturned centre", () => {
    const heights = grid.stationX.flatMap((x, i) =>
      x >= 1.96 ? [grid.positions[i * RING * 3 + 1]!] : [],
    );
    expect(heights.length).toBeGreaterThan(10);
    for (const y of heights) expect(y).toBeCloseTo(0.205, 6);
  });

  it("retains both rounded corners and the entire central intake above the apron", () => {
    const intake = car.pieces.find((piece) => {
      if (piece.partId !== "front_bumper" || piece.kind !== "dark") return false;
      piece.mesh.geometry.computeBoundingBox();
      const bounds = piece.mesh.geometry.boundingBox!;
      return bounds.min.z < -0.5 && bounds.max.z > 0.5;
    });
    expect(intake).toBeDefined();
    const bounds = intake!.mesh.geometry.boundingBox!;
    expect(bounds.min.y).toBeCloseTo(0.295, 5);
    expect(bounds.max.y).toBeCloseTo(0.415, 5);
    expect(bounds.min.y - bottomLine(G60.frontX)).toBeGreaterThan(0.08);
    const corners = car.pieces.filter(
      (piece) => piece.partId === "front_bumper" && piece.kind === "dark" && piece !== intake,
    );
    expect(corners).toHaveLength(2);
    for (const corner of corners) {
      corner.mesh.geometry.computeBoundingBox();
      const box = corner.mesh.geometry.boundingBox!;
      expect(box.min.y).toBeCloseTo(0.329, 5);
      expect(box.max.y).toBeCloseTo(0.521, 5);
    }
  });

  it("leaves sill and rear-apron heights unchanged", () => {
    expect(bottomLine(-1)).toBeCloseTo(0.165, 6);
    expect(bottomLine(-2.42)).toBeCloseTo(0.28, 6);
    expect(bottomLine(G60.rearX)).toBeCloseTo(0.38, 6);
  });
});
