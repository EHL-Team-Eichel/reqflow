import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { acceleratePicking } from "./acceleratedPicking";

function fixture() {
  const geometry = new THREE.SphereGeometry(1, 48, 32);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  mesh.position.set(0.5, 0.3, -0.2);
  mesh.rotation.set(0.1, 0.3, 0.2);
  mesh.scale.set(1.2, 0.8, 1.1);
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe("exact spatially indexed car picking", () => {
  it.each([THREE.FrontSide, THREE.BackSide, THREE.DoubleSide])(
    "matches standard intersections, normals, UVs and original face IDs for side %s",
    (side) => {
      const mesh = fixture();
      mesh.material.side = side;
      const rays = Array.from({ length: 24 }, (_, i) => {
        const angle = (i * Math.PI) / 12;
        const origin = new THREE.Vector3(4 * Math.cos(angle), 0.6, 4 * Math.sin(angle));
        return new THREE.Raycaster(origin, mesh.position.clone().sub(origin).normalize());
      });
      const expected = rays.map((ray) => ray.intersectObject(mesh, false));
      const index = mesh.geometry.index!.array.slice();
      const positions = mesh.geometry.getAttribute("position").array.slice();
      const restore = acceleratePicking(mesh);
      rays.forEach((ray, i) => {
        const hits = ray.intersectObject(mesh, false);
        expect(hits).toHaveLength(expected[i]!.length);
        hits.forEach((hit, j) => {
          const standard = expected[i]![j]!;
          expect(hit.object).toBe(mesh);
          expect(hit.distance).toBeCloseTo(standard.distance, 8);
          expect(hit.point.distanceTo(standard.point)).toBeLessThan(1e-8);
          expect(hit.faceIndex).toBe(standard.faceIndex);
          expect(hit.face).toEqual(standard.face);
          expect(hit.uv!.distanceTo(standard.uv!)).toBeLessThan(1e-8);
          expect(hit.normal!.distanceTo(standard.normal!)).toBeLessThan(1e-8);
        });
      });
      expect(mesh.geometry.index!.array).toEqual(index);
      expect(mesh.geometry.getAttribute("position").array).toEqual(positions);
      restore();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  );

  it("honors live transforms/material sides, near/far and missed rays", () => {
    const mesh = fixture();
    const original = mesh.raycast;
    const restore = acceleratePicking(mesh);
    mesh.position.x = 2;
    mesh.updateMatrixWorld(true);
    mesh.material.side = THREE.FrontSide;
    for (const ray of [
      new THREE.Raycaster(new THREE.Vector3(2, 0.3, 4), new THREE.Vector3(0, 0, -1), 0, 10),
      new THREE.Raycaster(new THREE.Vector3(2, 0.3, 4), new THREE.Vector3(0, 0, -1), 0, 1),
      new THREE.Raycaster(new THREE.Vector3(2, 0.3, 4), new THREE.Vector3(0, 0, 1)),
    ]) {
      const standard: THREE.Intersection[] = [];
      original.call(mesh, ray, standard);
      const hits: THREE.Intersection[] = [];
      mesh.raycast(ray, hits);
      expect(hits.map((hit) => hit.distance).sort()).toEqual(
        standard.map((hit) => hit.distance).sort(),
      );
    }
    restore();
    mesh.geometry.dispose();
    mesh.material.dispose();
  });

  it("avoids scanning triangles outside the ray's spatial branch", () => {
    const mesh = fixture();
    const position = mesh.geometry.getAttribute("position");
    const getX = vi.spyOn(position, "getX");
    const ray = new THREE.Raycaster(new THREE.Vector3(0.4, 0.6, 4), new THREE.Vector3(0, 0, -1));
    ray.intersectObject(mesh, false);
    const baseline = getX.mock.calls.length;
    const restore = acceleratePicking(mesh);
    getX.mockClear();
    expect(ray.intersectObject(mesh, false).length).toBeGreaterThan(0);
    expect(getX.mock.calls.length).toBeLessThan(baseline / 4);
    getX.mockRestore();
    restore();
    mesh.geometry.dispose();
    mesh.material.dispose();
  });

  it("restores the original raycast when disposed, and cleanup is repeatable", () => {
    const mesh = fixture();
    const original = mesh.raycast;
    const restore = acceleratePicking(mesh);
    expect(mesh.raycast).not.toBe(original);
    mesh.geometry.dispose();
    expect(mesh.raycast).toBe(original);
    restore();
    restore();
    mesh.material.dispose();
  });

  it("leaves small or grouped geometry on standard picking", () => {
    const mesh = fixture();
    mesh.geometry.addGroup(0, 3, 0);
    const original = mesh.raycast;
    acceleratePicking(mesh)();
    expect(mesh.raycast).toBe(original);
    mesh.geometry.dispose();
    const small = new THREE.Mesh(new THREE.BoxGeometry(), mesh.material);
    acceleratePicking(small)();
    expect(small.raycast).toBe(original);
    small.geometry.dispose();
    mesh.material.dispose();
  });
});
