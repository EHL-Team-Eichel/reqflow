import { describe, expect, it } from "vitest";
import { bodyPanel, buildBodyGrid, quadAt, RING, STATIONS, topLine, type Quad } from "./body";
import { buildCar } from "./buildCar";

function rearQuad(x: number, z: number): Quad {
  return {
    i: 0,
    j: 0,
    x,
    y: topLine(x) - 0.01,
    z,
    seg: 8,
    glass: 1,
    cut: false,
    nx: 0,
    ny: 1,
    nz: 0,
  };
}

describe("rear window supports", () => {
  it("retains a painted lower frame before the trunk instead of glazing the rear deck", () => {
    for (const x of [-1.83, -1.9, -1.96])
      for (const z of [-0.5, 0, 0.5]) expect(bodyPanel(rearQuad(x, z))).toBe("roof");
    expect(bodyPanel(rearQuad(-2.05, 0))).toBe("trunk_lid");
  });

  it("leaves mirrored C-pillar shoulders around a tapered, usable rear window", () => {
    for (const side of [-1, 1]) {
      expect(bodyPanel(rearQuad(-1.32, side * 0.55))).toBe("roof");
      expect(bodyPanel(rearQuad(-1.32, side * 0.45))).toBe("rear_window:glass");
      expect(bodyPanel(rearQuad(-1.72, side * 0.55))).toBe("rear_window:glass");
      expect(bodyPanel(rearQuad(-1.72, side * 0.64))).toBe("roof");
    }
  });

  it("keeps actual body quads across the full-width lower support", () => {
    const grid = buildBodyGrid();
    const support: Quad[] = [];
    for (let i = 0; i < STATIONS - 1; i++) {
      for (let j = 0; j < RING; j++) {
        const q = quadAt(grid, i, j);
        if (q.seg >= 7 && q.x < -1.84 && q.x > -1.94 && Math.abs(q.z) < 0.6) support.push(q);
      }
    }
    expect(support.length).toBeGreaterThan(20);
    expect(support.every((q) => bodyPanel(q) === "roof")).toBe(true);
    expect(support.some((q) => q.z < -0.4)).toBe(true);
    expect(support.some((q) => q.z > 0.4)).toBe(true);
  });

  it("preserves selectable rear glass, roof and trunk on the exterior model", () => {
    const car = buildCar();
    for (const id of ["rear_window", "roof", "trunk_lid"])
      expect(car.pieces.some((p) => p.partId === id && p.layer === "exterior")).toBe(true);
    const glass = car.pieces.find((p) => p.partId === "rear_window" && p.kind === "glass")!;
    glass.mesh.geometry.computeBoundingBox();
    // Edge smoothing may soften the nominal cut by a few centimetres.
    expect(glass.mesh.geometry.boundingBox!.min.x).toBeGreaterThan(-1.86);
  });
});
