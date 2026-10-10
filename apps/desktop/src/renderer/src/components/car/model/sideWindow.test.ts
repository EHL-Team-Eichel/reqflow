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
    expect(bodyPanel(sideQuad(-1.218, 1.2, side))).toBe("roof:dark");
    expect(bodyPanel(sideQuad(-1.3, 1.2, side))).toBe("side_windows:glass");
  });

  it.each([1.1, 1.2, 1.3])("keeps the rear support upright like the B-pillar at y = %s", (y) => {
    expect(bodyPanel(sideQuad(-1.218, y, 1))).toBe("roof:dark");
    expect(bodyPanel(sideQuad(-1.29, y, 1))).toBe("side_windows:glass");
    expect(bodyPanel(sideQuad(-1.14, y, 1))).toBe("side_windows:glass");
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

  it("stands the rear support over the rear half of the rear door handle", () => {
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
    for (const c of rear) {
      expect(REAR_WINDOW_SUPPORT_X).toBeLessThan(c.x);
      // The handle is 15 cm long: the support stays within its rear half.
      expect(c.x - REAR_WINDOW_SUPPORT_X).toBeLessThan(0.075);
    }
  });

  it("keeps the fixed quarter pane 15% smaller than with the support centred on the handle", () => {
    // Side-view area of the right quarter glass in the rendered mesh. With the support centred on
    // the handle (x = -1.17) it was 0.1059 m².
    const car = buildCar();
    const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    let area = 0;
    for (const p of car.pieces) {
      if (p.partId !== "side_windows" || p.kind !== "glass") continue;
      const geo = p.mesh.geometry;
      const pos = (geo.index ? geo.toNonIndexed() : geo).getAttribute("position");
      for (let t = 0; t < pos.count; t += 3) {
        a.fromBufferAttribute(pos, t).applyMatrix4(p.mesh.matrixWorld);
        b.fromBufferAttribute(pos, t + 1).applyMatrix4(p.mesh.matrixWorld);
        c.fromBufferAttribute(pos, t + 2).applyMatrix4(p.mesh.matrixWorld);
        const x = (a.x + b.x + c.x) / 3;
        if ((a.z + b.z + c.z) / 3 < 0 || x > -1.19 || x < -1.9) continue;
        area += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
      }
    }
    expect(area / 0.1059).toBeGreaterThan(0.84);
    expect(area / 0.1059).toBeLessThan(0.86);
  });
});
