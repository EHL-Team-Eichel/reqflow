import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { projectSketchLine } from "./decals";

describe("projectSketchLine", () => {
  it("breaks strokes at openings and ignores the panel on the opposite side", () => {
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    const panel = (x: number, z: number, width: number) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, 1), material);
      mesh.position.set(x, 0.5, z);
      mesh.updateMatrixWorld(true);
      return mesh;
    };
    // Two near-side panels with an arch-sized gap; a solid far-side panel behind.
    const targets = [panel(-0.75, -0.9, 0.5), panel(0.75, -0.9, 0.5), panel(0, 0.9, 2)];
    const geometry = projectSketchLine(
      targets,
      [
        [-0.95, 0.5],
        [0.95, 0.5],
      ],
      "left",
    );
    const positions = geometry.getAttribute("position");
    expect(positions.count).toBeGreaterThan(20);
    const ends: number[] = [];
    for (let i = 0; i < positions.count; i += 2) {
      const x1 = positions.getX(i);
      const x2 = positions.getX(i + 1);
      expect(Math.abs(x1)).toBeGreaterThanOrEqual(0.5);
      expect(Math.sign(x1)).toBe(Math.sign(x2));
      expect(positions.getZ(i)).toBeCloseTo(-0.903, 5);
      ends.push(x1);
    }
    expect(ends.some((x) => x < 0)).toBe(true);
    expect(ends.some((x) => x > 0)).toBe(true);
    geometry.dispose();
    for (const mesh of targets) mesh.geometry.dispose();
    material.dispose();
  });
});
