import { describe, expect, it } from "vitest";
import {
  bodyPanel,
  buildBodyGrid,
  panelGeometries,
  quadAt,
  RING,
  smoothPanelEdges,
  STATIONS,
  type Quad,
} from "./body";

describe("windscreen and pillars", () => {
  const quad = (x: number, y: number, z: number, seg: number): Quad => ({
    i: 0,
    j: 0,
    x,
    y,
    z,
    seg,
    glass: 1,
    cut: false,
    nx: 0,
    ny: 0,
    nz: 1,
  });

  it("extends the glass into the front cowl while retaining the bonnet shoulders", () => {
    expect(bodyPanel(quad(0.95, 0.99, 0.2, 8))).toBe("windshield:glass");
    expect(bodyPanel(quad(0.95, 1.0, 0.7, 7))).toBe("hood");
    expect(bodyPanel(quad(1.02, 1.02, 0.2, 8))).toBe("hood");
    expect(bodyPanel(quad(-0.02, 1.47, 0.62, 7))).toBe("windshield:glass");
  });

  it("slims A, B and C pillars and keeps a solid centre support on both sides", () => {
    for (const side of [-1, 1]) {
      const z = side * 0.82;
      expect(bodyPanel(quad(0.37, 1.18, z, 5))).toBe("side_windows:glass");
      expect(bodyPanel(quad(0.43, 1.18, z, 5))).toBe("roof");
      for (const x of [-0.3, -0.2])
        expect(bodyPanel(quad(x, 1.18, z, 5))).toBe("side_windows:glass");
      expect(bodyPanel(quad(-0.25, 1.18, z, 5))).toBe("roof:dark");
      expect(bodyPanel(quad(-1.62, 1.18, z, 5))).toBe("side_windows:glass");
      expect(bodyPanel(quad(-1.68, 1.18, z, 5))).toBe("roof");
    }
  });

  it("builds wider glass with a shared, continuous seam against the bonnet", () => {
    const grid = buildBodyGrid();
    const keys = Array.from({ length: (STATIONS - 1) * RING }, (_, k) =>
      bodyPanel(quadAt(grid, Math.floor(k / RING), k % RING)),
    );
    const assign = (q: Quad) => keys[q.i * RING + q.j]!;
    smoothPanelEdges(grid, assign);
    const panels = panelGeometries(grid, assign);
    const glass = panels.get("windshield:glass")!;
    expect(glass.boundingBox!.max.x).toBeGreaterThan(0.94);
    expect(glass.boundingBox!.min.x).toBeLessThan(0);
    expect(glass.boundingBox!.max.z - glass.boundingBox!.min.z).toBeGreaterThan(1.24);
    const positions = glass.getAttribute("position");
    const hood = panels.get("hood")!.getAttribute("position");
    const vertexKey = (p: typeof positions, i: number) =>
      [p.getX(i), p.getY(i), p.getZ(i)].join(",");
    const hoodVertices = new Set(Array.from({ length: hood.count }, (_, i) => vertexKey(hood, i)));
    const front = Array.from({ length: positions.count }, (_, i) => i).filter(
      (i) => positions.getX(i) > 0.94,
    );
    expect(front.length).toBeGreaterThan(10);
    expect(front.filter((i) => hoodVertices.has(vertexKey(positions, i))).length).toBeGreaterThan(
      10,
    );
    for (const geometry of panels.values()) geometry.dispose();
  });
});
