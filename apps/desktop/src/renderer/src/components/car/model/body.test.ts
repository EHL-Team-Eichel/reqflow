import { afterAll, describe, expect, it } from "vitest";
import * as THREE from "three";
import { bodyPanel, buildBodyGrid, quadAt, RING, STATIONS } from "./body";
import { buildCar } from "./buildCar";

describe("M5-inspired windscreen", () => {
  const car = buildCar();
  const glass = car.pieces.find((p) => p.partId === "windshield" && p.kind === "glass")!.mesh
    .geometry;
  const position = glass.getAttribute("position");
  const vertices = Array.from({ length: position.count }, (_, i) =>
    new THREE.Vector3().fromBufferAttribute(position, i),
  );
  const grid = buildBodyGrid();
  const panels = Array.from({ length: (STATIONS - 1) * RING }, (_, k) =>
    bodyPanel(quadAt(grid, Math.floor(k / RING), k % RING)),
  );

  afterAll(() => {
    for (const { mesh } of car.pieces) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    for (const geometry of car.sketchLines) geometry.dispose();
  });

  it("spans most of the front cabin and tapers naturally towards the roof", () => {
    const top = new THREE.Box3().setFromPoints(vertices.filter((p) => p.x < 0.05));
    const base = new THREE.Box3().setFromPoints(vertices.filter((p) => p.x > 0.65));
    const topWidth = top.getSize(new THREE.Vector3()).z;
    const baseWidth = base.getSize(new THREE.Vector3()).z;
    expect(topWidth).toBeGreaterThan(1.25);
    expect(topWidth).toBeLessThan(1.4);
    expect(baseWidth).toBeGreaterThan(1.6);
    expect(baseWidth).toBeLessThan(1.75);
    expect(baseWidth - topWidth).toBeGreaterThan(0.3);
  });

  it("covers the full front slope without swallowing the bonnet or roof", () => {
    const bounds = new THREE.Box3().setFromPoints(vertices);
    expect(bounds.min.x).toBeLessThan(-0.05);
    expect(bounds.max.x).toBeGreaterThan(0.79);
    expect(bounds.min.x).toBeGreaterThan(-0.1);
    expect(bounds.max.x).toBeLessThan(0.85);
    expect(bounds.max.y).toBeGreaterThan(1.44);
    expect(bounds.min.y).toBeLessThan(1.01);
  });

  it("bows the lower corners rearward instead of making a rectangular glass patch", () => {
    const center = Math.max(...vertices.filter((p) => Math.abs(p.z) < 0.1).map((p) => p.x));
    const corners = Math.max(...vertices.filter((p) => Math.abs(p.z) > 0.75).map((p) => p.x));
    expect(center - corners).toBeGreaterThan(0.035);
  });

  it("leaves slender, continuous A-pillars on both sides", () => {
    for (const side of [-1, 1]) {
      for (const height of [1.08, 1.2, 1.32]) {
        const sideWindow: number[] = [];
        const windscreen: number[] = [];
        for (let i = 0; i < STATIONS - 1; i++) {
          for (let j = 0; j < RING; j++) {
            const q = quadAt(grid, i, j);
            if (q.z * side < 0.55 || q.seg > 6 || Math.abs(q.y - height) > 0.015) continue;
            const panel = panels[i * RING + j];
            if (panel === "side_windows:glass") sideWindow.push(q.x);
            if (panel === "windshield:glass") windscreen.push(q.x);
          }
        }
        expect(sideWindow.length).toBeGreaterThan(0);
        expect(windscreen.length).toBeGreaterThan(0);
        const gap = Math.min(...windscreen) - Math.max(...sideWindow);
        expect(gap).toBeGreaterThan(0.06);
        expect(gap).toBeLessThan(0.16);
      }
    }
  });

  it("never joins the windscreen directly to a side window", () => {
    for (let i = 0; i < STATIONS - 1; i++) {
      for (let j = 0; j < RING; j++) {
        if (panels[i * RING + j] !== "windshield:glass") continue;
        const neighbors = [
          panels[i * RING + ((j + 1) % RING)],
          panels[i * RING + ((j + RING - 1) % RING)],
          i > 0 ? panels[(i - 1) * RING + j] : null,
          panels[(i + 1) * RING + j],
        ];
        expect(neighbors).not.toContain("side_windows:glass");
      }
    }
  });

  it("keeps the smoothed glazing symmetric", () => {
    const key = (p: THREE.Vector3) => [p.x, p.y, p.z].map((n) => Math.round(n * 10000)).join(",");
    const points = new Set(vertices.map(key));
    for (const vertex of vertices) {
      expect(points.has(key(new THREE.Vector3(vertex.x, vertex.y, -vertex.z)))).toBe(true);
    }
  });

  it("builds one connected glazing surface without folded or collapsed triangles", () => {
    const index = glass.getIndex()!;
    const neighbors = new Map<number, Set<number>>();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let k = 0; k < index.count; k += 3) {
      const ids = [index.getX(k), index.getX(k + 1), index.getX(k + 2)];
      a.copy(vertices[ids[0]!]!);
      b.copy(vertices[ids[1]!]!).sub(a);
      c.copy(vertices[ids[2]!]!).sub(a);
      const cross = b.cross(c);
      expect(cross.lengthSq()).toBeGreaterThan(1e-12);
      // The windscreen faces forwards and upwards throughout its expanded outline.
      expect(cross.x).toBeGreaterThan(0);
      expect(cross.y).toBeGreaterThan(0);
      for (const id of ids) {
        if (!neighbors.has(id)) neighbors.set(id, new Set());
        for (const other of ids) if (other !== id) neighbors.get(id)!.add(other);
      }
    }
    const seen = new Set<number>();
    const queue = [0];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...neighbors.get(id)!);
    }
    expect(seen.size).toBe(position.count);
  });
});
