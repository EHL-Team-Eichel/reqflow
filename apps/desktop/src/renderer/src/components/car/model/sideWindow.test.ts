import { describe, expect, it } from "vitest";
import { bodyPanel, buildBodyGrid, quadAt, RING, STATIONS, type Quad } from "./body";

function sideQuad(x: number, y: number, side: number): Quad {
  return { i: 0, j: 0, x, y, z: side * 0.75, seg: 6, glass: 1, cut: false, nx: 0, ny: 0, nz: side };
}

describe("side window divisions", () => {
  it.each([-1, 1])("splits front, rear-door and fixed quarter glass on side %s", (side) => {
    expect(bodyPanel(sideQuad(0, 1.2, side))).toBe("side_windows:glass");
    expect(bodyPanel(sideQuad(-0.25, 1.2, side))).toBe("roof:dark");
    expect(bodyPanel(sideQuad(-0.8, 1.2, side))).toBe("side_windows:glass");
    expect(bodyPanel(sideQuad(-1.244, 1.2, side))).toBe("roof:dark");
    expect(bodyPanel(sideQuad(-1.45, 1.2, side))).toBe("side_windows:glass");
  });

  it("keeps the slanted divider from the belt to the roof on both sides", () => {
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
    }
  });
});
