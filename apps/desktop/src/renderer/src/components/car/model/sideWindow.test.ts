import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  bodyPanel,
  buildBodyGrid,
  quadAt,
  REAR_WINDOW_SUPPORT_X,
  RING,
  STATIONS,
  type Quad,
} from "./body";
import { buildCar } from "./buildCar";

function sideQuad(x: number, y: number, side: number): Quad {
  return { i: 0, j: 0, x, y, z: side * 0.75, seg: 6, glass: 1, cut: false, nx: 0, ny: 0, nz: side };
}

describe("side window divisions", () => {
  it.each([-1, 1])("splits front, rear-door and fixed quarter glass on side %s", (side) => {
    expect(bodyPanel(sideQuad(0, 1.2, side))).toBe("side_windows:glass");
    expect(bodyPanel(sideQuad(-0.25, 1.2, side))).toBe("roof:dark");
    expect(bodyPanel(sideQuad(-0.8, 1.2, side))).toBe("side_windows:glass");
    expect(bodyPanel(sideQuad(-1.08, 1.2, side))).toBe("side_windows:glass");
    expect(bodyPanel(sideQuad(-1.17, 1.2, side))).toBe("roof:dark");
    expect(bodyPanel(sideQuad(-1.26, 1.2, side))).toBe("side_windows:glass");
  });

  it.each([1.1, 1.2, 1.3])("keeps the rear support upright like the B-pillar at y = %s", (y) => {
    expect(bodyPanel(sideQuad(-1.17, y, 1))).toBe("roof:dark");
    expect(bodyPanel(sideQuad(-1.24, y, 1))).toBe("side_windows:glass");
    expect(bodyPanel(sideQuad(-1.1, y, 1))).toBe("side_windows:glass");
  });

  it("runs the upright divider from the belt to the roof on both sides", () => {
    const grid = buildBodyGrid();
    for (const side of [-1, 1]) {
      const frame: Quad[] = [];
      for (let i = 0; i < STATIONS - 1; i++) {
        for (let j = 0; j < RING; j++) {
          const q = quadAt(grid, i, j);
          if (q.seg < 5 || q.seg > 6 || Math.sign(q.z) !== side) continue;
          if (q.x < -1.05 && q.x > -1.36 && bodyPanel(q) === "roof:dark") frame.push(q);
        }
      }
      expect(frame.length).toBeGreaterThan(10);
      expect(Math.min(...frame.map((q) => q.y))).toBeLessThan(1.14);
      expect(Math.max(...frame.map((q) => q.y))).toBeGreaterThan(1.4);
      for (const q of frame) expect(Math.abs(q.x - REAR_WINDOW_SUPPORT_X)).toBeLessThan(0.04);
    }
  });

  it("stands the rear support directly over the rear door handle", () => {
    const car = buildCar();
    const handles = car.pieces.filter((p) => p.partId === "door_handles");
    const centres = handles.map((p) => {
      p.mesh.geometry.computeBoundingBox();
      return p.mesh.geometry
        .boundingBox!.getCenter(new THREE.Vector3())
        .applyMatrix4(p.mesh.matrix);
    });
    const rear = centres.filter((c) => c.x < -0.6);
    expect(rear.length).toBeGreaterThanOrEqual(2);
    for (const c of rear) expect(Math.abs(c.x - REAR_WINDOW_SUPPORT_X)).toBeLessThan(0.02);
  });
});
