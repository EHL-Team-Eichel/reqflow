import * as THREE from "three";

/**
 * Details laid onto the body (grille, lights, handles, charge flap): a flat 2D shape, sampled as a
 * grid and projected onto the body along one axis, then lifted off the paint by a few millimetres.
 * The shape stays clean whatever the body's tessellation looks like underneath.
 */

/** Which way the shape is projected: from the front (−x), rear (+x), left (+z) or right (−z). */
export type View = "front" | "rear" | "left" | "right";

/** Maps grid coordinates (u, v ∈ [0, 1]) to plane coordinates (a, b). */
export type Shape2D = (u: number, v: number) => [number, number];

/** Plane coordinates: front and rear views see (z, y), the sides see (x, y). */
const toPlane = (view: View, p: THREE.Vector3): [number, number] =>
  view === "front" || view === "rear" ? [p.z, p.y] : [p.x, p.y];

function ray(view: View, a: number, b: number): { origin: THREE.Vector3; dir: THREE.Vector3 } {
  switch (view) {
    case "front":
      return { origin: new THREE.Vector3(4, b, a), dir: new THREE.Vector3(-1, 0, 0) };
    case "rear":
      return { origin: new THREE.Vector3(-4, b, a), dir: new THREE.Vector3(1, 0, 0) };
    case "left":
      return { origin: new THREE.Vector3(a, b, -3), dir: new THREE.Vector3(0, 0, 1) };
    case "right":
      return { origin: new THREE.Vector3(a, b, 3), dir: new THREE.Vector3(0, 0, -1) };
  }
}

/** Superellipse (rounded rectangle for p ≈ 4–6), as a polar grid from radius r0 to r1. */
export function superellipse(
  ca: number,
  cb: number,
  ra: number,
  rb: number,
  p: number,
  r0 = 0,
  r1 = 1,
): Shape2D {
  return (u, v) => {
    const t = u * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const rho = r0 + (r1 - r0) * v;
    return [
      ca + ra * rho * Math.sign(c) * Math.abs(c) ** (2 / p),
      cb + rb * rho * Math.sign(s) * Math.abs(s) ** (2 / p),
    ];
  };
}

/** A band from a0 to a1, between a bottom and a top edge that may change along it. */
export function band(
  a0: number,
  a1: number,
  bottom: (u: number) => number,
  top: (u: number) => number,
): Shape2D {
  return (u, v) => [a0 + (a1 - a0) * u, bottom(u) + (top(u) - bottom(u)) * v];
}

/** The triangles of `meshes` that can lie under the shape, as one mesh to cast rays at. */
function cropTargets(meshes: THREE.Mesh[], view: View, bounds: THREE.Box2): THREE.Mesh {
  const out: number[] = [];
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const tri = new THREE.Box2();
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute("position");
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    for (let k = 0; k < count; k += 3) {
      tri.makeEmpty();
      for (let n = 0; n < 3; n++) {
        const id = index ? index.getX(k + n) : k + n;
        v[n]!.fromBufferAttribute(pos, id).applyMatrix4(mesh.matrixWorld);
        const [a, b] = toPlane(view, v[n]!);
        tri.expandByPoint(new THREE.Vector2(a, b));
      }
      if (!tri.intersectsBox(bounds)) continue;
      for (const p of v) out.push(p.x, p.y, p.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(out, 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
}

/**
 * Projects `shape` onto `targets`. Grid points that miss the body are dropped with their
 * triangles. Returns null when nothing landed.
 */
export function projectPatch(
  targets: THREE.Mesh[],
  shape: Shape2D,
  uSeg: number,
  vSeg: number,
  view: View,
  lift = 0.004,
): THREE.BufferGeometry | null {
  const plane: [number, number][] = [];
  const bounds = new THREE.Box2();
  for (let i = 0; i <= uSeg; i++) {
    for (let j = 0; j <= vSeg; j++) {
      const ab = shape(i / uSeg, j / vSeg);
      plane.push(ab);
      bounds.expandByPoint(new THREE.Vector2(ab[0], ab[1]));
    }
  }
  bounds.expandByScalar(0.05);
  const target = cropTargets(targets, view, bounds);
  const raycaster = new THREE.Raycaster();
  const points: (THREE.Vector3 | null)[] = plane.map(([a, b]) => {
    const { origin, dir } = ray(view, a, b);
    raycaster.set(origin, dir);
    const hit = raycaster.intersectObject(target, false)[0];
    if (!hit?.face) return null;
    const n = hit.face.normal.clone();
    if (n.dot(dir) > 0) n.negate();
    return hit.point.clone().addScaledVector(n, lift);
  });
  target.geometry.dispose();
  (target.material as THREE.Material).dispose();

  const positions: number[] = [];
  const index: number[] = [];
  const ids = new Map<number, number>();
  const idOf = (k: number) => {
    let id = ids.get(k);
    if (id === undefined) {
      const p = points[k]!;
      id = positions.length / 3;
      positions.push(p.x, p.y, p.z);
      ids.set(k, id);
    }
    return id;
  };
  const at = (i: number, j: number) => i * (vSeg + 1) + j;
  for (let i = 0; i < uSeg; i++) {
    for (let j = 0; j < vSeg; j++) {
      const quad = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (quad.some((k) => !points[k])) continue;
      const [a, b, c, d] = quad.map(idOf) as [number, number, number, number];
      index.push(a, b, c, a, c, d);
    }
  }
  if (index.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}
